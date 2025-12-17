import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlanPhaseService } from './plan-phase.service';
import { PlanPhaseController } from './plan-phase.controller';
import { PlanPhase } from './entities/plan-phase.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([PlanPhase, DevelopmentPlan, WorkHistory]),
  ],
  controllers: [PlanPhaseController],
  providers: [PlanPhaseService],
  exports: [PlanPhaseService],
})
export class PlanPhaseModule {}