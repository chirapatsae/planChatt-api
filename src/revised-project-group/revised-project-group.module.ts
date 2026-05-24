import { Module } from '@nestjs/common';
import { RevisedProjectGroupService } from './revised-project-group.service';
import { RevisedProjectGroupController } from './revised-project-group.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RevisedProjectGroup } from './entities/revised-project-group.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Budget } from 'src/budget/entities/budget.entity';
import { LineageLockModule } from 'src/common/lineage-lock/lineage-lock.module';
import { ProjectClassificationModule } from 'src/common/project-classification/project-classification.module';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';
import { UsersModule } from 'src/users/users.module';
// Wave SUPP-4 / BE-01 — SPG repo is consumed by the create-RPG fork path
// to resolve the source SupplementProjectGroup when
// `prevProjectType='supplement'`. Registered via `forFeature` (no service
// injection needed — the existing `SupplementProjectGroupModule` is NOT
// imported, to avoid a circular dependency loop with TrackingStatus +
// AiModule).
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RevisedProjectGroup,
      DevelopmentPlanRevision,
      ProjectGroup,
      DevelopmentPlan,
      Strategy,
      Tactic,
      Plan,
      WorkHistory,
      Budget,
      DevelopmentIssue,
      SupplementProjectGroup,
    ]),
    LineageLockModule,
    ProjectClassificationModule,
    UsersModule,
  ],
  controllers: [RevisedProjectGroupController],
  providers: [RevisedProjectGroupService],
  exports: [RevisedProjectGroupService],
})
export class RevisedProjectGroupModule {}
