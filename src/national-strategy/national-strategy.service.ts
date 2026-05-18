import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { NationalStrategy } from './entities/national-strategy.entity';
import { CreateNationalStrategyDto } from './dto/create-national-strategy.dto';
import { UpdateNationalStrategyDto } from './dto/update-national-strategy.dto';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { handleException } from 'src/util/handleException';

/**
 * NationalStrategyService — Strategic Graph master CRUD.
 *
 * Authority (user-locked 2026-05-18):
 *   - Read endpoints: any authenticated user (controller gates with
 *     `JwtAuthGuard` only).
 *   - Write endpoints (create / update / softRemove / restore /
 *     setActive): admin + super-admin only, enforced via
 *     `assertAdminOrSuperAdmin` (CLAUDE.md §2 workStatus check + §3
 *     role check). Per-project convention, role enforcement lives in
 *     the SERVICE layer (mirrors `DevelopmentIssueService.assertStaffLead`).
 *
 * §17.3 note: this is a master/config table — no FK into any
 * project/plan/tracking entity, no `TrackingStatus` row written on
 * mutation.
 */
@Injectable()
export class NationalStrategyService {
  private readonly logger = new Logger(NationalStrategyService.name);

  constructor(
    @InjectRepository(NationalStrategy)
    private readonly repo: Repository<NationalStrategy>,

    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,
  ) {}

  async findAll(activeOnly = false): Promise<NationalStrategy[]> {
    try {
      const qb = this.repo
        .createQueryBuilder('ns')
        .orderBy('ns.created_at', 'ASC');
      if (activeOnly) {
        qb.andWhere('ns.is_active = :active', { active: true });
      }
      return await qb.getMany();
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<NationalStrategy> {
    try {
      const row = await this.repo.findOne({ where: { id } });
      if (!row) {
        throw new NotFoundException(
          `NationalStrategy with ID ${id} not found`,
        );
      }
      return row;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async create(
    dto: CreateNationalStrategyDto,
    userId: string,
  ): Promise<NationalStrategy> {
    try {
      await this.assertAdminOrSuperAdmin(userId);
      const row = this.repo.create({
        code: dto.code ?? null,
        nameTh: dto.nameTh,
        nameEn: dto.nameEn ?? null,
        description: dto.description ?? null,
        isActive: dto.isActive ?? true,
      });
      return await this.repo.save(row);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(
    id: string,
    dto: UpdateNationalStrategyDto,
    userId: string,
  ): Promise<NationalStrategy> {
    try {
      await this.assertAdminOrSuperAdmin(userId);
      const existing = await this.repo.findOne({ where: { id } });
      if (!existing) {
        throw new NotFoundException(
          `NationalStrategy with ID ${id} not found`,
        );
      }
      Object.assign(existing, {
        code: dto.code ?? existing.code,
        nameTh: dto.nameTh ?? existing.nameTh,
        nameEn: dto.nameEn ?? existing.nameEn,
        description: dto.description ?? existing.description,
        isActive: dto.isActive ?? existing.isActive,
      });
      return await this.repo.save(existing);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async softRemove(
    id: string,
    userId: string,
  ): Promise<{ message: string }> {
    try {
      await this.assertAdminOrSuperAdmin(userId);
      const row = await this.repo.findOne({ where: { id } });
      if (!row) {
        throw new NotFoundException(
          `NationalStrategy with ID ${id} not found`,
        );
      }
      await this.repo.softRemove(row);
      return {
        message: `NationalStrategy with ID ${id} has been soft-removed.`,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async restore(id: string, userId: string): Promise<{ message: string }> {
    try {
      await this.assertAdminOrSuperAdmin(userId);
      const result = await this.repo.restore(id);
      if (result.affected === 0) {
        throw new NotFoundException(
          `NationalStrategy with ID ${id} not found or was not deleted.`,
        );
      }
      return { message: `NationalStrategy with ID ${id} has been restored.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async setActive(
    id: string,
    isActive: boolean,
    userId: string,
  ): Promise<NationalStrategy> {
    try {
      await this.assertAdminOrSuperAdmin(userId);
      const row = await this.repo.findOne({ where: { id } });
      if (!row) {
        throw new NotFoundException(
          `NationalStrategy with ID ${id} not found`,
        );
      }
      row.isActive = isActive;
      return await this.repo.save(row);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  // -------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------

  /**
   * Loads the current WorkHistory, asserts workStatus=approved (§2),
   * and asserts role is admin or super-admin (BE-01 §9). Mirrors the
   * convention used by `DevelopmentIssueService.assertStaffLead` but
   * narrowed to admin + super-admin (no plain `staff`).
   */
  private async assertAdminOrSuperAdmin(
    userId: string,
    manager?: EntityManager,
  ): Promise<WorkHistory> {
    const repoLike = manager
      ? manager.getRepository(WorkHistory)
      : this.workHistoryRepo;
    const workHistory = await repoLike.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: ['workStatus', 'role', 'user'],
    });

    if (!workHistory) {
      throw new NotFoundException('ไม่พบข้อมูล WorkHistory ของผู้ใช้งาน');
    }
    if (workHistory.workStatus?.name?.toLowerCase() !== 'approved') {
      throw new ForbiddenException('สิทธิ์การใช้งานของคุณไม่ใช่ approved');
    }

    const roleName = workHistory.role?.name?.toLowerCase();
    const allowed = ['admin', 'super_admin', 'super-admin'];
    if (!roleName || !allowed.includes(roleName)) {
      throw new ForbiddenException(
        'เฉพาะ admin / super-admin เท่านั้นที่จัดการข้อมูลยุทธศาสตร์ระดับชาติได้',
      );
    }
    return workHistory;
  }
}
