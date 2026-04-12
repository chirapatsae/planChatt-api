import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DevelopmentIssue } from './entities/development-issue.entity';
import { DevelopmentIssueService } from './development-issue.service';
import { DevelopmentIssueController } from './development-issue.controller';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { BookLockModule } from 'src/common/book-lock/book-lock.module';
import { ProjectClassificationModule } from 'src/common/project-classification/project-classification.module';

/**
 * DevelopmentIssueModule — CLAUDE.md §16.6
 *
 * Owns the plan-scoped CRUD surface for `DevelopmentIssue`. The module
 * imports:
 *   - BookLockModule for §15 lock enforcement
 *   - ProjectClassificationModule so the service can share the
 *     canonical validator / resolver with project services
 *
 * Registers its own typeorm features plus the referenced entities so
 * the in-use check (PG / RPG / SPG) can run without a circular import.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DevelopmentIssue,
      DevelopmentPlan,
      WorkHistory,
      ProjectGroup,
      RevisedProjectGroup,
      SupplementProjectGroup,
    ]),
    BookLockModule,
    ProjectClassificationModule,
  ],
  controllers: [DevelopmentIssueController],
  providers: [DevelopmentIssueService],
  exports: [DevelopmentIssueService],
})
export class DevelopmentIssueModule {}
