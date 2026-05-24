/**
 * Public Archive Module — anonymous read access to assembled
 * development plan books. Imported by AppModule alongside the
 * authenticated BookAssemblyModule (no overlap; this module declares
 * its own controller + service, only borrowing repositories + the
 * `getMergedPdfPath` helper from BookAssemblyService).
 */

import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BookAssemblyVersion } from 'src/book-assembly/entities/book-assembly-version.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { SupplementAssemblyVersion } from 'src/supplement-assembly/entities/supplement-assembly-version.entity';
import { BookAssemblyModule } from 'src/book-assembly/book-assembly.module';
import { SupplementAssemblyModule } from 'src/supplement-assembly/supplement-assembly.module';
import { PublicEngagementModule } from 'src/public-engagement/public-engagement.module';

import { PublicArchiveController } from './public-archive.controller';
import { PublicArchiveService } from './public-archive.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      BookAssemblyVersion,
      DevelopmentPlan,
      DevelopmentPlanRevision,
      // Wave public-archive-supplement BE-01 — supplement subsystem
      // entities. Supplement assembly lives in its OWN parallel table
      // (`docs/supplement-book-domain.md` §9), so the version repo is
      // distinct from `BookAssemblyVersion`.
      DevelopmentPlanSupplement,
      ProjectGroup,
      RevisedProjectGroup,
      SupplementProjectGroup,
      SupplementAssemblyVersion,
    ]),
    // BookAssemblyModule exports BookAssemblyService — we use it for
    // `getMergedPdfPath` only (file resolution; no auth side-effects).
    BookAssemblyModule,
    // SupplementAssemblyModule exports SupplementAssemblyService — we
    // use it for `getMergedAbsolutePath` (supplement PDF file
    // resolution; no auth side-effects). Mirrors the BookAssembly
    // pattern above. No circular dep — SupplementAssemblyModule does
    // NOT import PublicArchiveModule.
    SupplementAssemblyModule,
    // PublicEngagementModule exports PublicEngagementService — the PDF
    // download handler fires `recordDownload(...)` BEFORE streaming.
    // `forwardRef` because PublicEngagementModule itself imports
    // PublicArchiveModule for the shared eligibility predicate.
    forwardRef(() => PublicEngagementModule),
  ],
  controllers: [PublicArchiveController],
  providers: [PublicArchiveService],
  exports: [PublicArchiveService],
})
export class PublicArchiveModule {}
