import {
  Injectable,
  NotFoundException,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateDevelopmentPlanRevisionDto } from './dto/create-development-plan-revision.dto';
import { UpdateDevelopmentPlanRevisionDto } from './dto/update-development-plan-revision.dto';
import { DevelopmentPlanRevision } from './entities/development-plan-revision.entity';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';
import { RevisionType } from 'src/revision-type/entities/revision-type.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { handleException } from 'src/util/handleException';

@Injectable()
export class DevelopmentPlanRevisionService {
  private readonly logger = new Logger(DevelopmentPlanRevisionService.name);

  constructor(
    @InjectRepository(DevelopmentPlanRevision)
    private readonly revisionRepository: Repository<DevelopmentPlanRevision>,

    @InjectRepository(BudgetPlan)
    private readonly budgetPlanRepository: Repository<BudgetPlan>,

    @InjectRepository(RevisionType)
    private readonly revisionTypeRepository: Repository<RevisionType>,

    @InjectRepository(WorkHistory)
    private readonly workHistoryRepository: Repository<WorkHistory>,
  ) {}

  async create(
    createDto: CreateDevelopmentPlanRevisionDto,
    userId: string,
  ): Promise<DevelopmentPlanRevision> {
    try {
      // Validate date range
      if (createDto.startDate && createDto.endDate) {
        const startDate = new Date(createDto.startDate);
        const endDate = new Date(createDto.endDate);
        
        if (startDate >= endDate) {
          throw new BadRequestException(
            'วันที่เปิดต้องน้อยกว่าวันที่ปิด',
          );
        }
      }

      // Validate relations exist
      const budgetPlan = await this.budgetPlanRepository.findOne({
        where: { id: createDto.budgetPlanId },
      });
      if (!budgetPlan) {
        throw new NotFoundException(
          `Budget Plan with ID ${createDto.budgetPlanId} not found`,
        );
      }

      const revisionType = await this.revisionTypeRepository.findOne({
        where: { id: createDto.revisionTypeId },
      });
      if (!revisionType) {
        throw new NotFoundException(
          `Revision Type with ID ${createDto.revisionTypeId} not found`,
        );
      }

      const workHistory = await this.workHistoryRepository.findOne({
        where: { user: { id: userId } },
      });
      if (!workHistory) {
        throw new NotFoundException('Work history not found for this user');
      }

      // If setting as latest, unset other latest revisions for this budget plan
      if (createDto.isLatest) {
        await this.revisionRepository.update(
          { budgetPlan: { id: createDto.budgetPlanId }, isLatest: true },
          { isLatest: false },
        );
      }

      const revision = this.revisionRepository.create({
        budgetPlan,
        revisionType,
        revisionNumber: createDto.revisionNumber,
        description: createDto.description,
        isLatest: createDto.isLatest ?? false,
        startDate: createDto.startDate ? new Date(createDto.startDate) : null,
        endDate: createDto.endDate ? new Date(createDto.endDate) : null,
        createdBy: workHistory,
      });

      return await this.revisionRepository.save(revision);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll(): Promise<DevelopmentPlanRevision[]> {
    try {
      return await this.revisionRepository.find({
        relations: ['budgetPlan', 'revisionType', 'createdBy'],
        order: { createdAt: 'DESC' },
        where: { isLatest: true },
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<DevelopmentPlanRevision> {
    try {
      const revision = await this.revisionRepository.findOne({
        where: { id },
        relations: ['budgetPlan', 'revisionType', 'createdBy'],
      });

      if (!revision) {
        this.logger.warn(`DevelopmentPlanRevision not found: ${id}`);
        throw new NotFoundException(
          `DevelopmentPlanRevision with id ${id} not found`,
        );
      }

      return revision;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findByBudgetPlan(budgetPlanId: string): Promise<DevelopmentPlanRevision[]> {
    try {
      return await this.revisionRepository.find({
        where: { budgetPlan: { id: budgetPlanId } },
        relations: ['budgetPlan', 'revisionType', 'createdBy'],
        order: { revisionNumber: 'ASC' },
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(
    id: string,
    updateDto: UpdateDevelopmentPlanRevisionDto,
  ): Promise<DevelopmentPlanRevision> {
    try {
      const revision = await this.findOne(id);

      // Validate date range
      const startDate = updateDto.startDate ? new Date(updateDto.startDate) : revision.startDate;
      const endDate = updateDto.endDate ? new Date(updateDto.endDate) : revision.endDate;
      
      if (startDate && endDate && startDate >= endDate) {
        throw new BadRequestException(
          'วันที่เปิดต้องน้อยกว่าวันที่ปิด',
        );
      }

      if (updateDto.budgetPlanId) {
        const budgetPlan = await this.budgetPlanRepository.findOne({
          where: { id: updateDto.budgetPlanId },
        });
        if (!budgetPlan) {
          throw new NotFoundException(
            `Budget Plan with ID ${updateDto.budgetPlanId} not found`,
          );
        }
        revision.budgetPlan = budgetPlan;
      }

      if (updateDto.revisionTypeId) {
        const revisionType = await this.revisionTypeRepository.findOne({
          where: { id: updateDto.revisionTypeId },
        });
        if (!revisionType) {
          throw new NotFoundException(
            `Revision Type with ID ${updateDto.revisionTypeId} not found`,
          );
        }
        revision.revisionType = revisionType;
      }

      // If setting as latest, unset other latest revisions for this budget plan
      if (updateDto.isLatest === true && !revision.isLatest) {
        await this.revisionRepository.update(
          { budgetPlan: { id: revision.budgetPlan.id }, isLatest: true },
          { isLatest: false },
        );
      }

      if (updateDto.revisionNumber !== undefined) {
        revision.revisionNumber = updateDto.revisionNumber;
      }

      if (updateDto.description !== undefined) {
        revision.description = updateDto.description;
      }

      if (updateDto.isLatest !== undefined) {
        revision.isLatest = updateDto.isLatest;
      }

      if (updateDto.startDate !== undefined) {
        revision.startDate = updateDto.startDate ? new Date(updateDto.startDate) : null;
      }

      if (updateDto.endDate !== undefined) {
        revision.endDate = updateDto.endDate ? new Date(updateDto.endDate) : null;
      }

      return await this.revisionRepository.save(revision);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.revisionRepository.delete(id);
      if (result.affected === 0) {
        throw new NotFoundException(
          `DevelopmentPlanRevision with ID ${id} not found`,
        );
      }
      return {
        message: `DevelopmentPlanRevision with ID ${id} has been permanently removed.`,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}
