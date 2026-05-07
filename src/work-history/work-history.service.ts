import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, IsNull, Not } from 'typeorm';
import { CreateWorkHistoryDto } from './dto/create-work-history.dto';
import { UpdateWorkHistoryDto } from './dto/update-work-history.dto';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { User } from 'src/users/entities/user.entity';
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { handleException } from 'src/util/handleException';
import { WorkStatus } from 'src/work-status/entities/work-status.entity';
import { Role } from 'src/roles/entities/role.entity';
import { GovernmentAgency } from 'src/government-agencies/entities/government-agency.entity';
import { Position } from 'src/positions/entities/position.entity';
import { WebsocketService } from 'src/websocket/websocket/websocket.service';
import { AnnouncementsService } from 'src/announcements/announcements.service';
import { AnnouncementStatus, NotificationType } from 'src/announcements/entities/announcement.entity';
import { In } from 'typeorm';
import { UsersService } from 'src/users/users.service';
import { maskEmail } from 'src/notifications/email/utils/mask-email.util';

@Injectable()
export class WorkHistoryService {
  private readonly logger = new Logger(WorkHistoryService.name);

  constructor(
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepository: Repository<WorkHistory>,

    @InjectRepository(Amphoe)
    private readonly amphoeRepository: Repository<Amphoe>,

    @InjectRepository(LocalAdministrativeOrganization)
    private readonly laoRepository: Repository<LocalAdministrativeOrganization>,

    @InjectRepository(User)
    private readonly userRepository: Repository<User>,

    @InjectRepository(WorkStatus)
    private readonly workStatusRepository: Repository<WorkStatus>,

    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,

    @InjectRepository(GovernmentAgency)
    private readonly governmentAgencyRepository: Repository<GovernmentAgency>,

    @InjectRepository(Position)
    private readonly positionRepository: Repository<Position>,

    private readonly webSocketService: WebsocketService,
    private readonly announcementsService: AnnouncementsService,
    private readonly usersService: UsersService,
    private readonly dataSource: DataSource,
  ) { }

