import { Module } from '@nestjs/common';
import { DevelopmentPlanService } from './development-plan.service';
import { DevelopmentPlanController } from './development-plan.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DevelopmentPlan } from './entities/development-plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { PdfModule } from 'src/pdf/pdf.module';
import { ProjectGroupsModule } from 'src/project-groups/project-groups.module';
import { WebsocketModule } from 'src/websocket/websocket.module';
import { PlanPhase } from 'src/plan-phase/entities/plan-phase.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { UsersModule } from 'src/users/users.module';
import { BookLockModule } from 'src/common/book-lock/book-lock.module';
import { OrphanCleanupModule } from 'src/orphan-cleanup/orphan-cleanup.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DevelopmentPlan,
      WorkHistory,
      PlanPhase,
      ProjectGroup,
      RevisedProjectGroup,
      DevelopmentPlanRevision,
      DevelopmentPlanSupplement,
    ]),
    PdfModule,
    ProjectGroupsModule,
    WebsocketModule,
    UsersModule,
    BookLockModule,
    // Wave 110 W110-BE-01 — DevelopmentPlan softRemove invokes the
    // orphan-cleanup cascade (CLAUDE.md §18.2.1 PLAN trigger surface).
    OrphanCleanupModule,
  ],
  controllers: [DevelopmentPlanController],
  providers: [DevelopmentPlanService],
})
export class DevelopmentPlanModule {}

