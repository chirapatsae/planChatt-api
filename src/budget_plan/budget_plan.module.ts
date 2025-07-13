import { Module } from '@nestjs/common';
import { BudgetPlanService } from './budget_plan.service';
import { BudgetPlanController } from './budget_plan.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BudgetPlan } from './entities/budget_plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

@Module({
  imports : [TypeOrmModule.forFeature([BudgetPlan , WorkHistory])], 
  controllers: [BudgetPlanController],
  providers: [BudgetPlanService],
})
export class BudgetPlanModule {}
