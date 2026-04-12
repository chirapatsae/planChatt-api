import { Module } from '@nestjs/common';
import { SupplementProjectGroupService } from './supplement-project-group.service';
import { SupplementProjectGroupController } from './supplement-project-group.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SupplementProjectGroup } from './entities/supplement-project-group.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Budget } from 'src/budget/entities/budget.entity';
import { ProjectClassificationModule } from 'src/common/project-classification/project-classification.module';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SupplementProjectGroup,
      DevelopmentPlanSupplement,
      DevelopmentPlan,
      Strategy,
      Tactic,
      Plan,
      WorkHistory,
      Budget,
      DevelopmentIssue,
    ]),
    ProjectClassificationModule,
  ],
  controllers: [SupplementProjectGroupController],
  providers: [SupplementProjectGroupService],
  exports: [SupplementProjectGroupService],
})
export class SupplementProjectGroupModule {}


