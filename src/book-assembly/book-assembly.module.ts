import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BookAssemblyController } from './book-assembly.controller';
import { BookAssemblyService } from './book-assembly.service';
import { BookAssemblyFileService } from './book-assembly-file.service';

import { BookAssemblyDraft } from './entities/book-assembly-draft.entity';
import { BookAssemblyVersion } from './entities/book-assembly-version.entity';
import { DeprecationAuditLog } from './entities/deprecation-audit-log.entity';
import { BookProjectLineage } from './entities/book-project-lineage.entity';

import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { PlanPhase } from 'src/plan-phase/entities/plan-phase.entity';

import { PdfModule } from 'src/pdf/pdf.module';
import { UsersModule } from 'src/users/users.module';
import { WebsocketModule } from 'src/websocket/websocket.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      BookAssemblyDraft,
      BookAssemblyVersion,
      DeprecationAuditLog,
      BookProjectLineage,
      WorkHistory,
      ProjectGroup,
      RevisedProjectGroup,
      DevelopmentPlan,
      DevelopmentPlanRevision,
      PlanPhase,
    ]),
    PdfModule,
    UsersModule,
    WebsocketModule,
  ],
  controllers: [BookAssemblyController],
  providers: [BookAssemblyService, BookAssemblyFileService],
  exports: [BookAssemblyService],
})
export class BookAssemblyModule {}
