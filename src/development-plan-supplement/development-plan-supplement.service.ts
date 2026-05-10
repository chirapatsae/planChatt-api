import {
  Injectable,
  NotFoundException,
  Logger,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { CreateDevelopmentPlanSupplementDto } from './dto/create-development-plan-supplement.dto';
import { UpdateDevelopmentPlanSupplementDto } from './dto/update-development-plan-supplement.dto';
import { DevelopmentPlanSupplement } from './entities/development-plan-supplement.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { handleException } from 'src/util/handleException';
import { UsersService } from 'src/users/users.service';
import { BookLockService } from 'src/common/book-lock/book-lock.service';
import { OrphanCleanupService } from 'src/orphan-cleanup/orphan-cleanup.service';

@Injectable()
export class DevelopmentPlanSupplementService {
  private readonly logger = new Logger(DevelopmentPlanSupplementService.name);

  constructor(
    @InjectRepository(DevelopmentPlanSupplement)
    private readonly supplementRepository: Repository<DevelopmentPlanSupplement>,

    @InjectRepository(DevelopmentPlan)
    private readonly developmentPlanRepository: Repository<DevelopmentPlan>,

    @InjectRepository(WorkHistory)
    private readonly workHistoryRepository: Repository<WorkHistory>,
    private readonly usersService: UsersService,
    private readonly bookLockService: BookLockService,
    private readonly dataSource: DataSource,
    private readonly orphanCleanupService: OrphanCleanupService,
  ) {}

  async create(
    createDto: CreateDevelopmentPlanSupplementDto,
    userId: string,
  ): Promise<DevelopmentPlanSupplement> {
    try {
      const startDate = createDto.startDate ? new Date(createDto.startDate) : null;
      const endDate = createDto.endDate ? new Date(createDto.endDate) : null;

      if ((startDate && !endDate) || (!startDate && endDate)) {
        throw new BadRequestException('กรุณาระบุวันที่เปิดและวันที่ปิดให้ครบถ้วน');
      }

      if (startDate && endDate && startDate >= endDate) {
        throw new BadRequestException('วันที่เปิดต้องน้อยกว่าวันที่ปิด');
      }

      // Validate development plan exists
      const developmentPlan = await this.developmentPlanRepository.findOne({
        where: { id: createDto.developmentPlanId },
      });
      if (!developmentPlan) {
        throw new NotFoundException(
          `Development Plan with ID ${createDto.developmentPlanId} not found`,
        );
      }

      const workHistory = await this.workHistoryRepository.findOne({
        where: { user: { id: userId } },
      });
      if (!workHistory) {
        throw new NotFoundException('Work history not found for this user');
      }

      if (startDate && endDate) {
        await this.ensureNoDateOverlap(
          developmentPlan.id,
          startDate,
          endDate,
        );
      }

      if (createDto.isOpen) {
        await this.supplementRepository.update(
          {
            developmentPlan: { id: createDto.developmentPlanId },
            isOpen: true,
          },
          { isOpen: false },
        );
      }

      // If setting as latest, unset other latest supplements for this development plan
      if (createDto.isLatest) {
        await this.supplementRepository.update(
          { developmentPlan: { id: createDto.developmentPlanId }, isLatest: true },
          { isLatest: false },
        );
      }

      const supplement = this.supplementRepository.create({
        developmentPlan,
        supplementNumber: createDto.supplementNumber,
        description: createDto.description,
        isLatest: createDto.isLatest ?? false,
        isOpen: createDto.isOpen ?? false,
        startDate,
        endDate,
        createdBy: workHistory,
      });

      return await this.supplementRepository.save(supplement);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll(): Promise<DevelopmentPlanSupplement[]> {
    try {
      return await this.supplementRepository.find({
        relations: ['developmentPlan', 'createdBy', 'supplementProjectGroups'],
        order: { createdAt: 'DESC' },
        where: { isLatest: true },
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<DevelopmentPlanSupplement> {
    try {
      const supplement = await this.supplementRepository.findOne({
        where: { id },
        relations: ['developmentPlan', 'createdBy', 'supplementProjectGroups'],
      });

      if (!supplement) {
        this.logger.warn(`DevelopmentPlanSupplement not found: ${id}`);
        throw new NotFoundException(
          `DevelopmentPlanSupplement with id ${id} not found`,
        );
      }

      return supplement;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findByDevelopmentPlan(developmentPlanId: string): Promise<DevelopmentPlanSupplement[]> {
    try {
      return await this.supplementRepository.find({
        where: { developmentPlan: { id: developmentPlanId } },
        relations: ['developmentPlan', 'createdBy', 'supplementProjectGroups'],
        order: { supplementNumber: 'ASC' },
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(
    id: string,
    updateDto: UpdateDevelopmentPlanSupplementDto,
  ): Promise<DevelopmentPlanSupplement> {
    try {
      const supplement = await this.findOne(id);

      // CLAUDE.md §15 — Book Lineage Immutability (GLOBAL timeline).
      // A supplement is locked iff ANY strictly-newer non-soft-deleted
      // sibling child of the same plan exists, across BOTH revisions
      // and supplements (OQ-2=(B) linear across types — a newer edit
      // revision locks this supplement and vice versa).
      await this.bookLockService.assertEditable(
        id,
        'development_plan_supplement',
        this.supplementRepository.manager,
      );

      const startDate =
        updateDto.startDate !== undefined
          ? updateDto.startDate
            ? new Date(updateDto.startDate)
            : null
          : supplement.startDate;
      const endDate =
        updateDto.endDate !== undefined
          ? updateDto.endDate
            ? new Date(updateDto.endDate)
            : null
          : supplement.endDate;

      if ((updateDto.startDate !== undefined || updateDto.endDate !== undefined) && (!startDate || !endDate)) {
        throw new BadRequestException('กรุณาระบุวันที่เปิดและวันที่ปิดให้ครบถ้วน');
      }

      if (startDate && endDate && startDate >= endDate) {
        throw new BadRequestException('วันที่เปิดต้องน้อยกว่าวันที่ปิด');
      }

      if (updateDto.developmentPlanId) {
        const developmentPlan = await this.developmentPlanRepository.findOne({
          where: { id: updateDto.developmentPlanId },
        });
        if (!developmentPlan) {
          throw new NotFoundException(
            `Development Plan with ID ${updateDto.developmentPlanId} not found`,
          );
        }
        supplement.developmentPlan = developmentPlan;
      }

      if (startDate && endDate) {
        await this.ensureNoDateOverlap(
          supplement.developmentPlan.id,
          startDate,
          endDate,
          supplement.id,
        );
      }

      if (updateDto.isOpen === true && !supplement.isOpen) {
        await this.supplementRepository.update(
          {
            developmentPlan: { id: supplement.developmentPlan.id },
            isOpen: true,
          },
          { isOpen: false },
        );
      }

      // If setting as latest, unset other latest supplements for this development plan
      if (updateDto.isLatest === true && !supplement.isLatest) {
        await this.supplementRepository.update(
          { developmentPlan: { id: supplement.developmentPlan.id }, isLatest: true },
          { isLatest: false },
        );
      }

      if (updateDto.supplementNumber !== undefined) {
        supplement.supplementNumber = updateDto.supplementNumber;
      }

      if (updateDto.description !== undefined) {
        supplement.description = updateDto.description;
      }

      if (updateDto.isLatest !== undefined) {
        supplement.isLatest = updateDto.isLatest;
      }

      if (updateDto.isOpen !== undefined) {
        supplement.isOpen = updateDto.isOpen;
      }

      if (updateDto.startDate !== undefined) {
        supplement.startDate = startDate;
      }

      if (updateDto.endDate !== undefined) {
        supplement.endDate = endDate;
      }

      return await this.supplementRepository.save(supplement);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async softRemove(
    id: string,
    userId: string,
    citizenIdSuffix: string,
  ): Promise<{ message: string }> {
    try {
      const user = await this.usersService.findOne(userId);
      if (!user || !user.citizenId) {
        throw new NotFoundException('User not found or citizen ID is missing');
      }

      const userCitizenIdSuffix = user.citizenId.slice(-6);
      if (userCitizenIdSuffix !== citizenIdSuffix) {
        throw new UnauthorizedException('Citizen ID suffix does not match');
      }

      const supplement = await this.supplementRepository.findOne({ where: { id } });
      if (!supplement) {
        throw new NotFoundException(
          `DevelopmentPlanSupplement with ID ${id} not found`,
        );
      }

      // Wave 110 W110-BE-01 — wrap softRemove + orphan-cleanup cascade
      // in a single transaction so the cascade and the book mutation
      // commit/rollback together (CLAUDE.md §18.2.1 SUPPLEMENT trigger
      // surface; workflow doc Trigger Event 1).
      await this.dataSource.transaction(async (manager) => {
        // CLAUDE.md §15 — Book Lineage Immutability (GLOBAL timeline).
        // Guard runs BEFORE softDelete so the lock is enforced even
        // when the supplement is already non-latest.
        await this.bookLockService.assertDeletable(
          id,
          'development_plan_supplement',
          manager,
        );

        // Wave 110 W110-BE-01 — orphan-cleanup cascade. Runs BEFORE
        // softDelete so the cascade can materialize the candidate set
        // via the live FK.
        await this.orphanCleanupService.cascadeOnBookCancel(
          supplement,
          'SUPPLEMENT',
          manager,
          userId,
        );

        const result = await manager
          .getRepository(DevelopmentPlanSupplement)
          .softDelete(id);
        if (result.affected === 0) {
          throw new NotFoundException(
            `DevelopmentPlanSupplement with ID ${id} not found`,
          );
        }
      });

      this.logger.log(
        `Development plan supplement ${id} soft-deleted by user ${userId}`,
      );
      // Drain post-commit notification buffer (currently log-only — RPG/
      // SPG cleanup is silent per §18.7; PG owner notifications are
      // produced only for PLAN cancel).
      try {
        const buffered =
          this.orphanCleanupService.consumePendingPgNotifications(id);
        if (buffered.length > 0) {
          this.logger.log(
            `[OrphanCleanup-Notify] Supplement ${id} buffered ${buffered.length} PG notifications (no-op for SUPPLEMENT cancel — SPG cleanup is silent per §18.7)`,
          );
        }
      } catch (notifyErr) {
        this.logger.warn(
          `[OrphanCleanup-Notify] Supplement ${id} drain failed: ${(notifyErr as Error).message}`,
        );
      }
      return {
        message: `DevelopmentPlanSupplement with ID ${id} has been soft-removed.`,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async updateOpenState(id: string, isOpen: boolean): Promise<DevelopmentPlanSupplement> {
    try {
      const supplement = await this.supplementRepository.findOne({
        where: { id },
        relations: ['developmentPlan'],
      });

      if (!supplement) {
        throw new NotFoundException(
          `DevelopmentPlanSupplement with ID ${id} not found`,
        );
      }

      // CLAUDE.md §15 — `isOpen` is a field mutation on the supplement
      // row and MUST obey the book-lineage lock. A locked (non-head)
      // supplement cannot be re-opened or closed.
      await this.bookLockService.assertEditable(
        id,
        'development_plan_supplement',
        this.supplementRepository.manager,
      );

      if (isOpen && !supplement.isOpen) {
        await this.supplementRepository.update(
          {
            developmentPlan: { id: supplement.developmentPlan.id },
            isOpen: true,
          },
          { isOpen: false },
        );
      }

      supplement.isOpen = isOpen;
      return await this.supplementRepository.save(supplement);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  private async ensureNoDateOverlap(
    developmentPlanId: string,
    newStartDate: Date,
    newEndDate: Date,
    excludeSupplementId?: string,
  ) {
    const qb = this.supplementRepository
      .createQueryBuilder('supplement')
      .leftJoin('supplement.developmentPlan', 'developmentPlan')
      .where('developmentPlan.id = :developmentPlanId', { developmentPlanId })
      .andWhere('supplement.startDate IS NOT NULL')
      .andWhere('supplement.endDate IS NOT NULL');

    if (excludeSupplementId) {
      qb.andWhere('supplement.id != :excludeSupplementId', { excludeSupplementId });
    }

    const supplements = await qb
      .select(['supplement.id', 'supplement.startDate', 'supplement.endDate'])
      .getMany();

    const hasOverlap = supplements.some((item) => {
      if (!item.startDate || !item.endDate) {
        return false;
      }
      const existingStart = new Date(item.startDate);
      const existingEnd = new Date(item.endDate);
      return newStartDate < existingEnd && newEndDate > existingStart;
    });

    if (hasOverlap) {
      throw new BadRequestException('ช่วงวันที่เปิด-ปิดซ้อนกับเล่มเพิ่มเติมที่มีอยู่');
    }
  }
}

