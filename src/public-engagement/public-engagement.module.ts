/**
 * Public Engagement Module.
 *
 * Anonymous engagement signals (project likes, project / book views,
 * book downloads) for the public archive surface. Exports
 * `PublicEngagementService` so the existing PDF download handler in
 * `PublicArchiveController` can call `recordDownload(...)` BEFORE
 * streaming, and so future DTO enrichment paths can pull counts.
 *
 * Imports `PublicArchiveModule` for its shared eligibility predicate
 * (`getPublishedPlanIdsPublic`). Imports the three project / plan repos
 * for the eligibility-check JOINs.
 */

import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { PublicArchiveModule } from 'src/public-archive/public-archive.module';

import { EngagementDownloadEvent } from './entities/engagement-download-event.entity';
import { EngagementLike } from './entities/engagement-like.entity';
import { EngagementViewEvent } from './entities/engagement-view-event.entity';
import { PublicEngagementController } from './public-engagement.controller';
import { PublicEngagementService } from './public-engagement.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      EngagementLike,
      EngagementViewEvent,
      EngagementDownloadEvent,
      ProjectGroup,
      RevisedProjectGroup,
      // Wave public-archive-supplement BE-01 — SPG eligibility +
      // like/view denormalized counter reads.
      SupplementProjectGroup,
      DevelopmentPlan,
      DevelopmentPlanRevision,
    ]),
    // `forwardRef` defends against future circular imports — the
    // public archive controller will, in a follow-up edit, call
    // `PublicEngagementService.recordDownload`. The shared `forwardRef`
    // shape keeps the dependency direction explicit.
    forwardRef(() => PublicArchiveModule),
  ],
  controllers: [PublicEngagementController],
  providers: [PublicEngagementService],
  exports: [PublicEngagementService],
})
export class PublicEngagementModule {}
