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
import { UsersModule } from 'src/users/users.module';
import { Status } from 'src/status/entities/status.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { WorkHistoryModule } from 'src/work-history/work-history.module';
import { BookLockModule } from 'src/common/book-lock/book-lock.module';
import { LineageLockModule } from 'src/common/lineage-lock/lineage-lock.module';
import { AiModule } from 'src/ai/ai.module';
import { SupplementScopeModule } from 'src/common/supplement-scope/supplement-scope.module';

/**
 * SUPP-1 BE-01 — wires the workflow-grade dependencies on top of the
 * existing module surface:
 *   - `WorkHistoryModule` → `WorkHistoryLookupService` (§1, §2)
 *   - `BookLockModule`    → `BookLockService` (§15)
 *   - `LineageLockModule` → `LineageLockService` (§14, vacuous in SUPP-1)
 *   - `AiModule`          → `PreSubmitSnapshotService` (§17.4 baseline)
 *   - `Status` / `TrackingStatus` repositories for resolve-by-name + audit
 */
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
      Status,
      TrackingStatus,
    ]),
    ProjectClassificationModule,
    UsersModule,
    WorkHistoryModule,
    BookLockModule,
    LineageLockModule,
    AiModule,
    SupplementScopeModule,
  ],
  controllers: [SupplementProjectGroupController],
  providers: [SupplementProjectGroupService],
  exports: [SupplementProjectGroupService],
})
export class SupplementProjectGroupModule {}
