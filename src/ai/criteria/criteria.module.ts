import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';
import { IssueCriteriaRegistryService } from './issue-criteria-registry.service';

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
 * Advisory-only / read-only (§17.2) — this module performs zero writes.
 */
@Module({
  imports: [TypeOrmModule.forFeature([DevelopmentIssue])],
  providers: [IssueCriteriaRegistryService],
  exports: [IssueCriteriaRegistryService],
})
export class CriteriaModule {}
