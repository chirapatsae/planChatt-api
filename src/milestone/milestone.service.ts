import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Milestone } from './entities/milestone.entity';
import { CreateMilestoneDto } from './dto/create-milestone.dto';
import { UpdateMilestoneDto } from './dto/update-milestone.dto';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { handleException } from 'src/util/handleException';

/**
 * MilestoneService — Strategic Graph master CRUD.
 *
 * Authority (user-locked 2026-05-18):
 *   - Reads: any authenticated user.
 *   - Writes: admin + super-admin only.
 *
 * §17.3 note: master/config table; no FK into project/plan/tracking.
 */
@Injectable()
export class MilestoneService {
  private readonly logger = new Logger(MilestoneService.name);

  constructor(
    @InjectRepository(Milestone)
    private readonly repo: Repository<Milestone>,

    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,
  ) {}

  async findAll(activeOnly = false): Promise<Milestone[]> {
    try {
      const qb = this.repo
        .createQueryBuilder('m')
        .orderBy('m.created_at', 'ASC');
      if (activeOnly) {
        qb.andWhere('m.is_active = :active', { active: true });
      }
      return await qb.getMany();
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<Milestone> {
    try {
      const row = await this.repo.findOne({ where: { id } });
      if (!row) {
        throw new NotFoundException(`Milestone with ID ${id} not found`);
      }
      return row;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async create(
    dto: CreateMilestoneDto,
    userId: string,
  ): Promise<Milestone> {
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
    dto: UpdateMilestoneDto,
    userId: string,
  ): Promise<Milestone> {
    try {
      await this.assertAdminOrSuperAdmin(userId);
      const existing = await this.repo.findOne({ where: { id } });
      if (!existing) {
        throw new NotFoundException(`Milestone with ID ${id} not found`);
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
        throw new NotFoundException(`Milestone with ID ${id} not found`);
      }
      await this.repo.softRemove(row);
      return { message: `Milestone with ID ${id} has been soft-removed.` };
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
          `Milestone with ID ${id} not found or was not deleted.`,
        );
      }
      return { message: `Milestone with ID ${id} has been restored.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async setActive(
    id: string,
    isActive: boolean,
    userId: string,
  ): Promise<Milestone> {
    try {
      await this.assertAdminOrSuperAdmin(userId);
      const row = await this.repo.findOne({ where: { id } });
      if (!row) {
        throw new NotFoundException(`Milestone with ID ${id} not found`);
      }
      row.isActive = isActive;
      return await this.repo.save(row);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

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
        'เฉพาะ admin / super-admin เท่านั้นที่จัดการข้อมูล Milestone ได้',
      );
    }
    return workHistory;
  }
}