  /**
   * BE-01 P0 — translate Postgres unique-violation (23505) on the
   * `uk_work_history_one_current_per_user` partial unique index (DB-01 P0
   * migration) into the canonical `409 WORK_HISTORY_RACE` error. Two
   * concurrent admin PATCHes against the same user lose at the DB level;
   * the loser surfaces this 409 to the client which retries.
   *
   * Index name match is best-effort — if the index is renamed, callers
   * still see a generic 23505 surfaced as 409. The error code (`23505`)
   * is the load-bearing contract.
   */
  private isWorkHistoryRaceConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const code = (error as { code?: string }).code;
    return code === '23505';
  }

  /**
   * W100 PR1 — Mask `WorkHistory.user` PII for admin list / lookup
   * surfaces. Decrypts via `UsersService.decryptUserPii` (idempotent +
   * ciphertext-shape-guarded post-W89B) and then applies `maskEmail`.
   * `phone` and `citizenId` are nulled per user-confirmed default #5
   * for admin lists. See docs/tasks/wave100/W100-PLAN-PII-DECRYPT-AUDIT.md.
   */
  private async maskUsersOnWorkHistories(rows: WorkHistory[]): Promise<void> {
    for (const wh of rows) {
      if (!wh?.user) continue;
      await this.usersService.decryptUserPii(wh.user);
      wh.user.email = wh.user.email ? maskEmail(wh.user.email) : null as unknown as string;
      wh.user.phone = null as unknown as string;
      wh.user.citizenId = null as unknown as string;
    }
  }

  async create(
    dto: CreateWorkHistoryDto,
    creatorId: string,
  ): Promise<WorkHistory> {
    try {
      const {
        amphoeId,
        localAdministrativeOrganizationId,
        userId,
        workStatusId,
        roleId,
        governmentAgenciesId,
      } = dto;

      const creator = await this.userRepository.findOne({
        where: { id: creatorId },
      });
      if (!creator) throw new NotFoundException('Creator not found');

      const amphoe = await this.amphoeRepository.findOneBy({ id: amphoeId });
      if (!amphoe) throw new NotFoundException('Amphoe not found');

      const lao = await this.laoRepository.findOneBy({
        id: localAdministrativeOrganizationId,
      });
      if (!lao)
        throw new NotFoundException(
          'Local Administrative Organization not found',
        );

      const user = await this.userRepository.findOneBy({ id: userId });
      if (!user) throw new NotFoundException('User not found');

      // Resolve workStatus by id, fallback to default name 'pending'
      let workStatus: WorkStatus | null = null;
      if (workStatusId) {
        workStatus = await this.workStatusRepository.findOneBy({ id: workStatusId });
      } else {
        workStatus = await this.workStatusRepository.findOneBy({ name: 'pending' });
      }
      if (!workStatus) throw new NotFoundException('Work status not found');

      // Resolve role by id, fallback to default name 'user'
      let role: Role | null = null;
      if (roleId) {
        role = await this.roleRepository.findOneBy({ id: roleId });
      } else {
        role = await this.roleRepository.findOneBy({ name: 'user' });
      }
      if (!role) throw new NotFoundException('Role not found');

      const workHistory = new WorkHistory();
      workHistory.amphoe = amphoe;
      workHistory.localAdministrativeOrganization = lao;
      workHistory.user = user;
      workHistory.workStatus = workStatus;
      workHistory.role = role;
      workHistory.createdBy = creator;

      if (governmentAgenciesId) {
        const govAgency = await this.governmentAgencyRepository.findOneBy({
          id: governmentAgenciesId,
        });
        if (!govAgency)
          throw new NotFoundException('Government agency not found');
        workHistory.governmentAgencies = govAgency;
      }

      // ตั้งค่า isCurrent = true สำหรับ workHistory ใหม่
      workHistory.isCurrent = true;

      // BE-01 P0-2 — wrap the flip-prior + insert-new step in a single
      // transaction so concurrent calls cannot leave the user with two
      // `isCurrent=true` rows. Defense-in-depth on top of the DB-01 P0
      // partial unique index. If two callers race past the flip and both
      // attempt to insert, the partial unique index rejects the second
      // with 23505 → translated to 409 WORK_HISTORY_RACE below.
      let savedWorkHistory: WorkHistory;
      try {
        savedWorkHistory = await this.dataSource.transaction(async (manager) => {
          await manager.update(
            WorkHistory,
            { user: { id: userId }, isCurrent: true },
            { isCurrent: false },
          );
          return await manager.save(WorkHistory, workHistory);
        });
      } catch (error) {
        if (this.isWorkHistoryRaceConflict(error)) {
          throw new ConflictException('WORK_HISTORY_RACE');
        }
        throw error;
      }

      // ถ้าสถานะเป็น pending ให้ส่งการแจ้งเตือนไปยัง staff และ admin
      if (workStatus.name === 'pending') {
        try {
          const adminRoles = await this.roleRepository.find({
            where: { name: In(['staff', 'admin']) }
          });
          const roleIds = adminRoles.map(r => r.id);

          if (roleIds.length > 0) {
            await this.announcementsService.create({
              title: `ผู้ใช้ใหม่ ${user.firstname} ${user.lastname} รอการอนุมัติ`,
              description: `ผู้ใช้: ${user.firstname} ${user.lastname} จาก ${lao.name} ได้ลงทะเบียนเข้าสู่ระบบและรอการตรวจสอบสิทธิ์`,
              type: NotificationType.USER,
              status: AnnouncementStatus.PUBLISHED,
              roleIds: roleIds
            }, creatorId);
            this.logger.log(`Created new registration announcement for user ${user.id}`);
          }
        } catch (announcementError) {
          this.logger.error(`Failed to create registration announcement: ${announcementError.message}`, announcementError.stack);
          // ไม่ต้อง throw error ต่ะ เพราะต้องการให้การสร้าง workHistory สำเร็จ
        }
      }

      return savedWorkHistory;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll(
    workStatusName?: string,
    roleName?: string,
  ): Promise<WorkHistory[]> {
    try {
      const query = this.workHistoryRepository
        .createQueryBuilder('work_history')
        .leftJoinAndSelect('work_history.user', 'user')
        .leftJoinAndSelect('work_history.amphoe', 'amphoe')
        .leftJoinAndSelect(
          'work_history.localAdministrativeOrganization',
          'lao',
        )
        .leftJoinAndSelect(
          'work_history.workHistoryResponsibleAmphoe',
          'responsibilities',
        )
        .leftJoinAndSelect(
          'work_history.workHistoryResponsibleGovernmentAgency',
          'governmentAgenciesResponsibilities',
        )
        .leftJoinAndSelect('work_history.role', 'role')
        .leftJoinAndSelect('work_history.createdBy', 'createdBy')
        .leftJoinAndSelect('work_history.updatedBy', 'updatedBy')
        .leftJoinAndSelect('work_history.workStatus', 'workStatus')
        .leftJoinAndSelect(
          'work_history.governmentAgencies',
          'governmentAgencies',
        )
        .leftJoinAndSelect('responsibilities.amphoe', 'respAmphoe')
        .leftJoinAndSelect('governmentAgenciesResponsibilities.governmentAgency', 'respGovernmentAgency')
        .where('work_history.isCurrent = :isCurrent', { isCurrent: true });
      if (workStatusName)
        query.andWhere('workStatus.name = :workStatusName', { workStatusName });
      if (roleName) query.andWhere('role.name = :roleName', { roleName });

      const rows = await query.getMany();
      // W100 PR1 — admin user-management list. Default #3 (mask).
      await this.maskUsersOnWorkHistories(rows);
      return rows;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findPendingWorkHistory(): Promise<number> {
    try {
      const count = await this.workHistoryRepository.count({
        where: { workStatus: { name: 'pending' }, isCurrent: true },
      });
      return count || 0;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Trigger ให้ backend ส่ง notification ไปหา role "staff"
   * ว่ามี user รออนุมัติอยู่ โดยรับ userId จาก frontend
   */
  // async notifyStaffPending(userId: string) {
  //   try {
  //     // ดึงข้อมูล user สำหรับใช้แสดงผลใน notification
  //     const user = await this.userRepository.findOne({
  //       where: { id: userId },
  //     });

  //     if (!user) {
  //       throw new NotFoundException(`User with ID ${userId} not found`);
  //     }

  //     // นับจำนวน work history ที่สถานะ pending ทั้งหมด
  //     const pendingCount = await this.workHistoryRepository.count({
  //       where: { workStatus: { name: 'pending' } },
  //     });

  //     // ดึงข้อมูล roles: staff และ admin เพื่อส่งประกาศ
  //     const adminRoles = await this.roleRepository.find({
  //       where: { name: In(['staff', 'admin']) }
  //     });
  //     const roleIds = adminRoles.map(r => r.id);

  //     if (roleIds.length > 0) {
  //       // สร้าง Announcement ประเภท SYSTEM แทนการส่ง WebSocket เปล่าๆ
  //       // เพื่อให้ข้อมูลถูกบันทึกลงฐานข้อมูลและ Inbox ของ Staff/Admin
  //       await this.announcementsService.create({
  //         title: 'แจ้งเตือน: ตรวจสอบการอนุมัติผู้ใช้งาน',
  //         description: `ต้องการการตรวจสอบ: ผู้ใช้ ${user.firstname} ${user.lastname} (ปัจจุบันมีรายการรออนุมัติทั้งหมด ${pendingCount} รายการ)`,
  //         type: NotificationType.USER,
  //         status: AnnouncementStatus.PUBLISHED,
  //         roleIds: roleIds
  //       }, userId);

  //       this.logger.log(`Created management nudge announcement for user ${userId}`);
  //     }

  //     return true;
  //   } catch (error) {
  //     handleException(this.logger, error);
  //   }
  // }

  async findAllByGovernmentAgencyId(id: string, role: string): Promise<WorkHistory[]> {
    try {
      const rows = await this.workHistoryRepository.find({
        where: { governmentAgencies: { id }, role: { name: role }, workStatus: { name: 'approved' } },
        relations: [
          'user',
          // 'amphoe',
          // 'localAdministrativeOrganization',
          // 'workStatus',
          // 'role',
        ]
      });
      // W100 PR1 — agency staff lookup (admin/assignment UI). Default #3 (mask).
      await this.maskUsersOnWorkHistories(rows);
      return rows;
    } catch (error) {
      handleException(this.logger, error);
    }
  }
  async findAllByLocalAdministrativeOrganizationId(id: string, role: string): Promise<WorkHistory[]> {
    try {
      const rows = await this.workHistoryRepository.find({
        where: { localAdministrativeOrganization: { id: id }, role: { name: role }, workStatus: { name: 'approved' } },
        relations: [
          'user',
          // 'amphoe',
          // 'localAdministrativeOrganization',
          //   'workStatus',
          //   'role',
        ]
      });
      // W100 PR1 — LAO staff lookup (admin/assignment UI). Default #3 (mask).
      await this.maskUsersOnWorkHistories(rows);
      return rows;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<WorkHistory> {
    try {
      const workHistory = await this.workHistoryRepository.findOne({
        where: { id },
        relations: [
          'user',
          'amphoe',
          'localAdministrativeOrganization',
          'workStatus',
          'role',
          'createdBy',
          'updatedBy',
          'governmentAgencies',
          'workHistoryResponsibleAmphoe',
          'workHistoryResponsibleAmphoe.amphoe',
          'workHistoryResponsibleGovernmentAgency',
          'workHistoryResponsibleGovernmentAgency.governmentAgency',

        ],
      });
      if (!workHistory) {
        throw new NotFoundException(`Work history with ID ${id} not found`);
      }
      // W100 PR1 — Detail / profile slide. Pattern 1 (decrypt): caller is
      // viewing a single record they are already authorized to see.
      if (workHistory.user) {
        await this.usersService.decryptUserPii(workHistory.user);
      }
      return workHistory;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * BE-01 P0-1 — Append-only WorkHistory mutation.
   *
   * Replaces the legacy in-place mutation (which violated CLAUDE.md §4
   * snapshot semantics). Every "edit" now:
   *
   *   1. Loads the row the admin clicked "edit" on (the head-of-lineage).
   *   2. Validates it is `isCurrent=true` (cannot append from a historical
   *      row); rejects 409 `WORK_HISTORY_NOT_CURRENT` otherwise.
   *   3. Resolves all incoming FKs (amphoe / LAO / workStatus / role /
   *      governmentAgencies) — fields not supplied carry over from the
   *      prior row.
   *   4. In a single transaction:
   *      - flips the prior current row to `isCurrent = false`
   *      - inserts a brand-new row with the merged fields,
   *        `createdBy = prior row's createdBy` (preserve original creator),
   *        `updatedBy = the admin performing the change`,
   *        `isCurrent = true`
   *   5. Returns the new row.
   *
   * No field on a `work_history` row is ever mutated post-insertion. All
   * inbound FKs (`project_groups.created_by`, etc.) continue to point at
   * the original snapshot row, exactly as §4 requires.
   *
   * Race-safety: the DB-01 P0 partial unique index
   * (`uk_work_history_one_current_per_user`) catches concurrent appends
   * with `23505` which we translate to `409 WORK_HISTORY_RACE`.
   */
  async update(
    id: string,
    dto: UpdateWorkHistoryDto,
    updateId: string,
  ): Promise<WorkHistory> {
    try {
      const {
        amphoeId,
        localAdministrativeOrganizationId,
        workStatusId,
        roleId,
        governmentAgenciesId,
      } = dto;

      const updator = await this.userRepository.findOne({
        where: { id: updateId },
      });
      if (!updator) throw new NotFoundException('creator id not found');

      const priorRow = await this.workHistoryRepository.findOne({
        where: { id },
        relations: [
          'workStatus',
          'user',
          'role',
          'amphoe',
          'localAdministrativeOrganization',
          'governmentAgencies',
          'createdBy',
        ],
      });
      if (!priorRow) throw new NotFoundException('Work history not found');

      if (!priorRow.user) {
        throw new NotFoundException('User not found in work history');
      }

      // Append from head-of-lineage only. Editing a historical row would
      // create a fork in the lineage and break "exactly one current row
      // per user" — reject explicitly.
      if (!priorRow.isCurrent) {
        throw new ConflictException('WORK_HISTORY_NOT_CURRENT');
      }

      // Store previous role/workStatus for the WebSocket notify decision.
      const previousRole = priorRow.role?.name;
      const previousWorkStatus = priorRow.workStatus?.name;

      // Resolve FKs. Fields not supplied carry over from prior row.
      const amphoe = amphoeId
        ? await this.amphoeRepository.findOneBy({ id: amphoeId })
        : priorRow.amphoe;
      if (!amphoe) throw new NotFoundException('Amphoe not found');

      const lao = localAdministrativeOrganizationId
        ? await this.laoRepository.findOneBy({
            id: localAdministrativeOrganizationId,
          })
        : priorRow.localAdministrativeOrganization;
      if (!lao)
        throw new NotFoundException(
          'Local Administrative Organization not found',
        );

      let workStatus = priorRow.workStatus;
      if (workStatusId) {
        const found = await this.workStatusRepository.findOneBy({
          id: workStatusId,
        });
        if (!found) throw new NotFoundException('Work status not found');
        workStatus = found;
      }
      if (!workStatus) {
        throw new NotFoundException('Work status is required but not found');
      }

      let role = priorRow.role;
      if (roleId) {
        const foundRole = await this.roleRepository.findOneBy({ id: roleId });
        if (!foundRole) throw new NotFoundException('Role not found');
        role = foundRole;
      }
      if (!role) {
        throw new NotFoundException('Role is required but not found');
      }

      // Resolve governmentAgencies based on amphoe/LAO classification rule.
      // - If classification resolves to NOT-agency, force null (consistent
      //   with prior in-place behavior).
      // - Otherwise, use incoming governmentAgenciesId if supplied, else
      //   carry over from prior row.
      const effectiveAmphoeId = amphoe.id;
      const effectiveLaoId = lao.id;
      const isAgencyContext =
        effectiveAmphoeId === '3001' && effectiveLaoId === '3001027';

      let governmentAgencies = priorRow.governmentAgencies ?? null;
      if (!isAgencyContext) {
        governmentAgencies = null;
      } else if (governmentAgenciesId) {
        const govAgency = await this.governmentAgencyRepository.findOneBy({
          id: governmentAgenciesId,
        });
        if (!govAgency)
          throw new NotFoundException('Government agency not found');
        governmentAgencies = govAgency;
      }

      // Build the NEW row. Append-only semantics: never mutate priorRow.
      const newRow = new WorkHistory();
      newRow.user = priorRow.user;
      newRow.amphoe = amphoe;
      newRow.localAdministrativeOrganization = lao;
      newRow.workStatus = workStatus;
      newRow.role = role;
      newRow.governmentAgencies = governmentAgencies;
      // Preserve the original creator across appends (§4 snapshot intent).
      newRow.createdBy = priorRow.createdBy;
      // updatedBy = the admin performing this append.
      newRow.updatedBy = updator;
      newRow.isCurrent = true;

      let savedNewRow: WorkHistory;
      try {
        savedNewRow = await this.dataSource.transaction(async (manager) => {
          // Flip ALL current rows for this user (defensive: should be only
          // one, but the partial unique index makes this idempotent).
          await manager.update(
            WorkHistory,
            { user: { id: priorRow.user.id }, isCurrent: true },
            { isCurrent: false },
          );
          return await manager.save(WorkHistory, newRow);
        });
      } catch (error) {
        if (this.isWorkHistoryRaceConflict(error)) {
          throw new ConflictException('WORK_HISTORY_RACE');
        }
        throw error;
      }

      // Reload with full relations so the response shape matches what FE
      // expects (the existing handler hydrates `selectedUser` from the
      // response body).
      const reloaded = await this.workHistoryRepository.findOne({
        where: { id: savedNewRow.id },
        relations: [
          'user',
          'amphoe',
          'localAdministrativeOrganization',
          'workStatus',
          'role',
          'createdBy',
          'updatedBy',
          'governmentAgencies',
          'workHistoryResponsibleAmphoe',
          'workHistoryResponsibleAmphoe.amphoe',
          'workHistoryResponsibleGovernmentAgency',
          'workHistoryResponsibleGovernmentAgency.governmentAgency',
        ],
      });

      const result = reloaded ?? savedNewRow;

      if (
        previousWorkStatus !== workStatus?.name ||
        previousRole !== role?.name
      ) {
        try {
          this.logger.log(
            `Sending work status update notification to user ${priorRow.user.id}: ${workStatus?.name}`,
            await this.webSocketService.notifyWorkStatusUpdate({
              userId: priorRow.user.id,
              workStatus: workStatus?.name || 'unknown',
              workHistoryId: result.id,
              previousWorkStatus,
              previousRole,
              updatedBy: updator.id,
              role: role?.name || 'unknown',
              timestamp: new Date(),
            }),
          );

          if (
            previousWorkStatus !== workStatus?.name &&
            previousRole !== role?.name
          ) {
            this.logger.log(
              `Work status and role updated for user ${priorRow.user.id}: status ${previousWorkStatus} → ${workStatus?.name}, role ${previousRole} → ${role?.name}`,
            );
          } else if (previousWorkStatus !== workStatus?.name) {
            this.logger.log(
              `Work status updated from ${previousWorkStatus} to ${workStatus?.name} for user ${priorRow.user.id}`,
            );
          } else if (previousRole !== role?.name) {
            this.logger.log(
              `Role updated from ${previousRole} to ${role?.name} for user ${priorRow.user.id}`,
            );
          }
        } catch (notificationError) {
          this.logger.error(
            `Failed to send work status update notification: ${notificationError.message}`,
            notificationError.stack,
          );
          // Don't fail the main operation if notification fails.
        }
      }

      return result;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.workHistoryRepository.delete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`Work history with ID ${id} not found`);
      }
      return {
        message: `Work history with ID ${id} has been permanently deleted`,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async softRemove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.workHistoryRepository.softDelete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`Work history with ID ${id} not found`);
      }
      return { message: `Work history with ID ${id} has been soft-removed.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * BE-01 P0-3 / SEC-01 S4b — Restore a soft-deleted WorkHistory row
   * without producing two `isCurrent=true` rows for the same user.
   *
   * If another non-deleted row for the same user is already current, the
   * restored row is silently demoted to `isCurrent=false` so the admin
   * may explicitly re-promote it via a normal append. This avoids a
   * 409 mid-restore (rejected per SEC-01 §3 S4b — bad UX) and avoids
   * tripping the DB-01 P0 partial unique index.
   *
   * The restore + demote are wrapped in a single transaction so a crash
   * mid-flow cannot leave the database with two live current rows.
   */
  async restore(id: string): Promise<{ message: string }> {
    try {
      // Load the row WITH soft-deleted entries so we can inspect its user.
      const target = await this.workHistoryRepository.findOne({
        where: { id },
        withDeleted: true,
        relations: ['user'],
      });
      if (!target) {
        throw new NotFoundException(
          `Work history with ID ${id} not found or was not deleted.`,
        );
      }
      if (!target.deletedAt) {
        throw new NotFoundException(
          `Work history with ID ${id} not found or was not deleted.`,
        );
      }
      if (!target.user?.id) {
        throw new NotFoundException(
          `Work history with ID ${id} has no user — cannot safely restore.`,
        );
      }

      try {
        await this.dataSource.transaction(async (manager) => {
          const restoreResult = await manager.restore(WorkHistory, id);
          if (restoreResult.affected === 0) {
            throw new NotFoundException(
              `Work history with ID ${id} not found or was not deleted.`,
            );
          }

          // Look for any OTHER live + current row for this user.
          const conflictingCurrent = await manager.findOne(WorkHistory, {
            where: {
              user: { id: target.user.id },
              isCurrent: true,
              id: Not(id),
              deletedAt: IsNull(),
            },
          });

          if (conflictingCurrent) {
            // Demote the restored row so we don't violate the
            // one-current-per-user invariant. Admin may re-promote
            // explicitly via a fresh append.
            await manager.update(
              WorkHistory,
              { id },
              { isCurrent: false },
            );
            this.logger.log(
              `Restored work_history ${id} demoted to isCurrent=false — user ${target.user.id} already has current row ${conflictingCurrent.id}`,
            );
          }
        });
      } catch (error) {
        if (this.isWorkHistoryRaceConflict(error)) {
          throw new ConflictException('WORK_HISTORY_RACE');
        }
        throw error;
      }

      return { message: `Work history with ID ${id} has been restored.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}
