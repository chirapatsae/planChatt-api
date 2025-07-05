import {
  Injectable,
  Logger,
  NotFoundException,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Budget } from './entities/budget.entity';
import { CreateBudgetDto } from './dto/create-budget.dto';
import { UpdateBudgetDto } from './dto/update-budget.dto';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';

@Injectable()
export class BudgetService {
  private readonly logger = new Logger(BudgetService.name);

  constructor(
    @InjectRepository(Budget)
    private readonly budgetRepo: Repository<Budget>,

    @InjectRepository(ProjectGroup)
    private readonly projectGroupRepo : Repository<ProjectGroup>,
  ) {}

  async create(dto: CreateBudgetDto) {
    this.logger.log(`Creating budget for group ${dto.projectGroupId}`);

    try {
      const projectGroup = await this.projectGroupRepo.findOne({
        where: { id: dto.projectGroupId },
        relations: ['budgetPlanId'],
      });


      if (!projectGroup) {
        throw new NotFoundException(`Project group ${dto.projectGroupId} not found`);
      }

      const plan = projectGroup.budgetPlanId;
      if (!plan) {
        throw new BadRequestException(`Project group has no budget plan`);
      }

      if (dto.year < plan.startYear || dto.year > plan.endYear) {
        throw new BadRequestException(
          `Budget year ${dto.year} is outside the range of budget plan (${plan.startYear} - ${plan.endYear})`,
        );
      }

      const budget = this.budgetRepo.create({
        ...dto,
        projectGroup: { id: dto.projectGroupId },
      });

      return await this.budgetRepo.save(budget);
    } catch (error) {
      this.logger.error('Error creating budget', error.stack);

      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }

      throw new InternalServerErrorException('Unexpected error occurred while creating budget');
    }
  }

  async findAll(): Promise<Budget[]> {
    try {
      return await this.budgetRepo.find();
    } catch (error) {
      this.logger.error('Failed to fetch budgets', error.stack);
      throw new InternalServerErrorException('Unable to fetch budgets');
    }
  }

  async findOne(id: string): Promise<Budget> {
    try {
      const budget = await this.budgetRepo.findOne({ where: { id } });
      if (!budget) throw new NotFoundException(`Budget ${id} not found`);
      return budget;
    } catch (error) {
      this.logger.error(`Failed to fetch budget ${id}`, error.stack);
      throw error instanceof NotFoundException
        ? error
        : new InternalServerErrorException('Error fetching budget');
    }
  }

  async update(id: string, dto: UpdateBudgetDto): Promise<Budget> {
    try {
      const budget = await this.findOne(id);
      Object.assign(budget, dto);
      return await this.budgetRepo.save(budget);
    } catch (error) {
      this.logger.error(`Failed to update budget ${id}`, error.stack);
      throw new InternalServerErrorException('Unable to update budget');
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      const budget = await this.findOne(id);
      await this.budgetRepo.remove(budget);
      return { message: `Budget ${id} removed successfully` };
    } catch (error) {
      this.logger.error(`Failed to remove budget ${id}`, error.stack);
      throw new InternalServerErrorException('Unable to remove budget');
    }
  }
}
