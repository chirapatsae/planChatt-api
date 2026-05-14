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
// SUPP_PRINT_DB_01 — supplement PDF document entities (Q2 = default
// flavor only; draft + approved). Out-authority (Rejected) variant is
// deferred to SUPP_PRINT_WAVE_B per Q4=B.
import { PdfSupplementDraftDocument } from './entities/pdf-supplement-draft-document.entity';
import { PdfSupplementApprovedDocument } from './entities/pdf-supplement-approved-document.entity';
// SUPP_PRINT_BE_01 — SupplementPdfService needs the supplement-side
// entities (DevelopmentPlanSupplement + SupplementProjectGroup) and
// the BookLockService for §15 finalize gating.
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { SupplementPdfService } from './supplement-pdf.service';
import { BookLockModule } from 'src/common/book-lock/book-lock.module';
import { User } from 'src/users/entities/user.entity';
import { OrphanCleanupModule } from 'src/orphan-cleanup/orphan-cleanup.module';
// SUPP_PRINT_BE_03 — agency-classification gate for user-role
// supplement-PDF reads. SupplementScopeModule bundles the §1 + §2
// scope service; WorkHistoryModule re-exports the lookup helper used
// to load the caller's current WorkHistory before invoking the gate.
import { SupplementScopeModule } from 'src/common/supplement-scope/supplement-scope.module';
import { WorkHistoryModule } from 'src/work-history/work-history.module';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { RolesGuard } from 'src/auth/roles.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DevelopmentPlan,
      DevelopmentPlanRevision,
      ProjectGroup,
      RevisedProjectGroup,
      PdfDevelopmentPlanDraftAgencyDocument,
      PdfRevisionEditDraftDocument,
      PdfRevisionChangeDraftDocument,
      PdfDevelopmentPlanApprovedDocument,
      PdfDevelopmentPlanDraftCoordinateDocument,
      PdfOutAuthorityDocument,
      PdfRevisionEditApprovedDocument,
      PdfRevisionChangeApprovedDocument,
      // SUPP_PRINT_DB_01 — supplement draft + approved PDF documents.
      PdfSupplementDraftDocument,
      PdfSupplementApprovedDocument,
      // SUPP_PRINT_BE_01 — SupplementPdfService needs the book +
      // project entities to load round metadata + approved-row sets
      // inside the finalize transaction.
      DevelopmentPlanSupplement,
      SupplementProjectGroup,
      User,
      // SUPP_PRINT post-SEC_01 hotfix — `WorkStatusApprovedGuard`
      // injects `Repository<WorkHistory>` per `work-status-approved.guard.ts`.
      // Registered at the local module scope so the guard can resolve its
      // dep inside `PdfController`. Entity already in app.module.ts root.
      WorkHistory,
    ]),
    // Wave 110 W110-BE-01 — pdf finalize sites (out-authority + approved
    // plan) invoke orphan-cleanup cascade. CLAUDE.md §18.2.1.
    OrphanCleanupModule,
    // SUPP_PRINT_BE_01 — §15 finalize gate uses BookLockService.
    BookLockModule,
    // SUPP_PRINT_BE_03 — supplement-PDF user-role reads gate on §1
    // agency classification. SupplementScopeService is invoked inline
    // by the controller; WorkHistoryModule provides the lookup helper
    // that resolves the caller's current WorkHistory.
    SupplementScopeModule,
    WorkHistoryModule,
  ],
  controllers: [PdfController],
  providers: [PdfService, SupplementPdfService, RolesGuard],
  exports: [PdfService, SupplementPdfService],
})
export class PdfModule {}
