import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlanPhaseService } from './plan-phase.service';
import { PlanPhaseController } from './plan-phase.controller';
import { PlanPhase } from './entities/plan-phase.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { BookLockModule } from 'src/common/book-lock/book-lock.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([PlanPhase, DevelopmentPlan, WorkHistory]),
    BookLockModule,
  ],
  controllers: [PlanPhaseController],
  providers: [PlanPhaseService],
  exports: [PlanPhaseService],
})
export class PlanPhaseModule {}