import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BudgetPlan } from './entities/budget_plan.entity';
import { CreateBudgetPlanDto } from './dto/create-budget_plan.dto';
import { User } from 'src/users/entities/user.entity';

@Injectable()
export class BudgetPlanService {
  private readonly logger = new Logger(BudgetPlanService.name);

  constructor(
    @InjectRepository(BudgetPlan)
    private readonly budgetPlanRepository: Repository<BudgetPlan>,

    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) { }

  async create(dto: CreateBudgetPlanDto, userId: string): Promise<BudgetPlan> {
    try {
      const { name, startYear, endYear } = dto;

      const user = await this.userRepository.findOne({ where: { id: userId } });

      if (!user) {
        this.logger.warn(`User not found: ${userId}`);
        throw new NotFoundException(`User with id ${userId} not found`);
      }

      // 🧠 ดึง budget plan เดิมทั้งหมดของ user
      const existingPlans = await this.budgetPlanRepository.find({
        where: { user: { id: userId } },
      });

      // ❌ เช็กว่า startYear กับ endYear ไม่ซ้ำ exact กับของเดิม
      const isExactDuplicate = existingPlans.some(
        (plan) => plan.startYear === startYear && plan.endYear === endYear,
      );

      if (isExactDuplicate) {
        this.logger.warn(`BudgetPlan with same start and end year already exists`);
        throw new InternalServerErrorException('Start and End year already used in an existing budget plan');
      }

      // ❌ เช็กว่าไม่ overlap
      const isOverlapping = existingPlans.some((plan) => {
        return (
          (startYear >= plan.startYear && startYear <= plan.endYear) ||
          (endYear >= plan.startYear && endYear <= plan.endYear) ||
          (startYear <= plan.startYear && endYear >= plan.endYear)
        );
      });

      if (isOverlapping) {
        this.logger.warn(`BudgetPlan years overlap with existing plans`);
        throw new InternalServerErrorException('The specified budget year range overlaps with an existing plan');
      }

      // 🔁 deactivate ตัวที่ isActive อยู่
      await this.budgetPlanRepository.update(
        { isActive: true },
        { isActive: false },
      );

      // ✅ สร้างใหม่
      const newBudgetPlan = this.budgetPlanRepository.create({
        name,
        startYear,
        endYear,
        isActive: true,
        user,
      });

      const saved = await this.budgetPlanRepository.save(newBudgetPlan);
      this.logger.log(`BudgetPlan created with id: ${saved.id}`);
      return saved;
    } catch (error) {
      this.logger.error(`Failed to create BudgetPlan`, error.stack);
      if (error instanceof NotFoundException || error instanceof InternalServerErrorException) {
        throw error;
      }
      throw new InternalServerErrorException('Unable to create BudgetPlan');
    }
  }


  async findAll(): Promise<BudgetPlan[]> {
    try {
      return await this.budgetPlanRepository.find({
        where: { isActive: true },
        order: { createAt: 'DESC' },
      });
    } catch (error) {
      this.logger.error(`Failed to fetch all BudgetPlans`, error.stack);
      throw new InternalServerErrorException('Unable to fetch BudgetPlans');
    }
  }

  async findOne(id: string): Promise<BudgetPlan> {
    try {
      const budgetPlan = await this.budgetPlanRepository.findOne({
        where: { id },
        relations: ['projectGroup', 'workHistory'],
      });

      if (!budgetPlan) {
        this.logger.warn(`BudgetPlan not found: ${id}`);
        throw new NotFoundException(`BudgetPlan with id ${id} not found`);
      }

      return budgetPlan;
    } catch (error) {
      this.logger.error(`Failed to fetch BudgetPlan with id ${id}`, error.stack);
      throw new InternalServerErrorException('Unable to fetch BudgetPlan');
    }
  }
}
