import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlanPhaseService } from './plan-phase.service';
import { PlanPhaseController } from './plan-phase.controller';
import { PlanPhase } from './entities/plan-phase.entity';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([PlanPhase, BudgetPlan, WorkHistory]),
  ],
  controllers: [PlanPhaseController],
  providers: [PlanPhaseService],
  exports: [PlanPhaseService],
})
export class PlanPhaseModule {}