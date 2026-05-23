import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { IssueCriteriaRegistryService } from './issue-criteria-registry.service';
import { IssueCriteriaTitleUniquenessCheckService } from './issue-criteria-title-uniqueness-check.service';

/**
 * CriteriaModule — Wave 24 N1.
 *
 * Hosts the in-code issue-criteria registry lookup service. Exported so
 * downstream modules (AiModule for N3/N4 prompt injection; the
 * DevelopmentIssueModule for the GET endpoint) can inject without
 * importing the AiModule and pulling its entire dependency graph.
 *
 * Re-registers `DevelopmentIssue` here so the service's repository is
 * DI-resolvable even when consumed outside the DevelopmentIssueModule
 * scope (NestJS requires the feature registration in the module that
 * provides the service).
 *
 * Wave AI-Enforcement-Model (2026-05-22) — added
 * `IssueCriteriaTitleUniquenessCheckService` and registered the
 * `ProjectGroup` repository so the service can run its read-only
 * duplicate-title query without an extra cross-module wire.
 *
 * Advisory-only / read-only (§17.2) — this module performs zero writes.
 */
@Module({
  imports: [TypeOrmModule.forFeature([DevelopmentIssue, ProjectGroup])],
  providers: [
    IssueCriteriaRegistryService,
    IssueCriteriaTitleUniquenessCheckService,
  ],
  exports: [
    IssueCriteriaRegistryService,
    IssueCriteriaTitleUniquenessCheckService,
  ],
})
export class CriteriaModule {}
