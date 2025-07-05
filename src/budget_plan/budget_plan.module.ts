import { Module } from '@nestjs/common';
import { BudgetPlanService } from './budget_plan.service';
import { BudgetPlanController } from './budget_plan.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BudgetPlan } from './entities/budget_plan.entity';
import { User } from 'src/users/entities/user.entity';

@Module({
  imports : [TypeOrmModule.forFeature([BudgetPlan , User])], 
  controllers: [BudgetPlanController],
  providers: [BudgetPlanService],
})
export class BudgetPlanModule {}
