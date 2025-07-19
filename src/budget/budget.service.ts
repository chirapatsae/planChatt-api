import {
  Injectable,
  Logger,
  NotFoundException,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindManyOptions, FindOptionsWhere, Repository } from 'typeorm';
import { Budget } from './entities/budget.entity';
import { CreateBudgetDto } from './dto/create-budget.dto';
import { UpdateBudgetDto } from './dto/update-budget.dto';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { handleException } from 'src/util/handleException';

@Injectable()
export class BudgetService {
  private readonly logger = new Logger(BudgetService.name);

  constructor(
    @InjectRepository(Budget)
    private readonly budgetRepo: Repository<Budget>,

    @InjectRepository(ProjectGroup)
    private readonly projectGroupRepo: Repository<ProjectGroup>,
  ) { }

  async create(dto: CreateBudgetDto): Promise<Budget> {
    try {
      this.logger.log(`Creating budget for group ${dto.projectGroupId}`);
      // Find the associated project group and its budget plan
      const projectGroup = await this.projectGroupRepo.findOne({
        where: { id: dto.projectGroupId },
        relations: ['budgetPlanId'],
      });

      if (!projectGroup) throw new NotFoundException(`Project group with ID ${dto.projectGroupId} not found`);
      const plan = projectGroup.budgetPlan;
      if (!plan) throw new BadRequestException(`Project group ${dto.projectGroupId} does not have an associated budget plan.`);

      // Validate that the budget year is within the plan's valid range
      if (dto.year < plan.startYear || dto.year > plan.endYear) {
        throw new BadRequestException(
          `Budget year ${dto.year} is outside the budget plan's range (${plan.startYear} - ${plan.endYear}).`,
        );
      }
      const budget = this.budgetRepo.create({
        ...dto,
        projectGroupId: { id: dto.projectGroupId },
      });

      return await this.budgetRepo.save(budget);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll(groupId?: string): Promise<Budget[]> {
    try {
      const where: FindOptionsWhere<Budget> = {};
      if (groupId) {
        where.projectGroupId = { id: groupId };
      }
      return await this.budgetRepo.find({
        where,
        relations: ['projectGroupId' , 'projectVersionId' , 'budgetPlanId'],
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<Budget> {
    try {
      const budget = await this.budgetRepo.findOne({
        where: { id },
        relations: ['projectGroupId' , 'projectVersionId' , 'budgetPlanId'],
      });

      if (!budget) {
        throw new NotFoundException(`Budget with ID ${id} not found`);
      }
      return budget;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(id: string, dto: UpdateBudgetDto): Promise<Budget> {
    try {
      const { quantity } = dto

      const updateObj: any = { id, quantity };
      const budget = await this.budgetRepo.preload(updateObj);

      if (!budget) {
        throw new NotFoundException(`Budget with ID ${id} not found for update.`);
      }
      return await this.budgetRepo.save(budget);
    } catch (error) {
      handleException(this.logger, error);
    }
  }


  async remove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.budgetRepo.delete(id);

      if (result.affected === 0) {
        throw new NotFoundException(`Budget with ID ${id} not found for removal.`);
      }

      return { message: `Budget with ID ${id} has been removed successfully.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async softRemove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.budgetRepo.softDelete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`budet with ID ${id} not found`);
      }
      return { message: `budet with ID ${id} has been soft-removed.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async restore(id: string): Promise<{ message: string }> {
    try {
      const result = await this.budgetRepo.restore(id);
      if (result.affected === 0) {
        throw new NotFoundException(`budet with ID ${id} not found or was not deleted.`);
      }
      return { message: `budet with ID ${id} has been restored.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}
