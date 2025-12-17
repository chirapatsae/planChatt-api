import { Module } from '@nestjs/common';
import { PdfService } from './pdf.service';
import { PdfController } from './pdf.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { PdfDevelopmentPlanDraftAgencyDocument } from './entities/pdf-development-plan-draft-agency-document.entity';
import { PdfRevisionEditDraftDocument } from './entities/pdf-revision-edit-draft-document.entity';
import { PdfRevisionChangeDraftDocument } from './entities/pdf-revision-change-draft-document.entity';
import { PdfDevelopmentPlanApprovedDocument } from './entities/pdf-development-plan-approved-document.entity';
import { PdfDevelopmentPlanDraftCoordinateDocument } from './entities/pdf-development-plan-draft-coordinate-document.entity';
import { PdfOutAuthorityDocument } from './entities/pdf-out-authority-document.entity';
import { PdfRevisionEditApprovedDocument } from './entities/pdf-revision-edit-approved-document.entity';
import { PdfRevisionChangeApprovedDocument } from './entities/pdf-revision-change-approved-document.entity';
import { User } from 'src/users/entities/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([DevelopmentPlan, DevelopmentPlanRevision, ProjectGroup, RevisedProjectGroup, PdfDevelopmentPlanDraftAgencyDocument, PdfRevisionEditDraftDocument, PdfRevisionChangeDraftDocument, PdfDevelopmentPlanApprovedDocument, PdfDevelopmentPlanDraftCoordinateDocument, PdfOutAuthorityDocument, PdfRevisionEditApprovedDocument, PdfRevisionChangeApprovedDocument, User])],
  controllers: [PdfController],
  providers: [PdfService],
  exports: [PdfService],
})
export class PdfModule {}
