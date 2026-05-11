import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BulkUploadValidator } from './bulk-upload.validator';
import { BulkUploadService } from './bulk-upload.service';
import { BulkUploadTemplateService } from './bulk-upload-template.service';
import { BulkUploadController } from './bulk-upload.controller';

import { ProjectGroup } from '../entities/project-group.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';
import { PlanPhase } from 'src/plan-phase/entities/plan-phase.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { Status } from 'src/status/entities/status.entity';
import { Budget } from 'src/budget/entities/budget.entity';

import { ProjectClassificationModule } from 'src/common/project-classification/project-classification.module';
import { BookLockModule } from 'src/common/book-lock/book-lock.module';
import { WorkHistoryModule } from 'src/work-history/work-history.module';
import { GeoBoundaryService } from 'src/ai/geo-boundary.service';
import { AiModule } from 'src/ai/ai.module';

/**
 * BulkUploadModule — CLAUDE.md §19 / W113-BE-VALIDATE / W113-BE-BATCH.
 *
 * Bundles the validator (read-only batch validation), the commit service
 * (transaction-aware writes + post-commit baseline snapshot fan-out), and
 * the controller exposing the two new bulk endpoints:
 *
 *   POST /v1/project-groups/bulk
 *   POST /v1/project-groups/bulk/validate
 *
 * Imports `AiModule` to consume `PreSubmitSnapshotService` (re-exported by
 * AiModule for this purpose) so the per-row §17.4 `no-ai-baseline`
 * snapshot is written through the canonical service. NEVER write to
 * `ai_pre_submit_snapshots` directly from this module.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ProjectGroup,
      Strategy,
      Tactic,
      Plan,
      DevelopmentPlan,
      DevelopmentIssue,
      PlanPhase,
      TrackingStatus,
      Status,
      Budget,
    ]),
    ProjectClassificationModule,
    BookLockModule,
    WorkHistoryModule,
    AiModule,
  ],
  controllers: [BulkUploadController],
  providers: [
    BulkUploadValidator,
    BulkUploadService,
    BulkUploadTemplateService,
    GeoBoundaryService,
  ],
  exports: [BulkUploadValidator, BulkUploadService, BulkUploadTemplateService],
})
export class BulkUploadModule {}
