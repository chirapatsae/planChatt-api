import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectClassificationValidator } from './project-classification.validator';
import { BookFormatResolver } from './book-format.resolver';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';

/**
 * ProjectClassificationModule — CLAUDE.md §16
 *
 * Exposes the two shared helpers used by every project service:
 *   - `BookFormatResolver` — walks the project → plan chain to return
 *     the owning plan's `reportFormat`
 *   - `ProjectClassificationValidator` — asserts the incoming DTO
 *     satisfies the §16.5 exactly-one-shape invariant
 *
 * Import this module into ProjectGroupsModule, RevisedProjectGroupModule,
 * SupplementProjectGroupModule, DevelopmentPlanModule, DevelopmentIssueModule,
 * and PdfModule. The module has no dependency on any domain service — it
 * only needs the caller's EntityManager — so importing it does not create
 * circular dependencies.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DevelopmentPlan,
      DevelopmentPlanRevision,
      DevelopmentPlanSupplement,
      ProjectGroup,
      RevisedProjectGroup,
      SupplementProjectGroup,
    ]),
  ],
  providers: [ProjectClassificationValidator, BookFormatResolver],
  exports: [ProjectClassificationValidator, BookFormatResolver],
})
export class ProjectClassificationModule {}
