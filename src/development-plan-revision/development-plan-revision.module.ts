import { Module } from '@nestjs/common';
import { DevelopmentPlanRevisionService } from './development-plan-revision.service';
import { DevelopmentPlanRevisionController } from './development-plan-revision.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DevelopmentPlanRevision } from './entities/development-plan-revision.entity';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';
import { RevisionType } from 'src/revision-type/entities/revision-type.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DevelopmentPlanRevision,
      BudgetPlan,
      RevisionType,
      WorkHistory,
    ]),
  ],
  controllers: [DevelopmentPlanRevisionController],
  providers: [DevelopmentPlanRevisionService],
  exports: [DevelopmentPlanRevisionService],
})
export class DevelopmentPlanRevisionModule {}
