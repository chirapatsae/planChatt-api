import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PlanPhase, PhaseType } from 'src/plan-phase/entities/plan-phase.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { CreateTrackingStatusDto } from './dto/create-tracking-status.dto';
import { UpdateTrackingStatusDto } from './dto/update-tracking-status.dto';
import { Status } from 'src/status/entities/status.entity';
import { TrackingStatus } from './entities/tracking-status.entity';
import { Comment } from 'src/comments/entities/comment.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { handleException } from 'src/util/handleException';
import { AnnouncementsService } from 'src/announcements/announcements.service';
import { Role } from 'src/roles/entities/role.entity';
import { AnnouncementStatus, NotificationType } from 'src/announcements/entities/announcement.entity';
import { WorkHistoryAmphoeResponsibility } from 'src/work-history-amphoe-responsibility/entities/work-history-amphoe-responsibility.entity';
import { WorkHistoryGovernmentAgencyResponsibility } from 'src/work-history-government-agency-responsibility/entities/work-history-government-agency-responsibility.entity';
import { LineageLockService } from 'src/common/lineage-lock/lineage-lock.service';

@Injectable()
export class TrackingStatusService {
  private readonly logger = new Logger(TrackingStatusService.name);

  constructor(
    @InjectRepository(TrackingStatus)
    private readonly trackingStatusRepo: Repository<TrackingStatus>,
    @InjectRepository(ProjectGroup)
    private readonly projectGroupRepo: Repository<ProjectGroup>,
    @InjectRepository(RevisedProjectGroup)
    private readonly revisedProjectGroupRepo: Repository<RevisedProjectGroup>,
    @InjectRepository(Status)
    private readonly statusRepo: Repository<Status>,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,
    @InjectRepository(Comment)
    private readonly commentRepo: Repository<Comment>,
    @InjectRepository(WorkHistoryAmphoeResponsibility)
    private readonly amphoeResponsibilityRepo: Repository<WorkHistoryAmphoeResponsibility>,
    @InjectRepository(WorkHistoryGovernmentAgencyResponsibility)
    private readonly agencyResponsibilityRepo: Repository<WorkHistoryGovernmentAgencyResponsibility>,

    private readonly announcementsService: AnnouncementsService,
    private readonly dataSource: DataSource,
    private readonly lineageLockService: LineageLockService,
  ) { }

