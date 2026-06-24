/**
 * Public Archive Module — anonymous read access to assembled
 * development plan books.
 *
 * CLEANUP wave BE-02 (2026-05-26) rewrite: the legacy `BookAssemblyModule`
 * + `BookAssemblyVersion` import chain has been replaced with imports of
 * the four standalone subsystems (`MainAssemblyModule`,
 * `EditAssemblyModule`, `ChangeAssemblyModule`, `SupplementAssemblyModule`).
 * The service now reads per-subsystem `*_assembly_versions` tables and
 * dispatches PDF resolution to each subsystem's `getMergedPdfPath` /
 * `getMergedAbsolutePath` helper.
 */

import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { GovernmentAgency } from 'src/government-agencies/entities/government-agency.entity';
import { MainAssemblyVersion } from 'src/main-assembly/entities/main-assembly-version.entity';
import { EditAssemblyVersion } from 'src/edit-assembly/entities/edit-assembly-version.entity';
import { ChangeAssemblyVersion } from 'src/change-assembly/entities/change-assembly-version.entity';
import { SupplementAssemblyVersion } from 'src/supplement-assembly/entities/supplement-assembly-version.entity';
import { MainAssemblyModule } from 'src/main-assembly/main-assembly.module';
import { EditAssemblyModule } from 'src/edit-assembly/edit-assembly.module';
import { ChangeAssemblyModule } from 'src/change-assembly/change-assembly.module';
import { SupplementAssemblyModule } from 'src/supplement-assembly/supplement-assembly.module';
import { PublicEngagementModule } from 'src/public-engagement/public-engagement.module';
import { ProjectGroupsModule } from 'src/project-groups/project-groups.module';

import { PublicArchiveController } from './public-archive.controller';
import { PublicArchiveService } from './public-archive.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MainAssemblyVersion,
      EditAssemblyVersion,
      ChangeAssemblyVersion,
      SupplementAssemblyVersion,
      DevelopmentPlan,
      DevelopmentPlanRevision,
      DevelopmentPlanSupplement,
      ProjectGroup,
      RevisedProjectGroup,
      SupplementProjectGroup,
      Amphoe,
      GovernmentAgency,
    ]),
    // Each standalone subsystem module exports its own service so the
    // public archive can call `getMergedPdfPath` / `getMergedAbsolutePath`
    // for absolute disk path resolution (no auth side-effects).
    MainAssemblyModule,
    EditAssemblyModule,
    ChangeAssemblyModule,
    SupplementAssemblyModule,
    // ProjectGroupsModule exports ProjectGroupsService — the public project
    // map reuses its `buildMapDistrictData` aggregation (Approved-only).
    ProjectGroupsModule,
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
