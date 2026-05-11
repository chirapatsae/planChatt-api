import { Module } from '@nestjs/common';
import { ProjectGroupsService } from './project-groups.service';
import { ProjectGroupsController } from './project-groups.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectGroup } from './entities/project-group.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { User } from 'src/users/entities/user.entity';
import { Budget } from 'src/budget/entities/budget.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';
import { PdfOutAuthorityDocument } from 'src/pdf/entities/pdf-out-authority-document.entity';
import { GeoBoundaryService } from 'src/ai/geo-boundary.service';
import { LineageLockModule } from 'src/common/lineage-lock/lineage-lock.module';
import { ProjectClassificationModule } from 'src/common/project-classification/project-classification.module';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';
import { UsersModule } from 'src/users/users.module';
import { WorkHistoryModule } from 'src/work-history/work-history.module';
import { BulkUploadModule } from './bulk-upload/bulk-upload.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ProjectGroup,
      WorkHistory,
      User,
      Budget,
      Strategy,
      Tactic,
      Plan,
      DevelopmentPlan,
      TrackingStatus,
      RevisedProjectGroup,
      DevelopmentPlanRevision,
      Amphoe,
      LocalAdministrativeOrganization,
      PdfOutAuthorityDocument,
      DevelopmentIssue,
    ]),
    LineageLockModule,
    ProjectClassificationModule,
    UsersModule,
    WorkHistoryModule,
    BulkUploadModule,
  ],
  controllers: [ProjectGroupsController],
  providers: [ProjectGroupsService, GeoBoundaryService],
  exports: [ProjectGroupsService, BulkUploadModule],
})
export class ProjectGroupsModule {}