  async create(dto: CreateTrackingStatusDto, userId: string): Promise<TrackingStatus> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        // 1-3. WorkHistory + workStatus (CLAUDE.md validation order)
        const workHistory = await manager.findOne(WorkHistory, {
          where: { user: { id: userId }, isCurrent: true },
          relations: ['user', 'role', 'workStatus', 'amphoe', 'localAdministrativeOrganization'],
        });
        if (!workHistory) {
          throw new NotFoundException(`WorkHistory for user ${userId} not found`);
        }
        if (workHistory.workStatus?.name !== 'approved') {
          throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)');
        }

        // 4. Load project
        const projectGroup = await manager.findOne(ProjectGroup, {
          where: { id: dto.projectId },
          relations: ['createdBy', 'developmentPlan', 'amphoe'],
        });
        if (!projectGroup) {
          throw new NotFoundException(`ProjectGroup with ID ${dto.projectId} not found`);
        }

        // หา status
        const status = await manager.findOne(Status, {
          where: { id: dto.statusId },
        });
        if (!status) {
          throw new NotFoundException(`Status with ID ${dto.statusId} not found`);
        }

        // --- RBAC & Ownership Check ---
        const allowedRoles = ['staff', 'admin', 'super-admin'];
        const userRole = workHistory.role?.name;

        if (!allowedRoles.includes(userRole)) {
          if (userRole === 'user') {
            // 8-9. Current status validation + allowed transitions for user role
            const currentTracking = await manager.findOne(TrackingStatus, {
              where: { projectGroupId: { id: projectGroup.id }, isLatest: true },
              relations: ['statusId'],
            });
            const currentStatusName: string = currentTracking?.statusId?.name ?? '';

            if (status.name === 'Pull_Back') {
              // 5. Ownership (CLAUDE.md §4): createdBy.id === workHistory.id
              if (projectGroup.createdBy?.id !== workHistory.id) {
                throw new ForbiddenException('คุณไม่มีสิทธิ์ในการเปลี่ยนสถานะโครงการนี้');
              }
              // Pull-back allowed only from Pending or Verified
              if (currentStatusName !== 'Pending' && currentStatusName !== 'Verified') {
                throw new BadRequestException(`ไม่สามารถดึงกลับได้จากสถานะ "${currentStatusName}"`);
              }
              // Scope: DevelopmentPlan must still be active + PlanPhase open
              const dp = projectGroup.developmentPlan;
              if (!dp?.isLatest) throw new BadRequestException('แผนพัฒนาฯ ไม่ใช่แผนปัจจุบัน');
              if (dp?.isBooked) throw new BadRequestException('แผนพัฒนาฯ ถูกรวมเล่มแล้ว');
              const isAgency = workHistory.amphoe?.id === '3001' && workHistory.localAdministrativeOrganization?.id === '3001027';
              const openPhase = await manager.findOne(PlanPhase, {
                where: { developmentPlan: { id: dp.id }, phaseType: isAgency ? PhaseType.AGENCY : PhaseType.LAO, isOpen: true },
              });
              if (!openPhase) throw new BadRequestException('ระยะเวลายื่นโครงการปิดแล้ว ไม่สามารถดึงกลับได้');

            } else if (status.name === 'Pending') {
              // User submission/resubmission to Pending.
              // Allowed source statuses: Ready, Pull_Back, Returned_For_Revision
              // CLAUDE.md §4.2 (Ready → Pending: same-org scope), PERMISSION MODEL,
              // Returned_For_Revision Rule (resubmission after staff rejection)
              const allowedSources = ['Ready', 'Pull_Back', 'Returned_For_Revision'];
              if (!allowedSources.includes(currentStatusName)) {
                throw new BadRequestException(
                  `ไม่สามารถส่งโครงการได้จากสถานะ "${currentStatusName}" ` +
                  `(ต้องอยู่ในสถานะ Ready, Pull_Back หรือ Returned_For_Revision)`,
                );
              }

              if (currentStatusName === 'Ready') {
                // Ready → Pending: same-organization scope per CLAUDE.md §4.2.
                // Ownership is NOT strictly required — authority is granted to users
                // in the same organizational scope as the project.

                // Determine project type from creator's WorkHistory (CLAUDE.md §5)
                const projectCreatorWh = await manager.findOne(WorkHistory, {
                  where: { id: projectGroup.createdBy?.id },
                  relations: ['amphoe', 'localAdministrativeOrganization'],
                });
                if (!projectCreatorWh) {
                  throw new BadRequestException('ไม่พบข้อมูล WorkHistory ของผู้สร้างโครงการ');
                }
                const isProjectAgency =
                  projectCreatorWh.amphoe?.id === '3001' &&
                  projectCreatorWh.localAdministrativeOrganization?.id === '3001027';
                const isRequesterAgency =
                  workHistory.amphoe?.id === '3001' &&
                  workHistory.localAdministrativeOrganization?.id === '3001027';

                if (isProjectAgency) {
                  // Agency-origin project: requester must be in same agency scope
                  if (!isRequesterAgency) {
                    throw new ForbiddenException('คุณไม่มีสิทธิ์ส่งโครงการนี้ (ต้องเป็นผู้ใช้ประเภท Agency เดียวกัน)');
                  }
                } else {
                  // LAO-origin project: requester must have same LAO
                  if (isRequesterAgency) {
                    throw new ForbiddenException('คุณไม่มีสิทธิ์ส่งโครงการนี้ (ต้องเป็นผู้ใช้ประเภท LAO เดียวกัน)');
                  }
                  const requesterLaoId = workHistory.localAdministrativeOrganization?.id;
                  const projectCreatorLaoId = projectCreatorWh.localAdministrativeOrganization?.id;
                  if (!requesterLaoId || !projectCreatorLaoId || requesterLaoId !== projectCreatorLaoId) {
                    throw new ForbiddenException('คุณไม่มีสิทธิ์ส่งโครงการนี้ (ต้องอยู่ในองค์กรปกครองส่วนท้องถิ่นเดียวกัน)');
                  }
                }
              } else {
                // Pull_Back → Pending or Returned_For_Revision → Pending:
                // Strict ownership required (CLAUDE.md §4, PERMISSION MODEL)
                if (projectGroup.createdBy?.id !== workHistory.id) {
                  throw new ForbiddenException('คุณไม่มีสิทธิ์ในการเปลี่ยนสถานะโครงการนี้');
                }
              }

              // Scope: DevelopmentPlan active + PlanPhase open
              // Re-validates scope on every submission/resubmission (RESUBMISSION CONSTRAINT)
              const dp = projectGroup.developmentPlan;
              if (!dp?.isLatest) throw new BadRequestException('แผนพัฒนาฯ ไม่ใช่แผนปัจจุบัน');
              if (dp?.isBooked) throw new BadRequestException('แผนพัฒนาฯ ถูกรวมเล่มแล้ว');
              const isAgency = workHistory.amphoe?.id === '3001' && workHistory.localAdministrativeOrganization?.id === '3001027';
              const openPhase = await manager.findOne(PlanPhase, {
                where: { developmentPlan: { id: dp.id }, phaseType: isAgency ? PhaseType.AGENCY : PhaseType.LAO, isOpen: true },
              });
              if (!openPhase) throw new BadRequestException('ระยะเวลายื่นโครงการปิดแล้ว ไม่สามารถส่งโครงการได้');

            } else {
              throw new ForbiddenException('คุณไม่มีสิทธิ์ในการเปลี่ยนสถานะโครงการนี้ (อนุญาตเฉพาะ Pull_Back และ Pending เท่านั้น)');
            }
          } else {
            throw new ForbiddenException('คุณไม่มีสิทธิ์ในการเปลี่ยนสถานะโครงการ');
          }
        } else {
          // Staff / Admin / Super-Admin branch
          // Per CLAUDE.md §3 + §4.1: staff must validate current status and transition rules.
          // Ownership is NOT required for staff-controlled workflow transitions.
          // Valid staff transitions: Pending → Verified, Pending → Returned_For_Revision,
          //   Verified → Pending_Approval, Verified → Returned_For_Revision,
          //   Pending_Approval → Approved

          // Validate project scope against its own DevelopmentPlan (CLAUDE.md §10: scope binding)
          const dp = projectGroup.developmentPlan;
          if (!dp?.isLatest) {
            throw new ForbiddenException('แผนพัฒนาฯ ที่เชื่อมโยงกับโครงการนี้ไม่ใช่แผนปัจจุบัน ไม่สามารถดำเนินการได้');
          }
          if (dp?.isBooked) {
            throw new ForbiddenException('แผนพัฒนาฯ ที่เชื่อมโยงกับโครงการนี้ถูกรวมเล่มแล้ว ไม่สามารถดำเนินการได้');
          }

          // Area responsibility check for staff role (mirrors rollback pattern in rollbackStatus)
          // Staff must be responsible for the project's amphoe. Admin/super-admin bypass.
          if (userRole === 'staff') {
            const projectAmphoeId = projectGroup.amphoe?.id;
            if (!projectAmphoeId) {
              throw new BadRequestException('โครงการนี้ไม่มีข้อมูลอำเภอ ไม่สามารถตรวจสอบสิทธิ์ได้');
            }
            const hasResponsibility = await manager.findOne(WorkHistoryAmphoeResponsibility, {
              where: {
                workHistory: { id: workHistory.id },
                amphoe: { id: projectAmphoeId },
              },
            });
            if (!hasResponsibility) {
              throw new ForbiddenException('คุณไม่มีสิทธิ์ดำเนินการกับโครงการนี้ (ไม่ได้รับผิดชอบอำเภอของโครงการ)');
            }
          }

          // Load current latest TrackingStatus to enforce transition rules
          const staffCurrentTracking = await manager.findOne(TrackingStatus, {
            where: { projectGroupId: { id: projectGroup.id }, isLatest: true },
            relations: ['statusId'],
          });
          if (!staffCurrentTracking) {
            throw new InternalServerErrorException(
              'ไม่พบสถานะปัจจุบันของโครงการ ข้อมูลสถานะอาจไม่สมบูรณ์',
            );
          }
          const staffCurrentStatusName = staffCurrentTracking.statusId?.name;
          if (!staffCurrentStatusName) {
            throw new InternalServerErrorException(
              'ไม่สามารถอ่านชื่อสถานะปัจจุบันของโครงการได้ ข้อมูล statusId อาจไม่สมบูรณ์',
            );
          }

          // Strict staff transition map: each source may have multiple valid destinations.
          // CLAUDE.md Returned_For_Revision Rule: MUST originate from Pending or Verified.
          const staffAllowedTransitions: Record<string, string[]> = {
            Pending: ['Verified', 'Returned_For_Revision'],
            Verified: ['Pending_Approval', 'Returned_For_Revision'],
            Pending_Approval: ['Approved'],
          };
          const allowedDestinations = staffAllowedTransitions[staffCurrentStatusName];
          if (!allowedDestinations || !allowedDestinations.includes(status.name)) {
            throw new ForbiddenException(
              `ไม่อนุญาตให้เปลี่ยนสถานะจาก "${staffCurrentStatusName}" เป็น "${status.name}" ` +
              `(เส้นทางที่อนุญาต: ${staffCurrentStatusName} → ${allowedDestinations?.join(', ') ?? 'ไม่มี'})`,
            );
          }
        }
        // ------------------------------

        // 10. Transition + Audit
        await manager.update(TrackingStatus, {
          projectGroupId: { id: projectGroup.id },
        }, {
          isLatest: false,
        });

        // Resolve staffRemark: only staff-lead roles may set this field.
        // User role submissions must have staffRemark stripped to null.
        // CLAUDE.md §3 (Role Responsibilities), §12 (Audit Rule).
        const staffLeadRoles = ['staff', 'admin', 'super-admin'];
        const resolvedStaffRemark = staffLeadRoles.includes(workHistory.role?.name)
          ? (dto.staffRemark ?? null)
          : null;

        const tracking = manager.create(TrackingStatus, {
          createdBy: workHistory,
          projectGroupId: projectGroup,
          comment: dto.comment,
          staffRemark: resolvedStaffRemark,
          statusId: status,
          isLatest: true,
        });
        const savedTracking = await manager.save(TrackingStatus, tracking);

        if (dto.comments?.length) {
          const commentEntities = dto.comments.map((c) =>
            manager.create(Comment, {
              step: c.step,
              detail: c.detail,
              trackingStatusId: savedTracking,
            }),
          );
          await manager.save(Comment, commentEntities);
        }

        if (status.name === 'Pull_Back') {
          try {
            const staffRole = await manager.findOne(Role, { where: { name: 'staff' } });
            if (staffRole) {
              await this.announcementsService.create({
                title: 'มีการขอดึงกลับโครงการ',
                description: `โครงการ "${projectGroup.title}" ขอดึงกลับโดย ${workHistory.user?.firstname} ${workHistory.user?.lastname}`,
                type: NotificationType.PROJECT,
                status: AnnouncementStatus.PUBLISHED,
                roleIds: [staffRole.id],
              }, userId);
            }
          } catch (err) {
            this.logger.error('Failed to send pull back notification', err);
          }
        }

        return savedTracking;
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async createMany(dtos: CreateTrackingStatusDto[], userId: string) {
    try {
      const workHistory = await this.workHistoryRepo.findOne({
        where: { user: { id: userId }, isCurrent: true },
        relations: ['role', 'workStatus'],
      });

      if (!workHistory) {
        throw new NotFoundException(`WorkHistory for user ${userId} not found`);
      }
      if (workHistory.workStatus?.name !== 'approved') {
        throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)');
      }

      // Staff-led only: this endpoint is restricted to staff/admin/super-admin
      const allowedRoles = ['staff', 'admin', 'super-admin'];
      const userRole = workHistory.role?.name;
      if (!allowedRoles.includes(userRole)) {
        throw new ForbiddenException('เฉพาะเจ้าหน้าที่ (staff/admin/super-admin) เท่านั้นที่สามารถใช้งาน endpoint นี้ได้');
      }

      // Strict transition map (CLAUDE.md §3, workflow-add-project §STATE TRANSITIONS)
      const staffAllowedTransitions: Record<string, string> = {
        Pending: 'Verified',
        Verified: 'Pending_Approval',
        Pending_Approval: 'Approved',
      };

      return this.dataSource.transaction(async (manager) => {
        const results: TrackingStatus[] = [];

        for (const dto of dtos) {
          const { projectId, statusId } = dto;

          // Load project with DevelopmentPlan scope
          const projectGroup = await manager.findOne(ProjectGroup, {
            where: { id: projectId },
            relations: ['developmentPlan'],
          });
          if (!projectGroup) {
            throw new NotFoundException(`ProjectGroup with ID ${projectId} not found`);
          }

          const targetStatus = await manager.findOne(Status, { where: { id: statusId } });
          if (!targetStatus) {
            throw new NotFoundException(`Status with ID ${statusId} not found`);
          }

          // Plan scope binding (CLAUDE.md §10)
          const dp = projectGroup.developmentPlan;
          if (!dp?.isLatest) {
            throw new ForbiddenException(`แผนพัฒนาฯ ที่เชื่อมโยงกับโครงการนี้ไม่ใช่แผนปัจจุบัน (โครงการ ID: ${projectId})`);
          }
          if (dp?.isBooked) {
            throw new ForbiddenException(`แผนพัฒนาฯ ที่เชื่อมโยงกับโครงการนี้ถูกรวมเล่มแล้ว (โครงการ ID: ${projectId})`);
          }

          // Load and validate current TrackingStatus
          const currentTracking = await manager.findOne(TrackingStatus, {
            where: { projectGroupId: { id: projectId }, isLatest: true },
            relations: ['statusId'],
          });
          if (!currentTracking) {
            throw new BadRequestException(`ไม่พบสถานะปัจจุบันของโครงการ ID: ${projectId}`);
          }
          const currentStatusName = currentTracking.statusId?.name;
          if (!currentStatusName) {
            throw new BadRequestException(`ไม่สามารถอ่านสถานะปัจจุบันของโครงการ ID: ${projectId}`);
          }

          // Enforce strict transition map
          const allowedDestination = staffAllowedTransitions[currentStatusName];
          if (!allowedDestination || allowedDestination !== targetStatus.name) {
            throw new ForbiddenException(
              `ไม่อนุญาตให้เปลี่ยนสถานะจาก "${currentStatusName}" เป็น "${targetStatus.name}" ` +
              `(โครงการ ID: ${projectId}, เส้นทางที่อนุญาต: ${currentStatusName} → ${allowedDestination ?? 'ไม่มี'})`,
            );
          }

          // Commit transition
          await manager.update(
            TrackingStatus,
            { projectGroupId: { id: projectId } },
            { isLatest: false },
          );

          // createMany is staff-only (enforced above); staffRemark is always eligible.
          // staffRemark comes from per-dto value (each DTO in the bulk array may carry its own remark).
          const tracking = manager.create(TrackingStatus, {
            createdBy: workHistory,
            projectGroupId: { id: projectId },
            statusId: { id: statusId },
            staffRemark: dto.staffRemark ?? null,
            isLatest: true,
          });

          const savedTracking = await manager.save(TrackingStatus, tracking);
          results.push(savedTracking);
        }

        return results;
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }
  async createManyRevisedProjectGroup(dtos: CreateTrackingStatusDto[], userId: string) {
    try {
      const workHistory = await this.workHistoryRepo.findOne({
        where: { user: { id: userId }, isCurrent: true },
        relations: ['role', 'workStatus'],
      });

      if (!workHistory) {
        throw new NotFoundException(`WorkHistory for user ${userId} not found`);
      }
      if (workHistory.workStatus?.name !== 'approved') {
        throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)');
      }

      // Staff-led only: this endpoint is restricted to staff/admin/super-admin
      const allowedRoles = ['staff', 'admin', 'super-admin'];
      const userRole = workHistory.role?.name;
      if (!allowedRoles.includes(userRole)) {
        throw new ForbiddenException('เฉพาะเจ้าหน้าที่ (staff/admin/super-admin) เท่านั้นที่สามารถใช้งาน endpoint นี้ได้');
      }

      // Strict transition map (CLAUDE.md §3)
      const staffAllowedTransitions: Record<string, string> = {
        Pending: 'Verified',
        Verified: 'Pending_Approval',
        Pending_Approval: 'Approved',
      };

      return this.dataSource.transaction(async (manager) => {
        const results: TrackingStatus[] = [];

        for (const dto of dtos) {
          const { projectId, statusId } = dto;

          // Load RPG with DPR + parent DPlan scope
          const revisedProjectGroup = await manager.findOne(RevisedProjectGroup, {
            where: { id: projectId },
            relations: ['developmentPlanRevision', 'developmentPlanRevision.developmentPlan'],
          });
          if (!revisedProjectGroup) {
            throw new NotFoundException(`RevisedProjectGroup with ID ${projectId} not found`);
          }

          const targetStatus = await manager.findOne(Status, { where: { id: statusId } });
          if (!targetStatus) {
            throw new NotFoundException(`Status with ID ${statusId} not found`);
          }

          const dpr = revisedProjectGroup.developmentPlanRevision;

          // Validate DPR scope: DPR must be latest and not yet assembled (staff bulk transition)
          // DPR.isOpen is NOT a gate for staff. DevelopmentPlan.isBooked is NOT a gate for staff.
          if (!dpr?.isLatest) {
            throw new ForbiddenException(`รอบการแก้ไข/เปลี่ยนแปลงนี้ไม่ใช่รอบปัจจุบัน (โครงการ ID: ${projectId})`);
          }
          if (dpr?.isBooked) {
            throw new ForbiddenException(`รอบการแก้ไข/เปลี่ยนแปลงถูกรวมเล่มแล้ว (โครงการ ID: ${projectId})`);
          }

          // Load and validate current TrackingStatus
          const currentTracking = await manager.findOne(TrackingStatus, {
            where: { revisedProjectGroupId: { id: projectId }, isLatest: true },
            relations: ['statusId'],
          });
          if (!currentTracking) {
            throw new BadRequestException(`ไม่พบสถานะปัจจุบันของโครงการ ID: ${projectId}`);
          }
          const currentStatusName = currentTracking.statusId?.name;
          if (!currentStatusName) {
            throw new BadRequestException(`ไม่สามารถอ่านสถานะปัจจุบันของโครงการ ID: ${projectId}`);
          }

          // Enforce strict transition map
          const allowedDestination = staffAllowedTransitions[currentStatusName];
          if (!allowedDestination || allowedDestination !== targetStatus.name) {
            throw new ForbiddenException(
              `ไม่อนุญาตให้เปลี่ยนสถานะจาก "${currentStatusName}" เป็น "${targetStatus.name}" ` +
              `(โครงการ ID: ${projectId}, เส้นทางที่อนุญาต: ${currentStatusName} → ${allowedDestination ?? 'ไม่มี'})`,
            );
          }

          // Commit transition
          await manager.update(
            TrackingStatus,
            { revisedProjectGroupId: { id: projectId } },
            { isLatest: false },
          );

          // createManyRevisedProjectGroup is staff-only (enforced above); staffRemark is always eligible.
          const tracking = manager.create(TrackingStatus, {
            createdBy: workHistory,
            revisedProjectGroupId: { id: projectId },
            statusId: { id: statusId },
            staffRemark: dto.staffRemark ?? null,
            isLatest: true,
          });

          const savedTracking = await manager.save(TrackingStatus, tracking);
          results.push(savedTracking);
        }

        return results;
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }


  async findAll(): Promise<TrackingStatus[]> {
    try {
      return await this.trackingStatusRepo.find({
        relations: [
          'createdBy',
          'deletedBy',
          'projectGroupId',
          'statusId',
          'comments',
        ],
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<TrackingStatus> {
    try {
      const tracking = await this.trackingStatusRepo.findOne({
        where: { id },
        relations: [
          'createdBy',
          'deletedBy',
          'projectGroupId',
          'statusId',
          'comments',
        ],
      });
      if (!tracking) {
        throw new NotFoundException(`Tracking status with ID ${id} not found`);
      }
      return tracking;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(
    id: string,
    dto: UpdateTrackingStatusDto,
    userId: string,
  ): Promise<{ message: string; data: TrackingStatus }> {
    try {
      const workHistory = await this.workHistoryRepo.findOne({
        where: { user: { id: userId }, isCurrent: true },
        relations: ['role', 'workStatus'],
      });
      if (!workHistory) throw new NotFoundException('WorkHistory not found');
      if (workHistory.workStatus?.name !== 'approved') {
        throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)');
      }
      if (!['admin', 'super-admin'].includes(workHistory.role?.name)) {
        throw new ForbiddenException('เฉพาะ admin หรือ super-admin เท่านั้นที่สามารถแก้ไข TrackingStatus ได้');
      }

      const tracking = await this.trackingStatusRepo.findOne({ where: { id } });
      if (!tracking) {
        throw new NotFoundException(`Tracking status with ID ${id} not found`);
      }
      if (dto.statusId) {
        const status = await this.statusRepo.findOne({
          where: { id: dto.statusId },
        });
        if (!status)
          throw new NotFoundException(
            `Status with ID ${dto.statusId} not found`,
          );
        tracking.statusId = status;
      }
      // staffRemark is write-once: it MUST NOT be mutated after creation.
      // Explicitly ignore any staffRemark value from the update DTO.
      // CLAUDE.md §12 (Audit Rule): audit fields must remain immutable after recording.
      const updated = await this.trackingStatusRepo.save(tracking);
      return {
        message: 'Tracking status updated successfully',
        data: updated,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async softRemove(id: string, userId: string): Promise<{ message: string }> {
    try {
      const workHistory = await this.workHistoryRepo.findOne({
        where: { user: { id: userId }, isCurrent: true },
        relations: ['role', 'workStatus'],
      });
      if (!workHistory) throw new NotFoundException('WorkHistory not found');
      if (workHistory.workStatus?.name !== 'approved') {
        throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)');
      }
      if (!['admin', 'super-admin'].includes(workHistory.role?.name)) {
        throw new ForbiddenException('เฉพาะ admin หรือ super-admin เท่านั้นที่สามารถลบ TrackingStatus ได้');
      }

      const tracking = await this.trackingStatusRepo.findOne({ where: { id } });
      if (!tracking) {
        throw new NotFoundException(`Tracking status with ID ${id} not found`);
      }
      tracking.deletedBy = workHistory;
      await this.trackingStatusRepo.save(tracking);
      await this.trackingStatusRepo.softRemove(tracking);
      return {
        message: `Tracking status ${id} removed successfully`,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async restore(
    id: string,
    userId: string,
  ): Promise<{ message: string; data: TrackingStatus }> {
    try {
      const workHistory = await this.workHistoryRepo.findOne({
        where: { user: { id: userId }, isCurrent: true },
        relations: ['role', 'workStatus'],
      });
      if (!workHistory) throw new NotFoundException('WorkHistory not found');
      if (workHistory.workStatus?.name !== 'approved') {
        throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)');
      }
      if (!['admin', 'super-admin'].includes(workHistory.role?.name)) {
        throw new ForbiddenException('เฉพาะ admin หรือ super-admin เท่านั้นที่สามารถกู้คืน TrackingStatus ได้');
      }

      await this.trackingStatusRepo.restore(id);
      const restoredTracking = await this.trackingStatusRepo.findOne({
        where: { id },
        relations: [
          'createdBy',
          'deletedBy',
          'projectGroupId',
          'statusId',
          'comments',
        ],
      });
      if (!restoredTracking) {
        throw new NotFoundException(
          `Tracking status with ID ${id} not found after restore`,
        );
      }
      return {
        message: `Tracking status ${id} restored successfully`,
        data: restoredTracking,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async createByRevisedProjectGroup(dto: CreateTrackingStatusDto, userId: string): Promise<TrackingStatus> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        // 1-3. WorkHistory + workStatus
        const workHistory = await manager.findOne(WorkHistory, {
          where: { user: { id: userId }, isCurrent: true },
          relations: ['user', 'role', 'workStatus', 'amphoe', 'localAdministrativeOrganization'],
        });
        if (!workHistory) {
          throw new NotFoundException(`WorkHistory for user ${userId} not found`);
        }
        if (workHistory.workStatus?.name !== 'approved') {
          throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)');
        }

        // 4. Load RevisedProjectGroup with revision scope
        const revisedProjectGroup = await manager.findOne(RevisedProjectGroup, {
          where: { id: dto.projectId },
          relations: ['createdBy', 'developmentPlanRevision', 'developmentPlanRevision.developmentPlan', 'responsibleAgency'],
        });
        if (!revisedProjectGroup) {
          throw new NotFoundException(`RevisedProjectGroup with ID ${dto.projectId} not found`);
        }

        // หา status
        const status = await manager.findOne(Status, {
          where: { id: dto.statusId },
        });
        if (!status) {
          throw new NotFoundException(`Status with ID ${dto.statusId} not found`);
        }

        // --- RBAC & Ownership Check ---
        const allowedRoles = ['staff', 'admin', 'super-admin'];
        const userRole = workHistory.role?.name;

        if (!allowedRoles.includes(userRole)) {
          if (userRole === 'user') {
            // 5. Ownership (CLAUDE.md §4)
            if (revisedProjectGroup.createdBy?.id !== workHistory.id) {
              throw new ForbiddenException('คุณไม่มีสิทธิ์ในการเปลี่ยนสถานะโครงการนี้');
            }

            // Agency classification: only agency users may perform revision/change workflow actions
            // per CLAUDE.md §3, workflow-revision §User Constraint, workflow-change §User Constraint
            const isAgency = workHistory.amphoe?.id === '3001' && workHistory.localAdministrativeOrganization?.id === '3001027';
            if (!isAgency) {
              throw new ForbiddenException('เฉพาะผู้ใช้ประเภท Agency เท่านั้นที่สามารถดำเนินการในขั้นตอนการแก้ไข/เปลี่ยนแปลงได้');
            }

            // 7. Revision scope: DPR must be open
            const dpr = revisedProjectGroup.developmentPlanRevision;
            if (!dpr?.isOpen) {
              throw new BadRequestException('รอบการแก้ไข/เปลี่ยนแปลงปิดแล้ว ไม่สามารถดำเนินการได้');
            }

            // DPR parent DevelopmentPlan scope (CLAUDE.md §10, workflow-revision §Workflow Scope Validation)
            const dprDp = dpr.developmentPlan;
            if (!dprDp?.isLatest) {
              throw new BadRequestException('แผนพัฒนาฯ ที่อ้างอิงโดยรอบการแก้ไขไม่ใช่แผนปัจจุบัน ไม่สามารถดำเนินการได้');
            }
            if (dprDp?.isBooked) {
              throw new BadRequestException('แผนพัฒนาฯ ที่อ้างอิงโดยรอบการแก้ไขถูกรวมเล่มแล้ว ไม่สามารถดำเนินการได้');
            }

            // 8-9. Current status + allowed transitions
            const currentTracking = await manager.findOne(TrackingStatus, {
              where: { revisedProjectGroupId: { id: revisedProjectGroup.id }, isLatest: true },
              relations: ['statusId'],
            });
            const currentStatusName = currentTracking?.statusId?.name;

            if (status.name === 'Pull_Back') {
              if (currentStatusName !== 'Pending' && currentStatusName !== 'Verified') {
                throw new BadRequestException(`ไม่สามารถดึงกลับได้จากสถานะ "${currentStatusName}"`);
              }
            } else if (status.name === 'Pending') {
              // Resubmit allowed from Pull_Back or Returned_For_Revision (CLAUDE.md §Returned_For_Revision Rule, task §7.1)
              if (currentStatusName !== 'Pull_Back' && currentStatusName !== 'Returned_For_Revision') {
                throw new BadRequestException(`ไม่สามารถส่งใหม่ได้จากสถานะ "${currentStatusName}" (ต้องอยู่ในสถานะ Pull_Back หรือ Returned_For_Revision)`);
              }
            } else {
              throw new ForbiddenException('คุณไม่มีสิทธิ์ในการเปลี่ยนสถานะโครงการนี้ (อนุญาตเฉพาะ Pull_Back และ Pending เท่านั้น)');
            }
          } else {
            throw new ForbiddenException('คุณไม่มีสิทธิ์ในการเปลี่ยนสถานะโครงการ');
          }
        } else {
          // Staff / Admin / Super-Admin branch for RevisedProjectGroup
          // Per CLAUDE.md §3 + §4.1: staff must validate current status and transition rules.
          // Ownership is NOT required for staff-controlled workflow transitions.
          // Valid staff transitions: Pending → Verified/Returned_For_Revision,
          //   Verified → Pending_Approval/Returned_For_Revision, Pending_Approval → Approved

          // Validate DPR scope: DPR must be latest and not yet assembled
          // Per corrected domain: staff transitions are gated by DPR.isLatest + DPR.isBooked only.
          // DPR.isOpen is NOT a gate for staff (staff may review after submission window closes).
          // DevelopmentPlan.isBooked is NOT a gate for staff (main plan being booked is expected).
          const staffDpr = revisedProjectGroup.developmentPlanRevision;
          if (!staffDpr?.isLatest) {
            throw new ForbiddenException('รอบการแก้ไข/เปลี่ยนแปลงนี้ไม่ใช่รอบปัจจุบัน ไม่สามารถดำเนินการได้');
          }
          if (staffDpr?.isBooked) {
            throw new ForbiddenException('รอบการแก้ไข/เปลี่ยนแปลงถูกรวมเล่มแล้ว ไม่สามารถดำเนินการได้');
          }

          // Area responsibility check for staff role (CLAUDE.md STAFF-LED ROLLBACK RULE §Area Responsibility)
          // Staff must be responsible for the responsibleAgency of the revised project.
          // Admin and super-admin bypass this check.
          if (userRole === 'staff') {
            const projectAgencyId = revisedProjectGroup.responsibleAgency?.id;
            if (!projectAgencyId) {
              throw new BadRequestException('โครงการนี้ยังไม่มีการกำหนดหน่วยงานรับผิดชอบ ไม่สามารถตรวจสอบสิทธิ์ได้');
            }
            const hasResponsibility = await manager.findOne(WorkHistoryGovernmentAgencyResponsibility, {
              where: {
                workHistory: { id: workHistory.id },
                governmentAgency: { id: projectAgencyId },
              },
            });
            if (!hasResponsibility) {
              throw new ForbiddenException('คุณไม่มีสิทธิ์ดำเนินการกับโครงการนี้ (ไม่ได้รับผิดชอบหน่วยงานของโครงการ)');
            }
          }

          // Load current latest TrackingStatus to enforce transition rules
          const staffCurrentTracking = await manager.findOne(TrackingStatus, {
            where: { revisedProjectGroupId: { id: revisedProjectGroup.id }, isLatest: true },
            relations: ['statusId'],
          });
          if (!staffCurrentTracking) {
            throw new InternalServerErrorException(
              'ไม่พบสถานะปัจจุบันของโครงการ ข้อมูลสถานะอาจไม่สมบูรณ์',
            );
          }
          const staffCurrentStatusName = staffCurrentTracking.statusId?.name;
          if (!staffCurrentStatusName) {
            throw new InternalServerErrorException(
              'ไม่สามารถอ่านชื่อสถานะปัจจุบันของโครงการได้ ข้อมูล statusId อาจไม่สมบูรณ์',
            );
          }

          // Strict staff transition map: array-valued to support multiple destinations
          // Pending/Verified may go to Returned_For_Revision (CLAUDE.md §Returned_For_Revision Rule)
          const staffAllowedTransitions: Record<string, string[]> = {
            Pending: ['Verified', 'Returned_For_Revision'],
            Verified: ['Pending_Approval', 'Returned_For_Revision'],
            Pending_Approval: ['Approved'],
          };
          const allowedDestinations = staffAllowedTransitions[staffCurrentStatusName];
          if (!allowedDestinations || !allowedDestinations.includes(status.name)) {
            throw new ForbiddenException(
              `ไม่อนุญาตให้เปลี่ยนสถานะจาก "${staffCurrentStatusName}" เป็น "${status.name}" ` +
              `(เส้นทางที่อนุญาต: ${staffCurrentStatusName} → ${allowedDestinations?.join(', ') ?? 'ไม่มี'})`,
            );
          }
        }
        // ------------------------------

        // อัปเดต oldAdditionDetail ใน RevisedProjectGroup ถ้ามีการส่งมา
        if (dto.oldAdditionDetail !== undefined) {
          revisedProjectGroup.oldAdditionDetail = dto.oldAdditionDetail;
          await manager.save(RevisedProjectGroup, revisedProjectGroup);
        }

        // อัปเดต TrackingStatus ตัวเก่าให้ isLatest = false
        await manager.update(TrackingStatus, {
          revisedProjectGroupId: { id: revisedProjectGroup.id },
        }, {
          isLatest: false,
        });

        // Resolve staffRemark for createByRevisedProjectGroup.
        // Only staff-lead roles may set this field; user role submissions are stripped to null.
        // CLAUDE.md §3 (Role Responsibilities), §12 (Audit Rule).
        const staffLeadRolesRpg = ['staff', 'admin', 'super-admin'];
        const resolvedStaffRemarkRpg = staffLeadRolesRpg.includes(workHistory.role?.name)
          ? (dto.staffRemark ?? null)
          : null;

        // สร้าง TrackingStatus ใหม่
        const tracking = manager.create(TrackingStatus, {
          createdBy: workHistory,
          revisedProjectGroupId: revisedProjectGroup,
          statusId: status,
          isLatest: true,
          comment: dto.comment,
          staffRemark: resolvedStaffRemarkRpg,
        });
        const savedTracking = await manager.save(TrackingStatus, tracking);

        if (dto.comments?.length) {
          const commentEntities = dto.comments.map((c) =>
            manager.create(Comment, {
              step: c.step,
              detail: c.detail,
              trackingStatusId: savedTracking,
            }),
          );
          await manager.save(Comment, commentEntities);
        }

        return savedTracking;
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async rollbackStatus(projectGroupId: string, userId: string, clearResponsibleAgency?: boolean): Promise<{ message: string; status: string }> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        // 1-2. Load WorkHistory + validate workStatus
        const workHistory = await manager.findOne(WorkHistory, {
          where: { user: { id: userId }, isCurrent: true },
          relations: ['role', 'workStatus', 'amphoe', 'localAdministrativeOrganization'],
        });
        if (!workHistory) throw new NotFoundException(`WorkHistory for user ${userId} not found`);
        if (workHistory.workStatus?.name !== 'approved') {
          throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)');
        }

        // 3. RBAC: Only staff / admin / super-admin may perform staff-led rollback (CLAUDE.md §4.1)
        const allowedRoles = ['staff', 'admin', 'super-admin'];
        const userRole = workHistory.role?.name;
        if (!allowedRoles.includes(userRole)) {
          throw new ForbiddenException('เฉพาะเจ้าหน้าที่ (staff/admin/super-admin) เท่านั้นที่สามารถดึงกลับโครงการได้');
        }

        // 4. Load project
        const projectGroup = await manager.findOne(ProjectGroup, {
          where: { id: projectGroupId },
          relations: ['createdBy', 'developmentPlan', 'responsibleAgency', 'amphoe'],
        });
        if (!projectGroup) throw new NotFoundException(`ProjectGroup with ID ${projectGroupId} not found`);

        // NOTE: responsibleAgency is eagerly loaded above for clearResponsibleAgency check

        // 5. Staff district (Amphoe) responsibility check
        //    Staff must be responsible for the project's Amphoe.
        //    Admin and super-admin bypass this check.
        if (userRole === 'staff') {
          const projectAmphoeId = projectGroup.amphoe?.id;
          if (!projectAmphoeId) {
            throw new BadRequestException('โครงการนี้ไม่มีข้อมูลอำเภอ ไม่สามารถตรวจสอบสิทธิ์ได้');
          }
          const hasResponsibility = await manager.findOne(WorkHistoryAmphoeResponsibility, {
            where: {
              workHistory: { id: workHistory.id },
              amphoe: { id: projectAmphoeId },
            },
          });
          if (!hasResponsibility) {
            throw new ForbiddenException('คุณไม่มีสิทธิ์ดึงกลับโครงการนี้ (ไม่ได้รับผิดชอบอำเภอของโครงการ)');
          }
        }

        // 6. Plan scope validation
        const dp = projectGroup.developmentPlan;
        if (!dp?.isLatest) throw new BadRequestException('แผนพัฒนาฯ ไม่ใช่แผนปัจจุบัน');
        if (dp?.isBooked) throw new BadRequestException('แผนพัฒนาฯ ถูกรวมเล่มแล้ว');

        // 6.5 CLAUDE.md §14 — Version Lineage Immutability.
        // A main-plan ProjectGroup that already has a non-deleted
        // RevisedProjectGroup descendant (prev_project_type = 'original')
        // cannot be rolled back. The guard rejects a non-leaf lineage.
        // Because BE-04 now physically hard-deletes the rolled-back row at
        // the end of this transaction, we must guarantee upstream that the
        // row has no descendants at all.
        await this.lineageLockService.assertDeletable(projectGroupId, 'original', manager);

        // 7. Status constraint — cannot rollback from Pull_Back or Ready
        const currentTracking = await manager.findOne(TrackingStatus, {
          where: { projectGroupId: { id: projectGroupId }, isLatest: true },
          relations: ['statusId'],
        });
        if (!currentTracking) throw new NotFoundException('ไม่พบสถานะปัจจุบันของโครงการ');
        const currentStatusName = currentTracking.statusId?.name;
        const disallowedStatuses = ['Pull_Back', 'Ready'];
        if (disallowedStatuses.includes(currentStatusName)) {
          throw new BadRequestException(`ไม่สามารถดึงกลับได้จากสถานะ "${currentStatusName}"`);
        }

        // 8. Optional: clear responsibleAgency — LAO-origin projects only (CLAUDE.md §7.1, §7.2, §7.3)
        // Agency projects MUST NOT have this field cleared (CLAUDE.md §7.1).
        if (clearResponsibleAgency === true) {
          // R5-H2: Clearing is allowed ONLY when current status is Pending_Approval (CLAUDE.md §7.4)
          if (currentStatusName !== 'Pending_Approval') {
            throw new ForbiddenException('การล้างหน่วยงานรับผิดชอบทำได้เฉพาะเมื่อโครงการอยู่ในสถานะ Pending_Approval เท่านั้น (CLAUDE.md §7.4)');
          }

          const projectCreatorWorkHistory = await manager.findOne(WorkHistory, {
            where: { id: projectGroup.createdBy?.id },
            relations: ['amphoe', 'localAdministrativeOrganization'],
          });
          const isAgencyProject =
            projectCreatorWorkHistory?.amphoe?.id === '3001' &&
            projectCreatorWorkHistory?.localAdministrativeOrganization?.id === '3001027';
          if (isAgencyProject) {
            throw new ForbiddenException('ไม่สามารถล้าง responsibleAgency ของโครงการประเภท Agency ได้ (CLAUDE.md §7.1)');
          }
          if (projectGroup.responsibleAgency) {
            await manager.update(ProjectGroup, { id: projectGroupId }, { responsibleAgency: null as any });
          }
        }

        // 9. Find the previous status (most recent non-latest) — true rollback
        const previousTracking = await manager.findOne(TrackingStatus, {
          where: { projectGroupId: { id: projectGroupId }, isLatest: false },
          relations: ['statusId'],
          order: { createAt: 'DESC' },
        });
        if (!previousTracking?.statusId) {
          throw new BadRequestException('ไม่พบสถานะก่อนหน้า ไม่สามารถย้อนกลับได้');
        }

        // 10. True rollback: hard-delete current record, restore previous to latest
        await manager.delete(TrackingStatus, { id: currentTracking.id });
        await manager.update(TrackingStatus, { id: previousTracking.id }, { isLatest: true });

        // 11. CLAUDE.md §14.6 — Rollback Ghost-Descendant Fix (BEHAVIORAL CHANGE).
        // Hard-delete the rolled-back row itself so any upstream parent
        // unlocks automatically under §14. After this line completes, no
        // row in revised_project_groups may reference this projectGroupId
        // via (prev_project_id, prev_project_type) — the lineage-lock guard
        // above already confirmed no non-deleted descendants exist.
        //
        // The cascade FK on tracking_status.project_group_id will remove any
        // remaining tracking history rows (older non-latest entries). This is
        // the intentional rollback audit exception documented in §12 and the
        // STAFF-LED ROLLBACK RULE.
        await manager.delete(ProjectGroup, { id: projectGroupId });

        return { message: `ย้อนสถานะสำเร็จ (กลับไปเป็น "${previousTracking.statusId.name}")`, status: 'success' };
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async rollbackRevisionProjectGroupStatus(revisionProjectGroupId: string, userId: string, clearResponsibleAgency?: boolean): Promise<{ message: string; status: string }> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        // 1-2. Load WorkHistory + validate workStatus
        const workHistory = await manager.findOne(WorkHistory, {
          where: { user: { id: userId }, isCurrent: true },
          relations: ['role', 'workStatus', 'amphoe', 'localAdministrativeOrganization'],
        });
        if (!workHistory) throw new NotFoundException(`WorkHistory for user ${userId} not found`);
        if (workHistory.workStatus?.name !== 'approved') {
          throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)');
        }

        // 3. RBAC: Only staff / admin / super-admin may perform staff-led rollback (CLAUDE.md §4.1)
        const allowedRoles = ['staff', 'admin', 'super-admin'];
        const userRole = workHistory.role?.name;
        if (!allowedRoles.includes(userRole)) {
          throw new ForbiddenException('เฉพาะเจ้าหน้าที่ (staff/admin/super-admin) เท่านั้นที่สามารถดึงกลับโครงการได้');
        }

        // 4. Load RevisedProjectGroup with DPR scope (including parent DPlan for R5-H1)
        const revisionProjectGroup = await manager.findOne(RevisedProjectGroup, {
          where: { id: revisionProjectGroupId },
          relations: ['createdBy', 'developmentPlanRevision', 'developmentPlanRevision.developmentPlan', 'responsibleAgency'],
        });
        if (!revisionProjectGroup) {
          throw new NotFoundException(`RevisedProjectGroup with ID ${revisionProjectGroupId} not found`);
        }

        // 5. Staff government agency responsibility check
        //    Staff must be responsible for the responsibleAgency of the revised project.
        //    Admin and super-admin bypass this check.
        if (userRole === 'staff') {
          const projectAgencyId = revisionProjectGroup.responsibleAgency?.id;
          if (!projectAgencyId) {
            throw new BadRequestException('โครงการนี้ยังไม่มีการกำหนดหน่วยงานรับผิดชอบ ไม่สามารถตรวจสอบสิทธิ์ได้');
          }
          const hasResponsibility = await manager.findOne(WorkHistoryGovernmentAgencyResponsibility, {
            where: {
              workHistory: { id: workHistory.id },
              governmentAgency: { id: projectAgencyId },
            },
          });
          if (!hasResponsibility) {
            throw new ForbiddenException('คุณไม่มีสิทธิ์ดึงกลับโครงการนี้ (ไม่ได้รับผิดชอบหน่วยงานของโครงการ)');
          }
        }

        // 6. Validate DPR scope: DPR must be latest and not yet assembled (staff-led rollback)
        // DPR.isOpen is NOT a gate for staff rollback. DevelopmentPlan.isBooked is NOT a gate for staff.
        const dpr = revisionProjectGroup.developmentPlanRevision;
        if (!dpr?.isLatest) {
          throw new BadRequestException('รอบการแก้ไข/เปลี่ยนแปลงนี้ไม่ใช่รอบปัจจุบัน ไม่สามารถดึงกลับได้');
        }
        if (dpr?.isBooked) {
          throw new BadRequestException('รอบการแก้ไข/เปลี่ยนแปลงถูกรวมเล่มแล้ว ไม่สามารถดึงกลับได้');
        }

        // 6.5 CLAUDE.md §14 — Version Lineage Immutability.
        // A RevisedProjectGroup that already has a non-deleted child
        // RevisedProjectGroup descendant (prev_project_type = 'revised')
        // cannot be rolled back. This replaces the former inline
        // `manager.exists(RevisedProjectGroup, ...)` check and delegates to
        // LineageLockService per §14.8.
        await this.lineageLockService.assertDeletable(revisionProjectGroupId, 'revised', manager);

        // 7. Status constraint — cannot rollback from Pull_Back or Ready
        const currentTracking = await manager.findOne(TrackingStatus, {
          where: { revisedProjectGroupId: { id: revisionProjectGroupId }, isLatest: true },
          relations: ['statusId'],
        });
        if (!currentTracking) throw new NotFoundException('ไม่พบสถานะปัจจุบันของโครงการ');
        const currentStatusName = currentTracking.statusId?.name;
        const disallowedStatuses = ['Pull_Back', 'Ready'];
        if (disallowedStatuses.includes(currentStatusName)) {
          throw new BadRequestException(`ไม่สามารถดึงกลับได้จากสถานะ "${currentStatusName}"`);
        }

        // 8. Optional: clear responsibleAgency for LAO-origin revised projects only (CLAUDE.md §7)
        if (clearResponsibleAgency === true) {
          // R5-H2: Clearing is allowed ONLY when current status is Pending_Approval (CLAUDE.md §7.4)
          if (currentStatusName !== 'Pending_Approval') {
            throw new ForbiddenException('การล้างหน่วยงานรับผิดชอบทำได้เฉพาะเมื่อโครงการอยู่ในสถานะ Pending_Approval เท่านั้น (CLAUDE.md §7.4)');
          }

          const projectCreatorWorkHistory = await manager.findOne(WorkHistory, {
            where: { id: revisionProjectGroup.createdBy?.id },
            relations: ['amphoe', 'localAdministrativeOrganization'],
          });
          const isAgencyProject =
            projectCreatorWorkHistory?.amphoe?.id === '3001' &&
            projectCreatorWorkHistory?.localAdministrativeOrganization?.id === '3001027';
          if (isAgencyProject) {
            throw new ForbiddenException('ไม่สามารถล้าง responsibleAgency ของโครงการประเภท Agency ได้ (CLAUDE.md §7.1)');
          }
          if (revisionProjectGroup.responsibleAgency) {
            await manager.update(RevisedProjectGroup, { id: revisionProjectGroupId }, { responsibleAgency: null as any });
          }
        }

        // 9. Find the previous status (most recent non-latest) — true rollback
        const previousTracking = await manager.findOne(TrackingStatus, {
          where: { revisedProjectGroupId: { id: revisionProjectGroupId }, isLatest: false },
          relations: ['statusId'],
          order: { createAt: 'DESC' },
        });
        if (!previousTracking?.statusId) {
          throw new BadRequestException('ไม่พบสถานะก่อนหน้า ไม่สามารถย้อนกลับได้');
        }

        // 10. True rollback: hard-delete current record, restore previous to latest
        await manager.delete(TrackingStatus, { id: currentTracking.id });
        await manager.update(TrackingStatus, { id: previousTracking.id }, { isLatest: true });

        // 11. CLAUDE.md §14.6 — Rollback Ghost-Descendant Fix (BEHAVIORAL CHANGE).
        // Hard-delete the rolled-back RevisedProjectGroup row itself so the
        // upstream parent (either a ProjectGroup or a previous
        // RevisedProjectGroup in the chain) unlocks automatically under §14.
        // The lineage-lock guard at step 6.5 already confirmed this row has
        // no non-deleted child descendants. The cascade FK on
        // tracking_status.revised_project_group_id removes any remaining
        // older tracking rows as part of the same transaction — the
        // intentional rollback audit exception (§12 + STAFF-LED ROLLBACK RULE).
        await manager.delete(RevisedProjectGroup, { id: revisionProjectGroupId });

        return { message: `ย้อนสถานะสำเร็จ (กลับไปเป็น "${previousTracking.statusId.name}")`, status: 'success' };
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}
