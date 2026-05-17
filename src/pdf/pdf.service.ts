// ===================================================================
// 📦 1. Imports
// ===================================================================
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { DataSource, Repository, In } from 'typeorm';
import PdfPrinter = require('pdfmake');
import { PDFDocument } from 'pdf-lib';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import * as path from 'path';
import * as Wordcut from 'wordcut';
import * as fs from 'fs';
import { promises as fsp } from 'fs';

// --- Entities ---
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { User } from 'src/users/entities/user.entity';

// --- PDF Entities ---
import { PdfDevelopmentPlanDraftAgencyDocument } from './entities/pdf-development-plan-draft-agency-document.entity';
import { PdfDevelopmentPlanDraftCoordinateDocument } from './entities/pdf-development-plan-draft-coordinate-document.entity';
import { PdfDevelopmentPlanApprovedDocument } from './entities/pdf-development-plan-approved-document.entity';
import { PdfOutAuthorityDocument } from './entities/pdf-out-authority-document.entity';
import { PdfRevisionEditDraftDocument } from './entities/pdf-revision-edit-draft-document.entity';
import { PdfRevisionChangeDraftDocument } from './entities/pdf-revision-change-draft-document.entity';
import { PdfRevisionEditApprovedDocument } from './entities/pdf-revision-edit-approved-document.entity';
import { PdfRevisionChangeApprovedDocument } from './entities/pdf-revision-change-approved-document.entity';

// --- DTOs & Types ---
import { UnifiedProjectMapper } from 'src/project-groups/dto/unified-project-display.dto';
import {
  ReportAggregations,
  StrategySummary,
  PlanSummary,
  PdfReportType,
  IssueSummary,
  IssueBasedReportAggregations,
} from './report.types';

// --- Format Resolver ---
import { ReportFormat } from 'src/development-plan/types/report-format.enum';

// --- Wave 110 W110-BE-01 — orphan-cleanup cascade ---
import { OrphanCleanupService } from 'src/orphan-cleanup/orphan-cleanup.service';

// --- Wave 3 BE-WRITERS — Storage Layout Restructure ---
// `StoragePathService` is the single source of truth for plan-rooted
// storage keys (umbrella §7.1). All writers below persist relative
// keys (NOT absolute paths) to the `file_path` columns.
import { StoragePathService } from 'src/storage/storage-path.service';

// --- Report Generators (STRATEGY_BASED) ---
import { createSummaryPartDocDefinition } from './report-summary.part';
import {
  createProjectDetailPartDocDefinition,
  createGroupCoverPageDocDefinition,
  createGroupDetailDocDefinition
} from './report-project-detail.part';
import {
  createRevisionEditGroupCoverPageDocDefinition,
  createRevisionEditGroupDetailDocDefinition
} from './report-revision-edit-detail.part';
import {
  createRevisionEditGroupDetailDocDefinitionUser
} from './report-revision-edit-detail-user.part';
import { createRevisionEditSummaryPartDocDefinition } from './report-revision-edit-summary.part';

// --- Report Generators (ISSUE_BASED) ---
import { createIssueBasedSummaryPartDocDefinition } from './report-summary-issue-based.part';
import {
  createIssueBasedGroupCoverPageDocDefinition,
  createIssueBasedGroupDetailDocDefinition,
} from './report-project-detail-issue-based.part';
import { createIssueBasedRevisionEditSummaryPartDocDefinition } from './report-revision-edit-summary-issue-based.part';
import {
  createIssueBasedRevisionGroupCoverPageDocDefinition,
  createIssueBasedRevisionGroupDetailDocDefinition,
} from './report-revision-edit-detail-issue-based.part';

type GenerateReportOptions = {
  developmentPlanId?: string;
  reportType?: PdfReportType;
};

@Injectable()
export class PdfService {
  private readonly logger = new Logger(PdfService.name);

  // ===================================================================
  // ⚙️ 2. Constructor
  // ===================================================================
  constructor(
    @InjectRepository(DevelopmentPlan)
    private readonly developmentPlanRepo: Repository<DevelopmentPlan>,
    @InjectRepository(DevelopmentPlanRevision)
    private readonly developmentPlanRevisionRepo: Repository<DevelopmentPlanRevision>,
    @InjectRepository(ProjectGroup)
    private readonly projectGroupRepo: Repository<ProjectGroup>,
    @InjectRepository(RevisedProjectGroup)
    private readonly revisedProjectGroupRepo: Repository<RevisedProjectGroup>,
    @InjectRepository(PdfDevelopmentPlanDraftAgencyDocument)
    private readonly pdfDraftAgencyRepo: Repository<PdfDevelopmentPlanDraftAgencyDocument>,
    @InjectRepository(PdfRevisionEditDraftDocument)
    private readonly pdfRevisionEditDraftRepo: Repository<PdfRevisionEditDraftDocument>,
    @InjectRepository(PdfRevisionChangeDraftDocument)
    private readonly pdfRevisionChangeDraftRepo: Repository<PdfRevisionChangeDraftDocument>,
    @InjectRepository(PdfDevelopmentPlanApprovedDocument)
    private readonly pdfApprovedRepo: Repository<PdfDevelopmentPlanApprovedDocument>,
    @InjectRepository(PdfDevelopmentPlanDraftCoordinateDocument)
    private readonly pdfDevelopmentPlanDraftCoordinateDocumentRepo: Repository<PdfDevelopmentPlanDraftCoordinateDocument>,
    @InjectRepository(PdfOutAuthorityDocument)
    private readonly pdfOutAuthorityRepo: Repository<PdfOutAuthorityDocument>,
    @InjectRepository(PdfRevisionEditApprovedDocument)
    private readonly pdfRevisionEditApprovedRepo: Repository<PdfRevisionEditApprovedDocument>,
    @InjectRepository(PdfRevisionChangeApprovedDocument)
    private readonly pdfRevisionChangeApprovedRepo: Repository<PdfRevisionChangeApprovedDocument>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    // Wave 110 W110-BE-01 — orphan-cleanup cascade for the 3 finalize
    // sites (out-authority @ ~1428, approved-plan loop + bulk @ ~2370/
    // 2376). CLAUDE.md §18.2.1 trigger surfaces.
    @InjectDataSource() private readonly orphanDataSource: DataSource,
    private readonly orphanCleanupService: OrphanCleanupService,
    // Wave 3 BE-WRITERS — every PDF writer below routes through this
    // service to compute the plan-rooted relative key (umbrella §7.1).
    private readonly storagePathService: StoragePathService,
  ) {
    Wordcut.init();
  }

  // -------------------------------------------------------------------
  // Wave 3 BE-WRITERS — filename helper
  // -------------------------------------------------------------------
  /**
   * Compose the leaf filename for a versioned PDF artifact. Pre-Wave 3
   * writers used `${yyyy-mm-dd-hh-mm}-v${N}.pdf` directly; we centralize
   * the format here so all relative keys produced by writers below share
   * a single human-discoverable naming convention.
   */
  private buildVersionedPdfFileName(version: number): string {
    const now = new Date();
    const [datePart, timePart] = now.toISOString().split('T');
    const [year, month, day] = datePart.split('-');
    const [hours, minutes] = timePart.split(':');
    return `${year}-${month}-${day}-${hours}-${minutes}-v${version}.pdf`;
  }

  // ===================================================================
  // 🛠️ 3. Core Utilities (Private)
  // ===================================================================

  /** ตรวจสอบและสร้างโฟลเดอร์ถ้ายังไม่มี */
  private async ensureDirectory(directoryPath: string): Promise<void> {
    await fsp.mkdir(directoryPath, { recursive: true });
  }

  /** หา Development Plan ล่าสุด (ถ้าไม่เจอ throw Error) */
  private async getLatestDevelopmentPlanOrFail(): Promise<DevelopmentPlan> {
    const dp = await this.developmentPlanRepo.findOneBy({ isLatest: true });
    if (!dp) throw new Error('DevelopmentPlan not found');
    return dp;
  }

  // Wave 3 BE-WRITERS — `getDraftBaseDir` / `getDevelopmentPlanDir`
  // helpers (the `path.resolve(__dirname, '../../uploads/pdf')` /
  // `path.join(..., developmentPlanName)` literals — BE-SCAN finding
  // C2 + "Scattered literals") are intentionally removed. Every writer
  // in this file now composes its key via `StoragePathService`
  // (umbrella §7.1 + §7.2). Readers that previously dereferenced these
  // helpers go through `StoragePathService.resolveStored(...)` after
  // BE-READERS lands.

  // --- Font & PDF Helpers ---

  private resolveFontPath(fileName: string): string {
    const candidates = [
      path.resolve(__dirname, '../fonts', fileName),
      path.resolve(process.cwd(), 'src/fonts', fileName),
      path.resolve(process.cwd(), 'fonts', fileName),
      path.resolve(process.cwd(), 'dist/fonts', fileName),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    throw new Error(`Font file not found for ${fileName}`);
  }

  // SUPP_PRINT_BE_01b — promoted from `private` to `public`. Font
  // resolution is shared between main-plan, revision, and supplement
  // PDF renderers.
  public getPdfFonts() {
    return {
      THSarabun: {
        normal: this.resolveFontPath('THSarabun.ttf'),
        bold: this.resolveFontPath('THSarabun Bold.ttf'),
        italics: this.resolveFontPath('THSarabun Italic.ttf'),
        bolditalics: this.resolveFontPath('THSarabun BoldItalic.ttf'),
      },
      Roboto: {
        normal: this.resolveFontPath('Roboto-Regular.ttf'),
        bold: this.resolveFontPath('Roboto-Medium.ttf'),
        italics: this.resolveFontPath('Roboto-Italic.ttf'),
        bolditalics: this.resolveFontPath('Roboto-MediumItalic.ttf'),
      },
    };
  }

  // SUPP_PRINT_BE_01b \u2014 promoted from `private` to `public` so
  // `SupplementPdfService` can reuse the word-cutter without
  // duplicating Wordcut wiring. This is a pure formatting helper with
  // no state; safe to expose.
  public newWord(text: string) {
    const parts = Wordcut.cut(text || '')
      .split('|')
      .map((data: any) => {
        return {
          text: [data, { text: '\u200b', font: 'Roboto' }],
        };
      }).flat();
    return parts;
  }

  // SUPP_PRINT_BE_01b \u2014 promoted from `private` to `public`. Pure
  // font-path resolver consumed by `SupplementPdfService.createPdfBuffer`
  // (via `getPdfFonts`).
  public async createPdfBuffer(docDefinition: TDocumentDefinitions, fonts: any): Promise<Buffer> {
    const printer = new PdfPrinter(fonts);
    const pdfDoc = printer.createPdfKitDocument(docDefinition);
    const chunks: Buffer[] = [];
    return new Promise<Buffer>((resolve, reject) => {
      pdfDoc.on('data', (chunk: Buffer) => chunks.push(chunk));
      pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
      pdfDoc.on('error', (err: Error) => reject(err));
      pdfDoc.end();
    });
  }

  // SUPP_PRINT_BE_01b — promoted from `private` to `public`. Pure
  // pdf-lib merge helper consumed by `SupplementPdfService` to combine
  // Cover + Summary + Detail buffers.
  public async mergePdfBuffers(buffers: Buffer[]): Promise<Buffer> {
    if (buffers.length === 0) throw new Error('No PDF buffers provided for merging');
    if (buffers.length === 1) return buffers[0];
    const mergedPdf = await PDFDocument.create();
    for (const buffer of buffers) {
      const pdf = await PDFDocument.load(buffer);
      const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      copiedPages.forEach(page => mergedPdf.addPage(page));
    }
    const mergedBytes = await mergedPdf.save();
    return Buffer.from(mergedBytes);
  }

  // --- Versioning Helpers ---

  private async getNextVersion(developmentPlanId: string | number): Promise<number> {
    const latest = await this.pdfDraftAgencyRepo.findOne({
      where: { developmentPlanId: String(developmentPlanId) },
      order: { version: 'DESC' }
    });
    return latest ? latest.version + 1 : 1;
  }

  private async getNextApprovedVersion(developmentPlanId: string | number): Promise<number> {
    const latest = await this.pdfApprovedRepo.findOne({
      where: { developmentPlanId: String(developmentPlanId) },
      order: { version: 'DESC' }
    });
    return latest ? latest.version + 1 : 1;
  }

  private async getNextInAuthorityVersion(developmentPlanId: string | number): Promise<number> {
    const latest = await this.pdfDevelopmentPlanDraftCoordinateDocumentRepo.findOne({
      where: { developmentPlanId: String(developmentPlanId) },
      order: { version: 'DESC' }
    });
    return latest ? latest.version + 1 : 1;
  }

  private async getNextOutAuthorityVersion(developmentPlanId: string | number): Promise<number> {
    const latest = await this.pdfOutAuthorityRepo.findOne({
      where: { developmentPlanId: String(developmentPlanId) },
      order: { version: 'DESC' }
    });
    return latest ? latest.version + 1 : 1;
  }

  private async getNextRevisionEditDraftVersion(developmentPlanRevisionId: string | number): Promise<number> {
    const latest = await this.pdfRevisionEditDraftRepo.findOne({
      where: { developmentPlanRevisionId: String(developmentPlanRevisionId) },
      order: { version: 'DESC' }
    });
    return latest ? latest.version + 1 : 1;
  }

  private async getNextRevisionEditApprovedVersion(developmentPlanRevisionId: string | number): Promise<number> {
    const latest = await this.pdfRevisionEditApprovedRepo.findOne({
      where: { developmentPlanRevisionId: String(developmentPlanRevisionId) },
      order: { version: 'DESC' }
    });
    return latest ? latest.version + 1 : 1;
  }

  private async getNextRevisionChangeDraftVersion(developmentPlanRevisionId: string | number): Promise<number> {
    const latest = await this.pdfRevisionChangeDraftRepo.findOne({
      where: { developmentPlanRevisionId: String(developmentPlanRevisionId) },
      order: { version: 'DESC' }
    });
    return latest ? latest.version + 1 : 1;
  }

  private async getNextRevisionChangeApprovedVersion(developmentPlanRevisionId: string | number): Promise<number> {
    const latest = await this.pdfRevisionChangeApprovedRepo.findOne({
      where: { developmentPlanRevisionId: String(developmentPlanRevisionId) },
      order: { version: 'DESC' }
    });
    return latest ? latest.version + 1 : 1;
  }

  // ===================================================================
  // 📊 4. Report Logic & Aggregation (Private)
  // ===================================================================

  // SUPP_PRINT_BE_01b — promoted from `private` to `public` so
  // `SupplementPdfService` can reuse the strategy-tree aggregator for
  // its summary page. Pure function over the supplied rows; no DB
  // access, no mutation of inputs.
  public prepareReportAggregations(projects: any[], years: number[]): ReportAggregations {
    const strategies = new Map<string, StrategySummary>();
    const groupedProjects = new Map<string, any[]>();
    const yearSet = new Set(years);

    for (const project of projects) {
      const strategyName = project.strategy?.name ?? 'ไม่ระบุยุทธศาสตร์';
      const planName = project.plan?.name ?? project.tactic?.name ?? 'ไม่ระบุแผน';

      if (!strategies.has(strategyName)) {
        strategies.set(strategyName, {
          strategyName,
          plans: new Map<string, PlanSummary>(),
          perYearSum: Object.fromEntries(years.map(year => [year, 0])),
          perYearCount: Object.fromEntries(years.map(year => [year, 0])),
        });
      }

      const strategySummary = strategies.get(strategyName)!;
      if (!strategySummary.plans.has(planName)) {
        strategySummary.plans.set(planName, {
          planName,
          perYearSum: Object.fromEntries(years.map(year => [year, 0])),
          perYearCount: Object.fromEntries(years.map(year => [year, 0])),
        });
      }

      const planSummary = strategySummary.plans.get(planName)!;
      for (const budget of project.budgets || []) {
        const year = budget.year;
        const quantity = parseFloat(budget.quantity);
        if (!isNaN(quantity) && yearSet.has(year)) {
          planSummary.perYearSum[year] += quantity;
          planSummary.perYearCount[year] += 1;
          strategySummary.perYearSum[year] += quantity;
          strategySummary.perYearCount[year] += 1;
        }
      }

      const groupKey = `${project.strategy?.name}||${project.tactic?.name}||${project.plan?.name}`;
      if (!groupedProjects.has(groupKey)) {
        groupedProjects.set(groupKey, []);
      }
      groupedProjects.get(groupKey)!.push(project);
    }

    const overallSum = Object.fromEntries(years.map(year => [year, 0]));
    const overallCount = Object.fromEntries(years.map(year => [year, 0]));

    for (const strategySummary of strategies.values()) {
      for (const year of years) {
        overallSum[year] += strategySummary.perYearSum[year];
        overallCount[year] += strategySummary.perYearCount[year];
      }
    }

    return { strategies, overallSum, overallCount, groupedProjects };
  }

  /**
   * ISSUE_BASED aggregation — parallel to prepareReportAggregations.
   * Groups projects by developmentIssue instead of strategy/tactic/plan.
   */
  // SUPP_PRINT_BE_01b — promoted from `private` to `public`. Pure
  // ISSUE_BASED aggregator shared with `SupplementPdfService`.
  public prepareIssueBasedReportAggregations(
    projects: any[],
    years: number[],
  ): IssueBasedReportAggregations {
    const issues = new Map<string, IssueSummary>();
    const groupedProjects = new Map<string, any[]>();
    const yearSet = new Set(years);

    for (const project of projects) {
      const issueName = project.developmentIssue?.name ?? 'ไม่ระบุประเด็น';
      const sortOrder = project.developmentIssue?.sortOrder ?? 999;

      if (!issues.has(issueName)) {
        issues.set(issueName, {
          issueName,
          sortOrder,
          perYearSum: Object.fromEntries(years.map(year => [year, 0])),
          perYearCount: Object.fromEntries(years.map(year => [year, 0])),
        });
      }

      const issueSummary = issues.get(issueName)!;
      for (const budget of project.budgets || []) {
        const year = budget.year;
        const quantity = parseFloat(budget.quantity);
        if (!isNaN(quantity) && yearSet.has(year)) {
          issueSummary.perYearSum[year] += quantity;
          issueSummary.perYearCount[year] += 1;
        }
      }

      if (!groupedProjects.has(issueName)) {
        groupedProjects.set(issueName, []);
      }
      groupedProjects.get(issueName)!.push(project);
    }

    const overallSum = Object.fromEntries(years.map(year => [year, 0]));
    const overallCount = Object.fromEntries(years.map(year => [year, 0]));

    for (const issueSummary of issues.values()) {
      for (const year of years) {
        overallSum[year] += issueSummary.perYearSum[year];
        overallCount[year] += issueSummary.perYearCount[year];
      }
    }

    return { issues, overallSum, overallCount, groupedProjects };
  }

  private async calculateRevisionCountByType(
    developmentPlanId: string,
    revisionTypeName: string,
    currentRevisionNumber: number
  ): Promise<number> {
    const revisions = await this.developmentPlanRevisionRepo
      .createQueryBuilder('dpr')
      .leftJoin('dpr.revisionType', 'rt')
      .where('dpr.development_plan_id = :developmentPlanId', { developmentPlanId })
      .andWhere('rt.name = :revisionTypeName', { revisionTypeName })
      .andWhere('dpr.revision_number <= :currentRevisionNumber', { currentRevisionNumber })
      .getCount();
    return revisions;
  }

  private async findProjectComparisonForRevisionEdit(
    current: RevisedProjectGroup,
    developmentPlanId: string,
  ): Promise<{
    current: any;
    previous: ProjectGroup | RevisedProjectGroup | null;
    oldAdditionDetail?: string | null;
    additionalDetail?: string | null;
  }> {
    let previous: ProjectGroup | RevisedProjectGroup | null = null;

    // W57-DB-01: prevProjectId is `string | null | undefined` after the
    // entity-type tightening. Skip the lookup when missing — a row without
    // a prev pointer has no previous version by definition.
    if (current.prevProjectType === "original" && current.prevProjectId) {
      previous = await this.projectGroupRepo.findOne({
        where: { id: current.prevProjectId },
        relations: [
          'developmentPlan', 'strategy', 'tactic', 'plan', 'developmentIssue', 'createdBy', 'createdBy.user',
          'budgets', 'trackingStatus', 'trackingStatus.statusId', 'trackingStatus.createdBy',
          'trackingStatus.createdBy.user', 'originAgencyId', 'responsibleAgency', 'amphoe',
        ],
      });
    } else if (current.prevProjectType === "revised" && current.prevProjectId) {
      previous = await this.revisedProjectGroupRepo.findOne({
        where: { id: current.prevProjectId },
        relations: [
          'developmentPlanRevision', 'developmentPlanRevision.revisionType', 'developmentPlanRevision.developmentPlan',
          'developmentPlan', 'projectGroup', 'strategy', 'tactic', 'plan', 'developmentIssue', 'createdBy', 'createdBy.user',
          'budgets', 'trackingStatus', 'trackingStatus.statusId', 'trackingStatus.createdBy',
          'trackingStatus.createdBy.user', 'originAgencyId', 'responsibleAgency', 'amphoe',
        ],
      });
    }

    const previousUnified = previous
      ? previous instanceof ProjectGroup
        ? UnifiedProjectMapper.fromProjectGroup(previous)
        : UnifiedProjectMapper.fromRevisedProjectGroup(previous)
      : null;

    return {
      current: UnifiedProjectMapper.fromRevisedProjectGroup(current),
      previous: previousUnified as any,
      oldAdditionDetail: current.oldAdditionDetail,
      additionalDetail: current.additionalDetail,
    };
  }

  // ===================================================================
  // 🔍 5. Data Retrieval Methods (Public & Private)
  // ===================================================================

  async findProjectsByIds(projectIds: string[]): Promise<any[]> {
    if (!projectIds || projectIds.length === 0) return [];

    const originalProjects = await this.projectGroupRepo.createQueryBuilder('projectGroup')
      .leftJoinAndSelect('projectGroup.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('projectGroup.strategy', 'strategy')
      .leftJoinAndSelect('projectGroup.tactic', 'tactic')
      .leftJoinAndSelect('projectGroup.plan', 'plan')
      .leftJoinAndSelect('projectGroup.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('projectGroup.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('projectGroup.budgets', 'budgets')
      .leftJoinAndSelect('projectGroup.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('trackingStatus.comments', 'comments')
      .leftJoinAndSelect('trackingStatus.createdBy', 'workHistory')
      .leftJoinAndSelect('workHistory.user', 'user')
      .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganizationWorkHistory')
      .leftJoinAndSelect('workHistory.governmentAgencies', 'governmentAgencies')
      .leftJoinAndSelect('workHistory.workStatus', 'workStatus')
      .leftJoinAndSelect('projectGroup.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('projectGroup.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .where('projectGroup.id IN (:...ids)', { ids: projectIds })
      .orderBy('strategy.id', 'ASC')
      .getMany();

    const revisedProjects = await this.revisedProjectGroupRepo.createQueryBuilder('revisedProject')
      .leftJoinAndSelect('revisedProject.developmentPlanRevision', 'developmentPlanRevision')
      .leftJoinAndSelect('developmentPlanRevision.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('developmentPlanRevision.revisionType', 'revisionType')
      .leftJoinAndSelect('revisedProject.projectGroup', 'originalProject')
      .leftJoinAndSelect('revisedProject.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('revisedProject.strategy', 'strategy')
      .leftJoinAndSelect('revisedProject.tactic', 'tactic')
      .leftJoinAndSelect('revisedProject.plan', 'plan')
      .leftJoinAndSelect('revisedProject.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('revisedProject.budgets', 'budgets')
      .leftJoinAndSelect('revisedProject.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('trackingStatus.comments', 'comments')
      .leftJoinAndSelect('trackingStatus.createdBy', 'workHistory')
      .leftJoinAndSelect('workHistory.user', 'user')
      .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganizationWorkHistory')
      .leftJoinAndSelect('workHistory.governmentAgencies', 'governmentAgencies')
      .leftJoinAndSelect('workHistory.workStatus', 'workStatus')
      .leftJoinAndSelect('revisedProject.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('revisedProject.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .where('revisedProject.id IN (:...ids)', { ids: projectIds })
      .orderBy('strategy.id', 'ASC')
      .getMany();

    const allProjects = [
      ...originalProjects.map(p => UnifiedProjectMapper.fromProjectGroup(p)),
      ...revisedProjects.map(p => UnifiedProjectMapper.fromRevisedProjectGroup(p)),
    ];

    const projectMap = new Map(allProjects.map(p => [p.id, p]));
    return projectIds.map(id => projectMap.get(id)).filter(p => p !== undefined);
  }

  async findRevisedProjectsByIds(projectRevisionIds: string[]): Promise<RevisedProjectGroup[]> {
    if (!projectRevisionIds || projectRevisionIds.length === 0) return [];

    return await this.revisedProjectGroupRepo.createQueryBuilder('revisedProject')
      .leftJoinAndSelect('revisedProject.developmentPlanRevision', 'developmentPlanRevision')
      .leftJoinAndSelect('developmentPlanRevision.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('developmentPlanRevision.revisionType', 'revisionType')
      .leftJoinAndSelect('revisedProject.projectGroup', 'projectGroup')
      .leftJoinAndSelect('revisedProject.strategy', 'strategy')
      .leftJoinAndSelect('revisedProject.tactic', 'tactic')
      .leftJoinAndSelect('revisedProject.plan', 'plan')
      .leftJoinAndSelect('revisedProject.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('revisedProject.budgets', 'budgets')
      .leftJoinAndSelect('revisedProject.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('revisedProject.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .leftJoinAndSelect('revisedProject.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('revisedProject.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .where('revisedProject.id IN (:...ids)', { ids: projectRevisionIds })
      .orderBy('strategy.id', 'ASC')
      .getMany();
  }

  private async findProjectsForDraftAgency(developmentPlanId: string): Promise<any[]> {
    const projects = await this.projectGroupRepo.createQueryBuilder('projectGroup')
      .leftJoinAndSelect('projectGroup.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('projectGroup.strategy', 'strategy')
      .leftJoinAndSelect('projectGroup.tactic', 'tactic')
      .leftJoinAndSelect('projectGroup.plan', 'plan')
      .leftJoinAndSelect('projectGroup.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('projectGroup.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('projectGroup.budgets', 'budgets')
      .leftJoinAndSelect('projectGroup.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('trackingStatus.comments', 'comments')
      .leftJoinAndSelect('trackingStatus.createdBy', 'workHistory')
      .leftJoinAndSelect('workHistory.user', 'user')
      .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganizationWorkHistory')
      .leftJoinAndSelect('workHistory.governmentAgencies', 'governmentAgencies')
      .leftJoinAndSelect('workHistory.workStatus', 'workStatus')
      .leftJoinAndSelect('projectGroup.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('projectGroup.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('projectGroup.amphoe', 'originAgencyAmphoe')
      .leftJoinAndSelect('projectGroup.favorites', 'favorites')
      .leftJoinAndSelect('favorites.userId', 'userId')
      .where('projectGroup.developmentPlan.id = :developmentPlanId', { developmentPlanId })
      .andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('projectGroup.isBooked = :isBooked', { isBooked: false })
      .andWhere('status.name IN (:...statusNames)', { statusNames: ['Pending_Approval', 'Approved'] })
      .andWhere('projectGroup.originAgencyId IS NULL')
      .andWhere('projectGroup.responsibleAgency IS NOT NULL')
      .orderBy('strategy.id', 'ASC')
      .getMany();

    return projects.map(p => UnifiedProjectMapper.fromProjectGroup(p));
  }

  private async findProjectsForInAuthority(developmentPlanId: string): Promise<any[]> {
    const projects = await this.projectGroupRepo.createQueryBuilder('projectGroup')
      .leftJoinAndSelect('projectGroup.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('projectGroup.strategy', 'strategy')
      .leftJoinAndSelect('projectGroup.tactic', 'tactic')
      .leftJoinAndSelect('projectGroup.plan', 'plan')
      .leftJoinAndSelect('projectGroup.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('projectGroup.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('projectGroup.budgets', 'budgets')
      .leftJoinAndSelect('projectGroup.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('trackingStatus.comments', 'comments')
      .leftJoinAndSelect('trackingStatus.createdBy', 'workHistory')
      .leftJoinAndSelect('workHistory.user', 'user')
      .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganizationWorkHistory')
      .leftJoinAndSelect('workHistory.governmentAgencies', 'governmentAgencies')
      .leftJoinAndSelect('workHistory.workStatus', 'workStatus')
      .leftJoinAndSelect('projectGroup.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('projectGroup.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .leftJoinAndSelect('projectGroup.favorites', 'favorites')
      .leftJoinAndSelect('favorites.userId', 'userId')
      .where('projectGroup.developmentPlan.id = :developmentPlanId', { developmentPlanId })
      .andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('projectGroup.isBooked = :isBooked', { isBooked: false })
      .andWhere('status.name IN (:...statusNames)', { statusNames: ['Pending_Approval', 'Approved'] })
      .andWhere('projectGroup.originAgencyId IS NOT NULL')
      .orderBy('strategy.id', 'ASC')
      .getMany();

    return projects.map(p => UnifiedProjectMapper.fromProjectGroup(p));
  }

  async findProjectsForOutAuthority(developmentPlanId: string): Promise<any[]> {
    const projects = await this.projectGroupRepo.createQueryBuilder('projectGroup')
      .leftJoinAndSelect('projectGroup.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('projectGroup.strategy', 'strategy')
      .leftJoinAndSelect('projectGroup.tactic', 'tactic')
      .leftJoinAndSelect('projectGroup.plan', 'plan')
      .leftJoinAndSelect('projectGroup.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('projectGroup.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('projectGroup.budgets', 'budgets')
      .leftJoinAndSelect('projectGroup.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('trackingStatus.comments', 'comments')
      .leftJoinAndSelect('trackingStatus.createdBy', 'workHistory')
      .leftJoinAndSelect('workHistory.user', 'user')
      .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganizationWorkHistory')
      .leftJoinAndSelect('workHistory.governmentAgencies', 'governmentAgencies')
      .leftJoinAndSelect('workHistory.workStatus', 'workStatus')
      .leftJoinAndSelect('projectGroup.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('projectGroup.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .leftJoinAndSelect('projectGroup.favorites', 'favorites')
      .leftJoinAndSelect('favorites.userId', 'userId')
      .where('developmentPlan.id = :developmentPlanId', { developmentPlanId })
      .andWhere('developmentPlan.isBooked = :isBooked', { isBooked: false })
      .andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :statusName', { statusName: 'Rejected' })
      .andWhere('projectGroup.originAgencyId IS NOT NULL')
      .andWhere('projectGroup.responsibleAgency IS NULL')
      .orderBy('strategy.id', 'ASC')
      .getMany();

    return projects.map(p => UnifiedProjectMapper.fromProjectGroup(p));
  }

  private async findProjectsForRevisionEditDraft(developmentPlanRevisionId: string): Promise<RevisedProjectGroup[]> {
    const projects = await this.revisedProjectGroupRepo.createQueryBuilder('revisedProject')
      .leftJoinAndSelect('revisedProject.developmentPlanRevision', 'developmentPlanRevision')
      .leftJoinAndSelect('developmentPlanRevision.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('developmentPlanRevision.revisionType', 'revisionType')
      .leftJoinAndSelect('revisedProject.projectGroup', 'projectGroup')
      .leftJoinAndSelect('revisedProject.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('revisedProject.amphoe', 'amphoe')
      .leftJoinAndSelect('revisedProject.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('revisedProject.strategy', 'strategy')
      .leftJoinAndSelect('revisedProject.tactic', 'tactic')
      .leftJoinAndSelect('revisedProject.plan', 'plan')
      .leftJoinAndSelect('revisedProject.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('revisedProject.developmentPlan', 'revisedDevelopmentPlan')
      .leftJoinAndSelect('revisedProject.budgets', 'budgets')
      .leftJoinAndSelect('revisedProject.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('trackingStatus.comments', 'comments')
      .leftJoinAndSelect('trackingStatus.createdBy', 'workHistory')
      .leftJoinAndSelect('workHistory.user', 'user')
      .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganizationWorkHistory')
      .leftJoinAndSelect('workHistory.governmentAgencies', 'governmentAgencies')
      .leftJoinAndSelect('workHistory.workStatus', 'workStatus')
      .leftJoinAndSelect('revisedProject.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('revisedProject.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .where('developmentPlanRevision.id = :developmentPlanRevisionId', { developmentPlanRevisionId })
      .andWhere('revisionType.name = :revisionTypeName', { revisionTypeName: 'แก้ไข' })
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name IN (:...statusNames)', { statusNames: ['Pending_Approval', 'Approved'] })
      .orderBy('strategy.id', 'ASC')
      .getMany();

    return projects;
  }

  private async findProjectsForRevisionChangeDraft(developmentPlanRevisionId: string): Promise<any[]> {
    const projects = await this.revisedProjectGroupRepo.createQueryBuilder('revisedProject')
      .leftJoinAndSelect('revisedProject.developmentPlanRevision', 'developmentPlanRevision')
      .leftJoinAndSelect('developmentPlanRevision.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('developmentPlanRevision.revisionType', 'revisionType')
      .leftJoinAndSelect('revisedProject.projectGroup', 'projectGroup')
      .leftJoinAndSelect('revisedProject.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('revisedProject.amphoe', 'amphoe')
      .leftJoinAndSelect('revisedProject.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('revisedProject.strategy', 'strategy')
      .leftJoinAndSelect('revisedProject.tactic', 'tactic')
      .leftJoinAndSelect('revisedProject.plan', 'plan')
      .leftJoinAndSelect('revisedProject.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('revisedProject.developmentPlan', 'revisedDevelopmentPlan')
      .leftJoinAndSelect('revisedProject.budgets', 'budgets')
      .leftJoinAndSelect('revisedProject.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('trackingStatus.comments', 'comments')
      .leftJoinAndSelect('trackingStatus.createdBy', 'workHistory')
      .leftJoinAndSelect('workHistory.user', 'user')
      .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganizationWorkHistory')
      .leftJoinAndSelect('workHistory.governmentAgencies', 'governmentAgencies')
      .leftJoinAndSelect('workHistory.workStatus', 'workStatus')
      .leftJoinAndSelect('revisedProject.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('revisedProject.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .where('developmentPlanRevision.id = :developmentPlanRevisionId', { developmentPlanRevisionId })
      .andWhere('revisionType.name = :revisionTypeName', { revisionTypeName: 'เปลี่ยนแปลง' })
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name IN (:...statusNames)', { statusNames: ['Pending_Approval', 'Approved'] })
      .orderBy('strategy.id', 'ASC')
      .getMany();

    return projects.map(p => UnifiedProjectMapper.fromRevisedProjectGroup(p));
  }

  // ===================================================================
  // 📄 6. General PDF Generation (Public)
  // ===================================================================

  async generateProjectReport(projects: any[], options?: GenerateReportOptions): Promise<Buffer> {
    return this.generateProjectReportWithColumns(projects, [
      'index', 'title', 'objective', 'target', 'budget', 'expectedResult', 'mainAgency'
    ], options);
  }

  async generateProjectReportWithColumns(
    projects: any[],
    selectedColumns: string[],
    options?: GenerateReportOptions,
  ): Promise<Buffer> {
    const developmentPlanId = options?.developmentPlanId;
    const reportType = options?.reportType ?? 'default';

    const dp = developmentPlanId
      ? await this.developmentPlanRepo.findOne({ where: { id: developmentPlanId } })
      : await this.developmentPlanRepo.findOneBy({ isLatest: true });
    if (!dp) throw new Error('DevelopmentPlan not found');
    const developmentPlanName = dp?.name ?? 'ไม่พบแผนพัฒนาจังหวัด';

    // Resolve reportFormat from the plan
    const reportFormat = dp.reportFormat ?? ReportFormat.STRATEGY_BASED;

    const columnMap: Record<string, { text: string; key: string }> = {
      index: { text: 'ที่', key: 'index' },
      title: { text: 'โครงการ', key: 'title' },
      objective: { text: 'วัตถุประสงค์', key: 'objective' },
      target: { text: 'เป้าหมาย \n(ผลผลิตของโครงการ)', key: 'target' },
      budget: { text: 'งบประมาณ (บาท)', key: 'budget' },
      kpi: { text: 'ตัวชี้วัด (KPI)', key: 'kpi' },
      expectedResult: { text: 'ผลที่คาดว่าจะได้รับ', key: 'expectedResult' },
      mainAgency: { text: 'หน่วยงาน\nรับผิดชอบหลัก', key: 'mainAgency' },
      amphoe: { text: 'อำเภอ', key: 'amphoe' },
      coordinates: { text: 'พิกัดทาง \nภูมิศาสตร์', key: 'coordinates' },
    };

    const baseFilteredColumns = selectedColumns.filter(col => columnMap[col] && col !== 'amphoe' && col !== 'coordinates');
    const availableColumns = reportFormat === ReportFormat.ISSUE_BASED
      ? baseFilteredColumns.filter(col => col !== 'kpi')
      : baseFilteredColumns;
    const fonts = this.getPdfFonts();
    const years = Array.from({ length: dp.endYear - dp.startYear + 1 }, (_, index) => dp.startYear + index);

    const pageMargins: [number, number, number, number] = [15, 60, 15, 40];
    const pageOrientation: 'portrait' | 'landscape' = 'landscape';

    const pdfBuffers: Buffer[] = [];
    let pageOffset = 0;

    if (reportFormat === ReportFormat.ISSUE_BASED) {
      // --- ISSUE_BASED path ---
      const { issues, overallSum, overallCount, groupedProjects } = this.prepareIssueBasedReportAggregations(projects, years);

      let coverSummaryDoc: TDocumentDefinitions | null = null;
      if (reportType !== 'outAuthority') {
        coverSummaryDoc = createIssueBasedSummaryPartDocDefinition({
          developmentPlanName, years, issues, overallSum, overallCount,
          pageMargins, pageOrientation, newWord: this.newWord.bind(this),
        });
      }

      if (coverSummaryDoc) {
        const summaryBuffer = await this.createPdfBuffer(coverSummaryDoc, fonts);
        pdfBuffers.push(summaryBuffer);
        const summaryPdf = await PDFDocument.load(summaryBuffer);
        pageOffset += summaryPdf.getPageCount();
      }

      // Sort issue groups by sortOrder
      const sortedIssueEntries = [...groupedProjects.entries()].sort((a, b) => {
        const sortA = issues.get(a[0])?.sortOrder ?? 999;
        const sortB = issues.get(b[0])?.sortOrder ?? 999;
        return sortA - sortB;
      });

      for (const [issueName, issueProjects] of sortedIssueEntries) {
        const coverPageDoc = createIssueBasedGroupCoverPageDocDefinition(
          issueName, developmentPlanName, pageMargins, pageOrientation,
          this.newWord.bind(this), pageOffset,
        );
        const coverPageBuffer = await this.createPdfBuffer(coverPageDoc, fonts);
        pdfBuffers.push(coverPageBuffer);
        const coverPagePdf = await PDFDocument.load(coverPageBuffer);
        pageOffset += coverPagePdf.getPageCount();

        const detailDoc = createIssueBasedGroupDetailDocDefinition({
          developmentPlanName, years, groupProjects: issueProjects, availableColumns, columnMap,
          pageMargins, pageOrientation, newWord: this.newWord.bind(this),
          reportType, issueName, pageOffset,
        });

        if (detailDoc) {
          const detailBuffer = await this.createPdfBuffer(detailDoc, fonts);
          pdfBuffers.push(detailBuffer);
          const detailPdf = await PDFDocument.load(detailBuffer);
          pageOffset += detailPdf.getPageCount();
        }
      }
    } else {
      // --- STRATEGY_BASED path (existing logic) ---
      const { strategies, overallSum, overallCount, groupedProjects } = this.prepareReportAggregations(projects, years);

      let coverSummaryDoc: TDocumentDefinitions | null = null;
      if (reportType !== 'outAuthority') {
        coverSummaryDoc = createSummaryPartDocDefinition({
          developmentPlanName, years, strategies, overallSum, overallCount,
          pageMargins, pageOrientation, newWord: this.newWord.bind(this),
        });
      }

      if (coverSummaryDoc) {
        const summaryBuffer = await this.createPdfBuffer(coverSummaryDoc, fonts);
        pdfBuffers.push(summaryBuffer);
        const summaryPdf = await PDFDocument.load(summaryBuffer);
        pageOffset += summaryPdf.getPageCount();
      }

      const strategyGroups = new Map<string, Array<{ groupKey: string, projects: any[] }>>();
      for (const [groupKey, groupProjectsValue] of groupedProjects.entries()) {
        const [strategyName] = groupKey.split('||');
        if (!strategyGroups.has(strategyName)) strategyGroups.set(strategyName, []);
        strategyGroups.get(strategyName)!.push({ groupKey, projects: groupProjectsValue });
      }

      for (const [strategyName, subGroups] of strategyGroups.entries()) {
        const coverPageDoc = createGroupCoverPageDocDefinition(
          strategyName, developmentPlanName, pageMargins, pageOrientation,
          this.newWord.bind(this), pageOffset,
        );
        const coverPageBuffer = await this.createPdfBuffer(coverPageDoc, fonts);
        pdfBuffers.push(coverPageBuffer);
        const coverPagePdf = await PDFDocument.load(coverPageBuffer);
        pageOffset += coverPagePdf.getPageCount();

        for (const group of subGroups) {
          const { groupKey, projects: groupProjectsValue } = group;
          const [, tacticName, planName] = groupKey.split('||');
          const detailDoc = createGroupDetailDocDefinition({
            developmentPlanName, years, groupProjects: groupProjectsValue, availableColumns, columnMap,
            pageMargins, pageOrientation, newWord: this.newWord.bind(this),
            reportType, strategyName, tacticName, planName, pageOffset,
          });

          if (detailDoc) {
            const detailBuffer = await this.createPdfBuffer(detailDoc, fonts);
            pdfBuffers.push(detailBuffer);
            const detailPdf = await PDFDocument.load(detailBuffer);
            pageOffset += detailPdf.getPageCount();
          }
        }
      }
    }

    if (pdfBuffers.length === 0) throw new Error('No PDF documents could be generated');
    return this.mergePdfBuffers(pdfBuffers);
  }

  async generateProjectReportWithPageTracking(
    projects: any[],
    selectedColumns: string[],
    options?: GenerateReportOptions,
  ): Promise<{ buffer: Buffer; pageMap: Map<string, number> }> {
    const developmentPlanId = options?.developmentPlanId;
    const reportType = options?.reportType ?? 'default';

    const dp = developmentPlanId
      ? await this.developmentPlanRepo.findOne({ where: { id: developmentPlanId } })
      : await this.developmentPlanRepo.findOneBy({ isLatest: true });
    if (!dp) throw new Error('DevelopmentPlan not found');
    const developmentPlanName = dp?.name ?? 'ไม่พบแผนพัฒนาจังหวัด';

    // Resolve reportFormat from the plan
    const reportFormat = dp.reportFormat ?? ReportFormat.STRATEGY_BASED;

    const columnMap: Record<string, { text: string; key: string }> = {
      index: { text: 'ที่', key: 'index' },
      title: { text: 'โครงการ', key: 'title' },
      objective: { text: 'วัตถุประสงค์', key: 'objective' },
      target: { text: 'เป้าหมาย \n(ผลผลิตของโครงการ)', key: 'target' },
      budget: { text: 'งบประมาณ (บาท)', key: 'budget' },
      kpi: { text: 'ตัวชี้วัด (KPI)', key: 'kpi' },
      expectedResult: { text: 'ผลที่คาดว่าจะได้รับ', key: 'expectedResult' },
      mainAgency: { text: 'หน่วยงาน\nรับผิดชอบหลัก', key: 'mainAgency' },
      amphoe: { text: 'อำเภอ', key: 'amphoe' },
      coordinates: { text: 'พิกัดทาง \nภูมิศาสตร์', key: 'coordinates' },
    };

    const baseFilteredColumns = selectedColumns.filter(col => columnMap[col] && col !== 'amphoe' && col !== 'coordinates');
    const availableColumns = reportFormat === ReportFormat.ISSUE_BASED
      ? baseFilteredColumns.filter(col => col !== 'kpi')
      : baseFilteredColumns;
    const fonts = this.getPdfFonts();
    const years = Array.from({ length: dp.endYear - dp.startYear + 1 }, (_, index) => dp.startYear + index);

    const pageMargins: [number, number, number, number] = [15, 60, 15, 40];
    const pageOrientation: 'portrait' | 'landscape' = 'landscape';

    const pdfBuffers: Buffer[] = [];
    const pageMap = new Map<string, number>();
    let pageOffset = 0;

    if (reportFormat === ReportFormat.ISSUE_BASED) {
      // --- ISSUE_BASED path with page tracking ---
      const { issues, overallSum, overallCount, groupedProjects } = this.prepareIssueBasedReportAggregations(projects, years);

      let coverSummaryDoc: TDocumentDefinitions | null = null;
      if (reportType !== 'outAuthority') {
        coverSummaryDoc = createIssueBasedSummaryPartDocDefinition({
          developmentPlanName, years, issues, overallSum, overallCount,
          pageMargins, pageOrientation, newWord: this.newWord.bind(this),
        });
      }

      if (coverSummaryDoc) {
        const summaryBuffer = await this.createPdfBuffer(coverSummaryDoc, fonts);
        pdfBuffers.push(summaryBuffer);
        const summaryPdf = await PDFDocument.load(summaryBuffer);
        pageOffset += summaryPdf.getPageCount();
      }

      const sortedIssueEntries = [...groupedProjects.entries()].sort((a, b) => {
        const sortA = issues.get(a[0])?.sortOrder ?? 999;
        const sortB = issues.get(b[0])?.sortOrder ?? 999;
        return sortA - sortB;
      });

      for (const [issueName, issueProjects] of sortedIssueEntries) {
        const coverPageDoc = createIssueBasedGroupCoverPageDocDefinition(
          issueName, developmentPlanName, pageMargins, pageOrientation,
          this.newWord.bind(this), pageOffset,
        );
        const coverPageBuffer = await this.createPdfBuffer(coverPageDoc, fonts);
        pdfBuffers.push(coverPageBuffer);
        const coverPagePdf = await PDFDocument.load(coverPageBuffer);
        pageOffset += coverPagePdf.getPageCount();

        for (const project of issueProjects) {
          const projectDetailDoc = createIssueBasedGroupDetailDocDefinition({
            developmentPlanName, years, groupProjects: [project], availableColumns, columnMap,
            pageMargins, pageOrientation, newWord: this.newWord.bind(this),
            reportType, issueName, pageOffset,
          });

          if (projectDetailDoc) {
            const projectBuffer = await this.createPdfBuffer(projectDetailDoc, fonts);
            pdfBuffers.push(projectBuffer);
            const projectPdf = await PDFDocument.load(projectBuffer);

            pageMap.set(project.id, pageOffset + 1);
            pageOffset += projectPdf.getPageCount();
          }
        }
      }
    } else {
      // --- STRATEGY_BASED path (existing logic) ---
      const { strategies, overallSum, overallCount, groupedProjects } = this.prepareReportAggregations(projects, years);

      let coverSummaryDoc: TDocumentDefinitions | null = null;
      if (reportType !== 'outAuthority') {
        coverSummaryDoc = createSummaryPartDocDefinition({
          developmentPlanName, years, strategies, overallSum, overallCount,
          pageMargins, pageOrientation, newWord: this.newWord.bind(this),
        });
      }

      if (coverSummaryDoc) {
        const summaryBuffer = await this.createPdfBuffer(coverSummaryDoc, fonts);
        pdfBuffers.push(summaryBuffer);
        const summaryPdf = await PDFDocument.load(summaryBuffer);
        pageOffset += summaryPdf.getPageCount();
      }

      const strategyGroups = new Map<string, Array<{ groupKey: string, projects: any[] }>>();
      for (const [groupKey, groupProjectsValue] of groupedProjects.entries()) {
        const [strategyName] = groupKey.split('||');
        if (!strategyGroups.has(strategyName)) strategyGroups.set(strategyName, []);
        strategyGroups.get(strategyName)!.push({ groupKey, projects: groupProjectsValue });
      }

      for (const [strategyName, subGroups] of strategyGroups.entries()) {
        const coverPageDoc = createGroupCoverPageDocDefinition(
          strategyName, developmentPlanName, pageMargins, pageOrientation,
          this.newWord.bind(this), pageOffset,
        );
        const coverPageBuffer = await this.createPdfBuffer(coverPageDoc, fonts);
        pdfBuffers.push(coverPageBuffer);
        const coverPagePdf = await PDFDocument.load(coverPageBuffer);
        pageOffset += coverPagePdf.getPageCount();

        for (const group of subGroups) {
          const { groupKey, projects: groupProjectsValue } = group;
          const [, tacticName, planName] = groupKey.split('||');

          for (const project of groupProjectsValue) {
            const projectDetailDoc = createGroupDetailDocDefinition({
              developmentPlanName, years, groupProjects: [project], availableColumns, columnMap,
              pageMargins, pageOrientation, newWord: this.newWord.bind(this),
              reportType, strategyName, tacticName, planName, pageOffset,
            });

            if (projectDetailDoc) {
              const projectBuffer = await this.createPdfBuffer(projectDetailDoc, fonts);
              pdfBuffers.push(projectBuffer);
              const projectPdf = await PDFDocument.load(projectBuffer);

              pageMap.set(project.id, pageOffset + 1);
              pageOffset += projectPdf.getPageCount();
            }
          }
        }
      }
    }

    if (pdfBuffers.length === 0) throw new Error('No PDF documents could be generated');
    const mergedBuffer = await this.mergePdfBuffers(pdfBuffers);

    return { buffer: mergedBuffer, pageMap };
  }

  async generateProjectDetailsOnly(
    projects: any[],
    selectedColumns?: string[],
    options?: GenerateReportOptions,
  ): Promise<Buffer> {
    const developmentPlanId = options?.developmentPlanId;
    const reportType = options?.reportType ?? 'default';

    const dp = developmentPlanId
      ? await this.developmentPlanRepo.findOne({ where: { id: developmentPlanId } })
      : await this.developmentPlanRepo.findOneBy({ isLatest: true });
    if (!dp) throw new Error('DevelopmentPlan not found');
    const developmentPlanName = dp?.name ?? 'ไม่พบแผนพัฒนาจังหวัด';

    const columnMap: Record<string, { text: string; key: string }> = {
      index: { text: 'ที่', key: 'index' },
      title: { text: 'โครงการ', key: 'title' },
      objective: { text: 'วัตถุประสงค์', key: 'objective' },
      target: { text: 'เป้าหมาย \n(ผลผลิตของโครงการ)', key: 'target' },
      budget: { text: 'งบประมาณ (บาท)', key: 'budget' },
      kpi: { text: 'ตัวชี้วัด (KPI)', key: 'kpi' },
      expectedResult: { text: 'ผลที่คาดว่าจะได้รับ', key: 'expectedResult' },
      mainAgency: { text: 'หน่วยงาน\nรับผิดชอบหลัก', key: 'mainAgency' },
      amphoe: { text: 'อำเภอ', key: 'amphoe' },
      coordinates: { text: 'พิกัดทาง \nภูมิศาสตร์', key: 'coordinates' },
    };

    // Resolve reportFormat from the plan
    const reportFormat = dp.reportFormat ?? ReportFormat.STRATEGY_BASED;

    const defaultColumns = ['index', 'title', 'objective', 'target', 'budget', 'kpi', 'expectedResult', 'mainAgency'];
    const columnsToUse = selectedColumns || defaultColumns;
    const baseFilteredColumns = columnsToUse.filter(col => columnMap[col] && col !== 'amphoe' && col !== 'coordinates');
    const availableColumns = reportFormat === ReportFormat.ISSUE_BASED
      ? baseFilteredColumns.filter(col => col !== 'kpi')
      : baseFilteredColumns;

    const fonts = this.getPdfFonts();
    const years = Array.from({ length: dp.endYear - dp.startYear + 1 }, (_, index) => dp.startYear + index);

    const pageMargins: [number, number, number, number] = [15, 60, 15, 40];
    const pageOrientation: 'portrait' | 'landscape' = 'landscape';

    const pdfBuffers: Buffer[] = [];
    let pageOffset = 0;

    if (reportFormat === ReportFormat.ISSUE_BASED) {
      // --- ISSUE_BASED path: details only ---
      const { issues, groupedProjects } = this.prepareIssueBasedReportAggregations(projects, years);

      const sortedIssueEntries = [...groupedProjects.entries()].sort((a, b) => {
        const sortA = issues.get(a[0])?.sortOrder ?? 999;
        const sortB = issues.get(b[0])?.sortOrder ?? 999;
        return sortA - sortB;
      });

      for (const [issueName, issueProjects] of sortedIssueEntries) {
        const detailDoc = createIssueBasedGroupDetailDocDefinition({
          developmentPlanName, years, groupProjects: issueProjects, availableColumns, columnMap,
          pageMargins, pageOrientation, newWord: this.newWord.bind(this),
          reportType, issueName, pageOffset,
        });

        if (detailDoc) {
          const detailBuffer = await this.createPdfBuffer(detailDoc, fonts);
          pdfBuffers.push(detailBuffer);
          const detailPdf = await PDFDocument.load(detailBuffer);
          pageOffset += detailPdf.getPageCount();
        }
      }
    } else {
      // --- STRATEGY_BASED path (existing logic) ---
      const { groupedProjects } = this.prepareReportAggregations(projects, years);

      const strategyGroups = new Map<string, Array<{ groupKey: string, projects: any[] }>>();
      for (const [groupKey, groupProjectsValue] of groupedProjects.entries()) {
        const [strategyName] = groupKey.split('||');
        if (!strategyGroups.has(strategyName)) strategyGroups.set(strategyName, []);
        strategyGroups.get(strategyName)!.push({ groupKey, projects: groupProjectsValue });
      }

      for (const [strategyName, subGroups] of strategyGroups.entries()) {
        for (const group of subGroups) {
          const { groupKey, projects: groupProjectsValue } = group;
          const [, tacticName, planName] = groupKey.split('||');
          const detailDoc = createGroupDetailDocDefinition({
            developmentPlanName, years, groupProjects: groupProjectsValue, availableColumns, columnMap,
            pageMargins, pageOrientation, newWord: this.newWord.bind(this),
            reportType, strategyName, tacticName, planName, pageOffset,
          });

          if (detailDoc) {
            const detailBuffer = await this.createPdfBuffer(detailDoc, fonts);
            pdfBuffers.push(detailBuffer);
            const detailPdf = await PDFDocument.load(detailBuffer);
            pageOffset += detailPdf.getPageCount();
          }
        }
      }
    }

    if (pdfBuffers.length === 0) throw new Error('No PDF documents could be generated');
    return this.mergePdfBuffers(pdfBuffers);
  }

  // ===================================================================
  // 📑 7. Draft Agency Management (แผนพัฒนาฯ ฉบับร่าง)
  // ===================================================================

  async generateDraftAgencyFromStatus(options: {
    developmentPlanId: string;
    createdById: string;
  }): Promise<{ version: number; filePath: string; fileUrl: string; projectCount: number; createdAt: string; createdBy: { id: string; firstname: string; lastname: string }; }> {
    const developmentPlan = await this.developmentPlanRepo.findOne({ where: { id: options.developmentPlanId } });
    if (!developmentPlan) throw new Error(`DevelopmentPlan with ID ${options.developmentPlanId} not found`);

    const projects = await this.findProjectsForDraftAgency(options.developmentPlanId);
    if (projects.length === 0) throw new Error('No projects found with status Pending_Approval or Approved');

    const pdfBuffer = await this.generateProjectReport(projects);
    const projectIdsSnapshot = projects.map(p => p.id);

    return this.saveDraftPdfAndMeta({
      developmentPlanId: options.developmentPlanId,
      pdfBuffer,
      projectIdsSnapshot,
      createdById: options.createdById,
    });
  }

  async saveDraftPdfAndMeta(options: {
    developmentPlanId: string;
    pdfBuffer: Buffer;
    projectIdsSnapshot: Array<string | number>;
    createdById: string;
  }): Promise<{ version: number; filePath: string; fileUrl: string; projectCount: number; createdAt: string; createdBy: { id: string; firstname: string; lastname: string }; }> {
    const developmentPlan = await this.developmentPlanRepo.findOne({ where: { id: options.developmentPlanId } });
    if (!developmentPlan) throw new Error(`DevelopmentPlan with ID ${options.developmentPlanId} not found`);

    const version = await this.getNextVersion(developmentPlan.id);
    // Wave 3 BE-WRITERS — plan-rooted relative key under
    // `main-plan-{planId}/v{N}/draft-agency-{stamp}-v{N}.pdf`. The leaf
    // filename retains the legacy `{stamp}-v{N}` shape for human
    // discoverability and prefixes the artifact-kind to disambiguate
    // sibling drafts inside the same vN directory. DB persists the key
    // (umbrella §7.2); the absolute path lives only at fs boundary.
    const fileName = `draft-agency-${this.buildVersionedPdfFileName(version)}`;
    const fileKey = this.storagePathService.mainPlanVersionKey(
      developmentPlan.id,
      version,
      fileName,
    );
    await this.storagePathService.writeFile(fileKey, options.pdfBuffer);

    const pdfDraft = this.pdfDraftAgencyRepo.create({
      developmentPlanId: String(developmentPlan.id),
      version,
      filePath: fileKey,
      projectIdsSnapshot: options.projectIdsSnapshot,
      projectCount: options.projectIdsSnapshot.length,
      createdById: options.createdById,
    });

    const saved = await this.pdfDraftAgencyRepo.save(pdfDraft);
    const user = await this.userRepo.findOne({ where: { id: options.createdById }, select: ['id', 'firstname', 'lastname'] });

    return {
      version: saved.version,
      filePath: saved.filePath,
      fileUrl: `/v1/pdf/draft/agency/${developmentPlan.id}/latest/stream`,
      projectCount: saved.projectCount,
      createdAt: saved.createdAt.toISOString(),
      createdBy: user ? { id: user.id, firstname: user.firstname, lastname: user.lastname } : { id: options.createdById, firstname: '', lastname: '' },
    };
  }

  async getLatestDraftAgencyMetaForPlan(developmentPlanId: string): Promise<
    | { exists: false }
    | { exists: true; version: number; fileUrl: string; projectCount: number; createdAt: string; projectIdsSnapshot: Array<string | number>; filePath: string; createdBy: { id: string; firstname: string; lastname: string }; }
  > {
    const latest = await this.pdfDraftAgencyRepo.findOne({
      where: { developmentPlanId: String(developmentPlanId) },
      order: { version: 'DESC' },
      relations: ['createdBy']
    });

    if (!latest) return { exists: false };
    return {
      exists: true, version: latest.version, fileUrl: `/v1/pdf/draft/agency/${developmentPlanId}/latest/stream`, projectCount: latest.projectCount,
      createdAt: latest.createdAt.toISOString(), projectIdsSnapshot: latest.projectIdsSnapshot, filePath: latest.filePath,
      createdBy: { id: latest.createdBy.id, firstname: latest.createdBy.firstname, lastname: latest.createdBy.lastname }
    };
  }

  async readLatestDraftAgencyFileForPlan(developmentPlanId: string): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const meta = await this.getLatestDraftAgencyMetaForPlan(developmentPlanId);
    if (!meta || !meta.exists) return null;
    // Wave 3 BE-READERS — resolve through StoragePathService so legacy
    // absolute paths AND new relative keys both stream correctly during
    // the migration window (umbrella §7.3).
    const absPath = this.storagePathService.resolveStored(meta.filePath);
    const stream = fs.createReadStream(absPath);
    return { filePath: meta.filePath, stream };
  }

  async getAllDraftAgencyVersions(developmentPlanId: string): Promise<Array<{ version: number; fileUrl: string; projectCount: number; createdAt: string; createdBy: { id: string }; }>> {
    const versions = await this.pdfDraftAgencyRepo.find({
      where: { developmentPlanId },
      order: { version: 'DESC' },
      relations: ['createdBy']
    });

    return versions.map(v => ({
      version: v.version,
      fileUrl: `/v1/pdf/draft/agency/${developmentPlanId}/${v.version}/stream`,
      projectCount: v.projectCount,
      createdAt: v.createdAt.toISOString(),
      createdBy: { id: v.createdBy.id }
    }));
  }

  async readDraftAgencyFileByVersion(developmentPlanId: string, version: number): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const draft = await this.pdfDraftAgencyRepo.findOne({
      where: { developmentPlanId: String(developmentPlanId), version },
      relations: ['createdBy']
    });
    if (!draft) return null;
    // Wave 3 BE-READERS — see resolveStored note above.
    const absPath = this.storagePathService.resolveStored(draft.filePath);
    return { filePath: draft.filePath, stream: fs.createReadStream(absPath) };
  }

  // ===================================================================
  // 🗺️ 8. Draft Coordinate Management (แผนประสานแผน ฉบับร่าง)
  // ===================================================================

  async generateInAuthorityFromStatus(options: {
    developmentPlanId: string;
    createdById: string;
  }): Promise<{ version: number; filePath: string; fileUrl: string; projectCount: number; createdAt: string; createdBy: { id: string; firstname: string; lastname: string }; }> {
    const developmentPlan = await this.developmentPlanRepo.findOne({ where: { id: options.developmentPlanId } });
    if (!developmentPlan) throw new Error(`DevelopmentPlan with ID ${options.developmentPlanId} not found`);

    const projects = await this.findProjectsForInAuthority(options.developmentPlanId);
    if (projects.length === 0) throw new Error('No projects found with status Pending_Approval or Approved for in-authority');

    const pdfBuffer = await this.generateProjectReport(projects, { developmentPlanId: options.developmentPlanId, reportType: 'inAuthority' });
    const projectIdsSnapshot = projects.map(p => p.id);

    return this.saveInAuthorityPdfAndMeta({
      developmentPlanId: options.developmentPlanId,
      pdfBuffer,
      projectIdsSnapshot,
      createdById: options.createdById,
    });
  }

  async saveInAuthorityPdfAndMeta(options: {
    developmentPlanId: string;
    pdfBuffer: Buffer;
    projectIdsSnapshot: Array<string | number>;
    createdById: string;
  }): Promise<{ version: number; filePath: string; fileUrl: string; projectCount: number; createdAt: string; createdBy: { id: string; firstname: string; lastname: string }; }> {
    const developmentPlan = await this.developmentPlanRepo.findOne({ where: { id: options.developmentPlanId } });
    if (!developmentPlan) throw new Error(`DevelopmentPlan with ID ${options.developmentPlanId} not found`);

    const version = await this.getNextInAuthorityVersion(developmentPlan.id);
    // Wave 3 BE-WRITERS — plan-rooted key, draft-coordinate variant.
    const fileName = `draft-coordinate-${this.buildVersionedPdfFileName(version)}`;
    const fileKey = this.storagePathService.mainPlanVersionKey(
      developmentPlan.id,
      version,
      fileName,
    );
    await this.storagePathService.writeFile(fileKey, options.pdfBuffer);

    const pdfInAuthority = this.pdfDevelopmentPlanDraftCoordinateDocumentRepo.create({
      developmentPlanId: String(developmentPlan.id),
      version,
      filePath: fileKey,
      projectIdsSnapshot: options.projectIdsSnapshot,
      projectCount: options.projectIdsSnapshot.length,
      createdById: options.createdById,
    });

    const saved = await this.pdfDevelopmentPlanDraftCoordinateDocumentRepo.save(pdfInAuthority);
    const user = await this.userRepo.findOne({ where: { id: options.createdById }, select: ['id', 'firstname', 'lastname'] });

    return {
      version: saved.version, filePath: saved.filePath, fileUrl: `/v1/pdf/draft/coordinate/${developmentPlan.id}/latest/stream`, projectCount: saved.projectCount,
      createdAt: saved.createdAt.toISOString(),
      createdBy: user ? { id: user.id, firstname: user.firstname, lastname: user.lastname } : { id: options.createdById, firstname: '', lastname: '' },
    };
  }

  async getLatestInAuthorityMetaForPlan(developmentPlanId: string): Promise<
    | { exists: false }
    | { exists: true; version: number; fileUrl: string; projectCount: number; createdAt: string; projectIdsSnapshot: Array<string | number>; filePath: string; createdBy: { id: string; firstname: string; lastname: string }; }
  > {
    const developmentPlan = await this.developmentPlanRepo.findOne({ where: { id: developmentPlanId } });
    if (!developmentPlan) throw new Error(`DevelopmentPlan with ID ${developmentPlanId} not found`);
    const latest = await this.pdfDevelopmentPlanDraftCoordinateDocumentRepo.findOne({
      where: { developmentPlanId: developmentPlan.id },
      order: { version: 'DESC' },
      relations: ['createdBy']
    });

    if (!latest) return { exists: false };
    return {
      exists: true, version: latest.version, fileUrl: `/v1/pdf/draft/coordinate/${developmentPlanId}/latest/stream`, projectCount: latest.projectCount,
      createdAt: latest.createdAt.toISOString(), projectIdsSnapshot: latest.projectIdsSnapshot, filePath: latest.filePath,
      createdBy: { id: latest.createdBy.id, firstname: latest.createdBy.firstname, lastname: latest.createdBy.lastname }
    };
  }

  async getAllInAuthorityVersionsForPlan(developmentPlanId: string): Promise<Array<{ version: number; fileUrl: string; projectCount: number; createdAt: string; createdBy: { id: string }; }>> {
    const versions = await this.pdfDevelopmentPlanDraftCoordinateDocumentRepo.find({
      where: { developmentPlanId: String(developmentPlanId) },
      order: { version: 'DESC' },
      relations: ['createdBy']
    });

    return versions.map(v => ({
      version: v.version,
      fileUrl: `/v1/pdf/draft/coordinate/${developmentPlanId}/${v.version}/stream`,
      projectCount: v.projectCount,
      createdAt: v.createdAt.toISOString(),
      createdBy: { id: v.createdBy.id }
    }));
  }

  async readInAuthorityFileByVersionForPlan(developmentPlanId: string, version: number): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const inAuthority = await this.pdfDevelopmentPlanDraftCoordinateDocumentRepo.findOne({
      where: { developmentPlanId: String(developmentPlanId), version },
      relations: ['createdBy']
    });
    if (!inAuthority) return null;
    // Wave 3 BE-READERS — resolveStored handles legacy abs + new relative.
    const absPath = this.storagePathService.resolveStored(inAuthority.filePath);
    return { filePath: inAuthority.filePath, stream: fs.createReadStream(absPath) };
  }

  async readLatestInAuthorityFileForPlan(developmentPlanId: string): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const meta = await this.getLatestInAuthorityMetaForPlan(developmentPlanId);
    if (!meta || !meta.exists) return null;
    // Wave 3 BE-READERS — resolveStored handles legacy abs + new relative.
    const absPath = this.storagePathService.resolveStored(meta.filePath);
    return { filePath: meta.filePath, stream: fs.createReadStream(absPath) };
  }

  // ===================================================================
  // 📤 9. Out Authority Management (โครงการเกินศักยภาพ/ไม่อนุมัติ)
  // ===================================================================

  async generateOutAuthorityFromStatus(options: {
    developmentPlanId: string;
    createdById: string;
  }): Promise<{ version: number; filePath: string; fileUrl: string; projectCount: number; createdAt: string; createdBy: { id: string; firstname: string; lastname: string }; }> {
    const developmentPlan = await this.developmentPlanRepo.findOne({ where: { id: options.developmentPlanId } });
    if (!developmentPlan) throw new Error(`DevelopmentPlan with ID ${options.developmentPlanId} not found`);

    const projects = await this.findProjectsForOutAuthority(options.developmentPlanId);
    if (projects.length === 0) throw new Error('No projects found with status Rejected for out-authority');

    const pdfBuffer = await this.generateProjectReport(projects, { developmentPlanId: options.developmentPlanId, reportType: 'outAuthority' });
    const projectIdsSnapshot = projects.map(p => p.id);

    // Wave 110 W110-BE-01 — out-authority is a finalize-like step that
    // flips `isBooked = true` on the Rejected subset for the same plan.
    // The cascade is a defensive no-op for non-Approved/Rejected/Ready
    // PGs in scope (Rejected is terminal — see workflow doc Action
    // Matrix), but we wrap the booking write in the cascade transaction
    // so the audit trail stays consistent with the §18.2.1 spec which
    // lists this site as a finalize trigger surface. CLAUDE.md §18.
    await this.orphanDataSource.transaction(async (manager) => {
      await this.orphanCleanupService.cascadeOnBookFinalize(
        developmentPlan,
        'PLAN',
        manager,
        options.createdById,
      );
      const updateProject = await manager.getRepository(ProjectGroup).update(
        { id: In(projectIdsSnapshot) },
        { isBooked: true, bookedAt: new Date() }
      );
      if (updateProject.affected === 0) {
        throw new Error('Failed to update project status');
      }
    });

    return this.saveOutAuthorityPdfAndMeta({
      developmentPlanId: options.developmentPlanId,
      pdfBuffer,
      projectIdsSnapshot,
      createdById: options.createdById,
    });
  }

  async saveOutAuthorityPdfAndMeta(options: {
    developmentPlanId: string;
    pdfBuffer: Buffer;
    projectIdsSnapshot: Array<string | number>;
    createdById: string;
  }): Promise<{ version: number; filePath: string; fileUrl: string; projectCount: number; createdAt: string; createdBy: { id: string; firstname: string; lastname: string }; }> {
    const developmentPlan = await this.developmentPlanRepo.findOne({ where: { id: options.developmentPlanId } });
    if (!developmentPlan) throw new Error(`DevelopmentPlan with ID ${options.developmentPlanId} not found`);

    const version = await this.getNextOutAuthorityVersion(developmentPlan.id);
    // Wave 3 BE-WRITERS — plan-rooted key, out-authority variant.
    const fileName = `out-authority-${this.buildVersionedPdfFileName(version)}`;
    const fileKey = this.storagePathService.mainPlanVersionKey(
      developmentPlan.id,
      version,
      fileName,
    );
    await this.storagePathService.writeFile(fileKey, options.pdfBuffer);

    const pdfOutAuthority = this.pdfOutAuthorityRepo.create({
      developmentPlanId: String(developmentPlan.id),
      version,
      filePath: fileKey,
      projectIdsSnapshot: options.projectIdsSnapshot,
      projectCount: options.projectIdsSnapshot.length,
      createdById: options.createdById,
    });

    const saved = await this.pdfOutAuthorityRepo.save(pdfOutAuthority);
    const user = await this.userRepo.findOne({ where: { id: options.createdById }, select: ['id', 'firstname', 'lastname'] });

    return {
      version: saved.version, filePath: saved.filePath, fileUrl: `/v1/pdf/out-authority/${developmentPlan.id}/latest/stream`, projectCount: saved.projectCount,
      createdAt: saved.createdAt.toISOString(),
      createdBy: user ? { id: user.id, firstname: user.firstname, lastname: user.lastname } : { id: options.createdById, firstname: '', lastname: '' },
    };
  }

  async getLatestOutAuthorityMetaForPlan(developmentPlanId: string): Promise<
    | { exists: false }
    | { exists: true; version: number; fileUrl: string; projectCount: number; createdAt: string; projectIdsSnapshot: Array<string | number>; filePath: string; createdBy: { id: string; firstname: string; lastname: string }; }
  > {
    const developmentPlan = await this.developmentPlanRepo.findOne({ where: { id: developmentPlanId } });
    if (!developmentPlan) throw new Error(`DevelopmentPlan with ID ${developmentPlanId} not found`);
    const latest = await this.pdfOutAuthorityRepo.findOne({
      where: { developmentPlanId: developmentPlan.id },
      order: { version: 'DESC' },
      relations: ['createdBy']
    });

    if (!latest) return { exists: false };
    return {
      exists: true, version: latest.version, fileUrl: `/v1/pdf/out-authority/${developmentPlanId}/latest/stream`, projectCount: latest.projectCount,
      createdAt: latest.createdAt.toISOString(), projectIdsSnapshot: latest.projectIdsSnapshot, filePath: latest.filePath,
      createdBy: { id: latest.createdBy.id, firstname: latest.createdBy.firstname, lastname: latest.createdBy.lastname }
    };
  }

  async getAllOutAuthorityVersionsForPlan(developmentPlanId: string): Promise<Array<{ version: number; fileUrl: string; projectCount: number; createdAt: string; createdBy: { id: string }; }>> {
    const versions = await this.pdfOutAuthorityRepo.find({
      where: { developmentPlanId: String(developmentPlanId) },
      order: { version: 'DESC' },
      relations: ['createdBy']
    });

    return versions.map(v => ({
      id: v.id, version: v.version,
      fileUrl: `/v1/pdf/out-authority/${developmentPlanId}/${v.version}/stream`,
      projectCount: v.projectCount,
      createdAt: v.createdAt.toISOString(),
      createdBy: { id: v.createdBy.id }
    }));
  }

  async readOutAuthorityFileByVersionForPlan(developmentPlanId: string, version: number): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const outAuthority = await this.pdfOutAuthorityRepo.findOne({
      where: { developmentPlanId: String(developmentPlanId), version },
      relations: ['createdBy']
    });
    if (!outAuthority) return null;
    // Wave 3 BE-READERS — resolveStored handles legacy abs + new relative.
    const absPath = this.storagePathService.resolveStored(outAuthority.filePath);
    return { filePath: outAuthority.filePath, stream: fs.createReadStream(absPath) };
  }

  async readLatestOutAuthorityFileForPlan(developmentPlanId: string): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const meta = await this.getLatestOutAuthorityMetaForPlan(developmentPlanId);
    if (!meta || !meta.exists) return null;
    // Wave 3 BE-READERS — resolveStored handles legacy abs + new relative.
    const absPath = this.storagePathService.resolveStored(meta.filePath);
    return { filePath: meta.filePath, stream: fs.createReadStream(absPath) };
  }

  // ===================================================================
  // ✏️ 10. Revision Edit Draft Management (ร่างแผนแก้ไข)
  // ===================================================================

  async generateRevisionEditDraftFromStatus(options: {
    developmentPlanId: string;
    developmentPlanRevisionId: string;
    createdById: string;
  }): Promise<{ version: number; filePath: string; fileUrl: string; projectCount: number; createdAt: string; createdBy: { id: string; firstname: string; lastname: string }; }> {
    const developmentPlanRevision = await this.developmentPlanRevisionRepo.findOne({
      where: { id: options.developmentPlanRevisionId },
      relations: ['developmentPlan', 'revisionType'],
    });

    if (!developmentPlanRevision) throw new Error(`DevelopmentPlanRevision with ID ${options.developmentPlanRevisionId} not found`);
    if (developmentPlanRevision.developmentPlan.id !== options.developmentPlanId) throw new Error(`DevelopmentPlanRevision ${options.developmentPlanRevisionId} does not belong to DevelopmentPlan ${options.developmentPlanId}`);

    const editNo = await this.calculateRevisionCountByType(
      options.developmentPlanId, 'แก้ไข', developmentPlanRevision.revisionNumber
    );

    const projects = await this.findProjectsForRevisionEditDraft(options.developmentPlanRevisionId);
    if (projects.length === 0) throw new Error('No projects found with status Pending_Approval or Approved');

    const selectedColumns = ['index', 'title', 'objective', 'target', 'budget', 'expectedResult', 'mainAgency'];
    const pdfBuffer = await this.generateRevisionEditDraftReportWithColumns(
      options.developmentPlanRevisionId, selectedColumns, projects
    );
    const projectIdsSnapshot = projects.map(p => p.id);

    return this.saveRevisionEditDraftPdfAndMeta({
      developmentPlanId: options.developmentPlanId,
      developmentPlanRevisionId: options.developmentPlanRevisionId,
      pdfBuffer, projectIdsSnapshot, createdById: options.createdById, editNo,
    });
  }

  async generateRevisionEditDraftReportWithColumns(
    developmentPlanRevisionId: string,
    selectedColumns: string[],
    existingProjects?: RevisedProjectGroup[]
  ): Promise<Buffer> {
    const developmentPlanRevision = await this.developmentPlanRevisionRepo.findOne({
      where: { id: developmentPlanRevisionId },
      relations: ['developmentPlan', 'revisionType'],
    });
    if (!developmentPlanRevision) throw new Error(`DevelopmentPlanRevision with ID ${developmentPlanRevisionId} not found`);

    const developmentPlanId = developmentPlanRevision.developmentPlan.id;
    const dp = await this.developmentPlanRepo.findOne({ where: { id: developmentPlanId } });
    if (!dp) throw new Error('DevelopmentPlan not found');

    const revisionTypeName = developmentPlanRevision.description || 'ไม่ระบุ';
    const developmentPlanRevisionName = `${dp.name} ${revisionTypeName}`;

    let revisedProjects: RevisedProjectGroup[] = [];

    if (existingProjects) {
      revisedProjects = existingProjects;
    } else {
      revisedProjects = await this.revisedProjectGroupRepo.createQueryBuilder('revisedProject')
        .leftJoinAndSelect('revisedProject.developmentPlanRevision', 'developmentPlanRevision')
        .leftJoinAndSelect('developmentPlanRevision.developmentPlan', 'developmentPlan')
        .leftJoinAndSelect('developmentPlanRevision.revisionType', 'revisionType')
        .leftJoinAndSelect('revisedProject.projectGroup', 'projectGroup')
        .leftJoinAndSelect('revisedProject.strategy', 'strategy')
        .leftJoinAndSelect('revisedProject.tactic', 'tactic')
        .leftJoinAndSelect('revisedProject.plan', 'plan')
        .leftJoinAndSelect('revisedProject.developmentIssue', 'developmentIssue')
        .leftJoinAndSelect('revisedProject.budgets', 'budgets')
        .leftJoinAndSelect('revisedProject.responsibleAgency', 'responsibleAgency')
        .leftJoinAndSelect('revisedProject.originAgencyId', 'originAgencyId')
        .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
        .leftJoinAndSelect('revisedProject.trackingStatus', 'trackingStatus')
        .leftJoinAndSelect('trackingStatus.statusId', 'status')
        .where('developmentPlanRevision.id = :developmentPlanRevisionId', { developmentPlanRevisionId })
        .andWhere('revisionType.name = :revisionTypeName', { revisionTypeName: 'แก้ไข' })
        .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
        .andWhere('status.name IN (:...statusNames)', { statusNames: ['Pending_Approval', 'Approved'] })
        .orderBy('strategy.id', 'ASC')
        .getMany();
    }

    if (revisedProjects.length === 0) throw new Error('No projects found with status Pending_Approval or Approved');

    // Resolve reportFormat from the parent plan
    const reportFormat = dp.reportFormat ?? ReportFormat.STRATEGY_BASED;

    const projectsWithComparison = await Promise.all(
      revisedProjects.map(async (current) => this.findProjectComparisonForRevisionEdit(current, developmentPlanId))
    );
    const unifiedProjects = projectsWithComparison.map(p => p.current);

    const columnMap: Record<string, { text: string; key: string }> = {
      index: { text: 'ที่', key: 'index' },
      title: { text: 'โครงการ', key: 'title' },
      objective: { text: 'วัตถุประสงค์', key: 'objective' },
      target: { text: 'เป้าหมาย \n(ผลผลิตของโครงการ)', key: 'target' },
      budget: { text: 'งบประมาณ (บาท)', key: 'budget' },
      kpi: { text: 'ตัวชี้วัด (KPI)', key: 'kpi' },
      expectedResult: { text: 'ผลที่คาดว่าจะได้รับ', key: 'expectedResult' },
      mainAgency: { text: 'หน่วยงาน\nรับผิดชอบหลัก', key: 'mainAgency' },
      amphoe: { text: 'อำเภอ', key: 'amphoe' },
      coordinates: { text: 'พิกัดทาง \nภูมิศาสตร์', key: 'coordinates' },
    };

    const availableColumns = reportFormat === ReportFormat.ISSUE_BASED
      ? selectedColumns.filter(col => columnMap[col] && col !== 'kpi')
      : selectedColumns.filter(col => columnMap[col]);
    const fonts = this.getPdfFonts();
    const years = Array.from({ length: dp.endYear - dp.startYear + 1 }, (_, index) => dp.startYear + index);
    const pageMargins: [number, number, number, number] = [15, 60, 15, 40];
    const pageOrientation = 'landscape';

    const pdfBuffers: Buffer[] = [];
    let pageOffset = 0;

    if (reportFormat === ReportFormat.ISSUE_BASED) {
      // --- ISSUE_BASED path ---
      const { issues, overallSum, overallCount } = this.prepareIssueBasedReportAggregations(unifiedProjects, years);

      const summaryDoc = createIssueBasedRevisionEditSummaryPartDocDefinition({
        developmentPlanRevisionName, years, issues, overallSum, overallCount,
        pageMargins, pageOrientation, newWord: this.newWord.bind(this),
      });

      const groupedByIssue = new Map<string, typeof projectsWithComparison>();
      for (const project of projectsWithComparison) {
        const current = project.current;
        const issueName = current.developmentIssue?.name ?? 'ไม่ระบุประเด็น';
        if (!groupedByIssue.has(issueName)) groupedByIssue.set(issueName, []);
        groupedByIssue.get(issueName)!.push(project);
      }

      if (summaryDoc) {
        const summaryBuffer = await this.createPdfBuffer(summaryDoc, fonts);
        pdfBuffers.push(summaryBuffer);
        const summaryPdf = await PDFDocument.load(summaryBuffer);
        pageOffset += summaryPdf.getPageCount();
      }

      // Sort issue groups by sortOrder
      const sortedIssueEntries = [...groupedByIssue.entries()].sort((a, b) => {
        const sortA = issues.get(a[0])?.sortOrder ?? 999;
        const sortB = issues.get(b[0])?.sortOrder ?? 999;
        return sortA - sortB;
      });

      for (const [issueName, groupProjectsValue] of sortedIssueEntries) {
        const coverPageDoc = createIssueBasedRevisionGroupCoverPageDocDefinition(
          issueName, developmentPlanRevisionName, pageMargins, pageOrientation,
          this.newWord.bind(this), pageOffset,
        );
        const coverPageBuffer = await this.createPdfBuffer(coverPageDoc, fonts);
        pdfBuffers.push(coverPageBuffer);
        const coverPagePdf = await PDFDocument.load(coverPageBuffer);
        pageOffset += coverPagePdf.getPageCount();

        const detailDoc = createIssueBasedRevisionGroupDetailDocDefinition({
          developmentPlanRevisionName, years, groupProjects: groupProjectsValue, availableColumns, columnMap,
          pageMargins, pageOrientation, newWord: this.newWord.bind(this),
          reportType: 'inAuthority', issueName, pageOffset,
        });

        if (detailDoc) {
          const detailBuffer = await this.createPdfBuffer(detailDoc, fonts);
          pdfBuffers.push(detailBuffer);
          const detailPdf = await PDFDocument.load(detailBuffer);
          pageOffset += detailPdf.getPageCount();
        }
      }
    } else {
      // --- STRATEGY_BASED path (existing logic) ---
      const { strategies, overallSum, overallCount } = this.prepareReportAggregations(unifiedProjects, years);

      const summaryDoc = createRevisionEditSummaryPartDocDefinition({
        developmentPlanRevisionName, years, strategies, overallSum, overallCount,
        pageMargins, pageOrientation, newWord: this.newWord.bind(this),
      });

      const groupedProjects = new Map<string, typeof projectsWithComparison>();
      for (const project of projectsWithComparison) {
        const current = project.current;
        const groupKey = `${current.strategy?.name || '-'}||${current.tactic?.name || '-'}||${current.plan?.name || '-'}`;
        if (!groupedProjects.has(groupKey)) groupedProjects.set(groupKey, []);
        groupedProjects.get(groupKey)!.push(project);
      }

      if (summaryDoc) {
        const summaryBuffer = await this.createPdfBuffer(summaryDoc, fonts);
        pdfBuffers.push(summaryBuffer);
        const summaryPdf = await PDFDocument.load(summaryBuffer);
        pageOffset += summaryPdf.getPageCount();
      }

      for (const [groupKey, groupProjectsValue] of groupedProjects.entries()) {
        const [strategyName, tacticName, planName] = groupKey.split('||');
        const coverPageDoc = createRevisionEditGroupCoverPageDocDefinition(
          strategyName, developmentPlanRevisionName, pageMargins, pageOrientation,
          this.newWord.bind(this), pageOffset,
        );
        const coverPageBuffer = await this.createPdfBuffer(coverPageDoc, fonts);
        pdfBuffers.push(coverPageBuffer);
        const coverPagePdf = await PDFDocument.load(coverPageBuffer);
        pageOffset += coverPagePdf.getPageCount();

        const detailDoc = createRevisionEditGroupDetailDocDefinition({
          developmentPlanRevisionName, years, groupProjects: groupProjectsValue, availableColumns, columnMap,
          pageMargins, pageOrientation, newWord: this.newWord.bind(this),
          reportType: 'inAuthority', strategyName, tacticName, planName, pageOffset,
        });

        if (detailDoc) {
          const detailBuffer = await this.createPdfBuffer(detailDoc, fonts);
          pdfBuffers.push(detailBuffer);
          const detailPdf = await PDFDocument.load(detailBuffer);
          pageOffset += detailPdf.getPageCount();
        }
      }
    }

    if (pdfBuffers.length === 0) throw new Error('No PDF documents could be generated');
    return this.mergePdfBuffers(pdfBuffers);
  }

  async generateRevisionEditDetailsOnly(
    developmentPlanRevisionId: string,
    selectedColumns?: string[],
    existingProjects?: RevisedProjectGroup[]
  ): Promise<Buffer> {
    const developmentPlanRevision = await this.developmentPlanRevisionRepo.findOne({
      where: { id: developmentPlanRevisionId },
      relations: ['developmentPlan', 'revisionType'],
    });
    if (!developmentPlanRevision) throw new Error(`DevelopmentPlanRevision with ID ${developmentPlanRevisionId} not found`);

    const developmentPlanId = developmentPlanRevision.developmentPlan.id;
    const dp = await this.developmentPlanRepo.findOne({ where: { id: developmentPlanId } });
    if (!dp) throw new Error('DevelopmentPlan not found');

    const revisionTypeName = developmentPlanRevision.description || 'ไม่ระบุ';
    const developmentPlanRevisionName = `${dp.name} ${revisionTypeName}`;

    // Resolve reportFormat from the parent plan
    const reportFormat = dp.reportFormat ?? ReportFormat.STRATEGY_BASED;

    let revisedProjects: RevisedProjectGroup[] = [];

    if (existingProjects) {
      revisedProjects = existingProjects;
    } else {
      revisedProjects = await this.revisedProjectGroupRepo.createQueryBuilder('revisedProject')
        .leftJoinAndSelect('revisedProject.developmentPlanRevision', 'developmentPlanRevision')
        .leftJoinAndSelect('developmentPlanRevision.developmentPlan', 'developmentPlan')
        .leftJoinAndSelect('developmentPlanRevision.revisionType', 'revisionType')
        .leftJoinAndSelect('revisedProject.projectGroup', 'projectGroup')
        .leftJoinAndSelect('revisedProject.strategy', 'strategy')
        .leftJoinAndSelect('revisedProject.tactic', 'tactic')
        .leftJoinAndSelect('revisedProject.plan', 'plan')
        .leftJoinAndSelect('revisedProject.developmentIssue', 'developmentIssue')
        .leftJoinAndSelect('revisedProject.budgets', 'budgets')
        .leftJoinAndSelect('revisedProject.responsibleAgency', 'responsibleAgency')
        .leftJoinAndSelect('revisedProject.originAgencyId', 'originAgencyId')
        .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
        .leftJoinAndSelect('revisedProject.trackingStatus', 'trackingStatus')
        .leftJoinAndSelect('trackingStatus.statusId', 'status')
        .where('developmentPlanRevision.id = :developmentPlanRevisionId', { developmentPlanRevisionId })
        .andWhere('revisionType.name = :revisionTypeName', { revisionTypeName: 'แก้ไข' })
        .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
        .andWhere('status.name IN (:...statusNames)', { statusNames: ['Pending_Approval', 'Approved'] })
        .orderBy('strategy.id', 'ASC')
        .getMany();
    }

    if (revisedProjects.length === 0) throw new Error('No projects found with status Pending_Approval or Approved');

    const projectsWithComparison = await Promise.all(
      revisedProjects.map(async (current) => this.findProjectComparisonForRevisionEdit(current, developmentPlanId))
    );

    const defaultColumns = ['index', 'title', 'objective', 'target', 'budget', 'expectedResult', 'mainAgency'];
    const columnsToUse = selectedColumns || defaultColumns;

    const columnMap: Record<string, { text: string; key: string }> = {
      index: { text: 'ที่', key: 'index' },
      title: { text: 'โครงการ', key: 'title' },
      objective: { text: 'วัตถุประสงค์', key: 'objective' },
      target: { text: 'เป้าหมาย \n(ผลผลิตของโครงการ)', key: 'target' },
      budget: { text: 'งบประมาณ (บาท)', key: 'budget' },
      kpi: { text: 'ตัวชี้วัด (KPI)', key: 'kpi' },
      expectedResult: { text: 'ผลที่คาดว่าจะได้รับ', key: 'expectedResult' },
      mainAgency: { text: 'หน่วยงาน\nรับผิดชอบหลัก', key: 'mainAgency' },
      amphoe: { text: 'อำเภอ', key: 'amphoe' },
      coordinates: { text: 'พิกัดทาง \nภูมิศาสตร์', key: 'coordinates' },
    };

    const availableColumns = reportFormat === ReportFormat.ISSUE_BASED
      ? columnsToUse.filter(col => columnMap[col] && col !== 'kpi')
      : columnsToUse.filter(col => columnMap[col]);
    const fonts = this.getPdfFonts();
    const years = Array.from({ length: dp.endYear - dp.startYear + 1 }, (_, index) => dp.startYear + index);
    const pageMargins: [number, number, number, number] = [15, 60, 15, 40];
    const pageOrientation = 'landscape';

    const pdfBuffers: Buffer[] = [];
    let pageOffset = 0;

    if (reportFormat === ReportFormat.ISSUE_BASED) {
      // --- ISSUE_BASED path: details only (no summary, no cover page) ---
      const groupedByIssue = new Map<string, typeof projectsWithComparison>();
      const issueSortOrders = new Map<string, number>();
      for (const project of projectsWithComparison) {
        const current = project.current;
        const issueName = current.developmentIssue?.name ?? 'ไม่ระบุประเด็น';
        if (!groupedByIssue.has(issueName)) {
          groupedByIssue.set(issueName, []);
          issueSortOrders.set(issueName, current.developmentIssue?.sortOrder ?? 999);
        }
        groupedByIssue.get(issueName)!.push(project);
      }

      const sortedIssueEntries = [...groupedByIssue.entries()].sort((a, b) => {
        const sortA = issueSortOrders.get(a[0]) ?? 999;
        const sortB = issueSortOrders.get(b[0]) ?? 999;
        return sortA - sortB;
      });

      for (const [issueName, groupProjectsValue] of sortedIssueEntries) {
        const detailDoc = createIssueBasedRevisionGroupDetailDocDefinition({
          developmentPlanRevisionName, years, groupProjects: groupProjectsValue, availableColumns, columnMap,
          pageMargins, pageOrientation, newWord: this.newWord.bind(this),
          reportType: 'inAuthority', issueName, pageOffset,
        });

        if (detailDoc) {
          const detailBuffer = await this.createPdfBuffer(detailDoc, fonts);
          pdfBuffers.push(detailBuffer);
          const detailPdf = await PDFDocument.load(detailBuffer);
          pageOffset += detailPdf.getPageCount();
        }
      }
    } else {
      // --- STRATEGY_BASED path (existing logic) ---
      const groupedProjects = new Map<string, typeof projectsWithComparison>();
      for (const project of projectsWithComparison) {
        const current = project.current;
        const groupKey = `${current.strategy?.name || '-'}||${current.tactic?.name || '-'}||${current.plan?.name || '-'}`;
        if (!groupedProjects.has(groupKey)) groupedProjects.set(groupKey, []);
        groupedProjects.get(groupKey)!.push(project);
      }

      for (const [groupKey, groupProjectsValue] of groupedProjects.entries()) {
        const [strategyName, tacticName, planName] = groupKey.split('||');

        const detailDoc = createRevisionEditGroupDetailDocDefinitionUser({
          developmentPlanRevisionName, years, groupProjects: groupProjectsValue, availableColumns, columnMap,
          pageMargins, pageOrientation, newWord: this.newWord.bind(this),
          reportType: 'inAuthority', strategyName, tacticName, planName, pageOffset,
        });

        if (detailDoc) {
          const detailBuffer = await this.createPdfBuffer(detailDoc, fonts);
          pdfBuffers.push(detailBuffer);
          const detailPdf = await PDFDocument.load(detailBuffer);
          pageOffset += detailPdf.getPageCount();
        }
      }
    }

    if (pdfBuffers.length === 0) throw new Error('No PDF documents could be generated');
    return this.mergePdfBuffers(pdfBuffers);
  }

  async saveRevisionEditDraftPdfAndMeta(options: {
    developmentPlanId: string;
    developmentPlanRevisionId: string;
    pdfBuffer: Buffer;
    projectIdsSnapshot: Array<string | number>;
    createdById: string;
    editNo: number;
  }): Promise<{ version: number; filePath: string; fileUrl: string; projectCount: number; createdAt: string; createdBy: { id: string; firstname: string; lastname: string }; }> {
    const developmentPlan = await this.developmentPlanRepo.findOne({ where: { id: options.developmentPlanId } });
    if (!developmentPlan) throw new Error(`DevelopmentPlan with ID ${options.developmentPlanId} not found`);

    const version = await this.getNextRevisionEditDraftVersion(options.developmentPlanRevisionId);
    // Wave 3 BE-WRITERS — plan-rooted edit-revision key. `editNo` is
    // the revision's ordinal (revisionNumber). The draft variant is
    // composed as `draft-{stamp}-v{N}.pdf` to stay distinguishable
    // from the approved sibling under the same vN/ directory.
    const fileName = `draft-${this.buildVersionedPdfFileName(version)}`;
    const fileKey = this.storagePathService.revisionVersionKey({
      planId: developmentPlan.id,
      revisionType: 'edit',
      revisionNumber: options.editNo,
      revisionId: options.developmentPlanRevisionId,
      versionNumber: version,
      fileName,
    });
    await this.storagePathService.writeFile(fileKey, options.pdfBuffer);

    const pdfRevisionEditDraft = this.pdfRevisionEditDraftRepo.create({
      developmentPlanRevisionId: String(options.developmentPlanRevisionId),
      version,
      filePath: fileKey,
      projectIdsSnapshot: options.projectIdsSnapshot,
      projectCount: options.projectIdsSnapshot.length,
      createdById: options.createdById,
    });

    const saved = await this.pdfRevisionEditDraftRepo.save(pdfRevisionEditDraft);
    const user = await this.userRepo.findOne({ where: { id: options.createdById }, select: ['id', 'firstname', 'lastname'] });

    return {
      version: saved.version, filePath: saved.filePath, fileUrl: `/v1/pdf/revision-edit-draft/${options.developmentPlanId}/${options.developmentPlanRevisionId}/latest/stream`,
      projectCount: saved.projectCount, createdAt: saved.createdAt.toISOString(),
      createdBy: user ? { id: user.id, firstname: user.firstname, lastname: user.lastname } : { id: options.createdById, firstname: '', lastname: '' },
    };
  }

  async getLatestRevisionEditDraftMeta(developmentPlanId: string, developmentPlanRevisionId: string): Promise<
    | { exists: false; }
    | { exists: true; version: number; fileUrl: string; projectCount: number; createdAt: string; projectIdsSnapshot: Array<string | number>; filePath: string; createdBy: { id: string; firstname: string; lastname: string }; }
  > {
    const latest = await this.pdfRevisionEditDraftRepo.findOne({
      where: { developmentPlanRevisionId: String(developmentPlanRevisionId) },
      order: { version: 'DESC' },
      relations: ['createdBy']
    });

    if (!latest) return { exists: false };
    return {
      exists: true, version: latest.version, fileUrl: `/v1/pdf/revision-edit-draft/${developmentPlanId}/${developmentPlanRevisionId}/latest/stream`,
      projectCount: latest.projectCount, createdAt: latest.createdAt.toISOString(), projectIdsSnapshot: latest.projectIdsSnapshot, filePath: latest.filePath,
      createdBy: { id: latest.createdBy.id, firstname: latest.createdBy.firstname, lastname: latest.createdBy.lastname }
    };
  }

  async readLatestRevisionEditDraftFile(developmentPlanId: string, developmentPlanRevisionId: string): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const meta = await this.getLatestRevisionEditDraftMeta(developmentPlanId, developmentPlanRevisionId);
    if (!meta || !meta.exists) return null;
    // Wave 3 BE-READERS — resolveStored handles legacy abs + new relative.
    const absPath = this.storagePathService.resolveStored(meta.filePath);
    return { filePath: meta.filePath, stream: fs.createReadStream(absPath) };
  }

  async getAllRevisionEditDraftVersions(developmentPlanId: string, developmentPlanRevisionId: string): Promise<Array<{ version: number; fileUrl: string; projectCount: number; createdAt: string; createdBy: { id: string; firstname: string; lastname: string }; }>> {
    const versions = await this.pdfRevisionEditDraftRepo.find({
      where: { developmentPlanRevisionId: String(developmentPlanRevisionId) },
      order: { version: 'DESC' },
      relations: ['createdBy']
    });

    return versions.map(v => ({
      version: v.version,
      fileUrl: `/v1/pdf/revision-edit-draft/${developmentPlanId}/${developmentPlanRevisionId}/${v.version}/stream`,
      projectCount: v.projectCount,
      createdAt: v.createdAt.toISOString(),
      createdBy: { id: v.createdBy.id, firstname: v.createdBy.firstname, lastname: v.createdBy.lastname }
    }));
  }

  async readRevisionEditDraftFileByVersion(version: number, developmentPlanId: string, developmentPlanRevisionId: string): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const draft = await this.pdfRevisionEditDraftRepo.findOne({
      where: { developmentPlanRevisionId: String(developmentPlanRevisionId), version },
      relations: ['createdBy']
    });
    if (!draft) return null;
    // Wave 3 BE-READERS — resolveStored handles legacy abs + new relative.
    const absPath = this.storagePathService.resolveStored(draft.filePath);
    return { filePath: draft.filePath, stream: fs.createReadStream(absPath) };
  }

  // ===================================================================
  // 🔄 11. Revision Change Draft Management (ร่างแผนเปลี่ยนแปลง)
  // ===================================================================

  async generateRevisionChangeDraftFromStatus(options: {
    developmentPlanId: string;
    developmentPlanRevisionId: string;
    createdById: string;
  }): Promise<{ version: number; filePath: string; fileUrl: string; projectCount: number; createdAt: string; createdBy: { id: string; firstname: string; lastname: string }; }> {
    const developmentPlanRevision = await this.developmentPlanRevisionRepo.findOne({
      where: { id: options.developmentPlanRevisionId },
      relations: ['developmentPlan', 'revisionType'],
    });

    if (!developmentPlanRevision) throw new Error(`DevelopmentPlanRevision with ID ${options.developmentPlanRevisionId} not found`);
    if (developmentPlanRevision.revisionType.name !== 'เปลี่ยนแปลง') throw new Error(`Revision type must be 'เปลี่ยนแปลง', but got '${developmentPlanRevision.revisionType.name}'`);
    if (developmentPlanRevision.developmentPlan.id !== options.developmentPlanId) throw new Error(`DevelopmentPlanRevision ${options.developmentPlanRevisionId} does not belong to DevelopmentPlan ${options.developmentPlanId}`);

    const revisionCount = await this.calculateRevisionCountByType(
      options.developmentPlanId, developmentPlanRevision.revisionType.name, developmentPlanRevision.revisionNumber
    );

    const projects = await this.findProjectsForRevisionChangeDraft(options.developmentPlanRevisionId);
    if (projects.length === 0) throw new Error('No projects found with status Pending_Approval or Approved');

    const selectedColumns = ['index', 'title', 'objective', 'target', 'budget', 'expectedResult', 'mainAgency'];
    const pdfBuffer = await this.generateRevisionChangeDraftReportWithColumns(
      options.developmentPlanRevisionId, selectedColumns,
    );
    const projectIdsSnapshot = projects.map(p => p.id);

    return this.saveRevisionChangeDraftPdfAndMeta({
      developmentPlanId: options.developmentPlanId,
      developmentPlanRevisionId: options.developmentPlanRevisionId,
      revisionTypeName: developmentPlanRevision.revisionType.name,
      revisionCount, pdfBuffer, projectIdsSnapshot, createdById: options.createdById,
    });
  }

  async generateRevisionChangeDraftReportWithColumns(
    developmentPlanRevisionId: string,
    selectedColumns: string[],
    existingProjects?: RevisedProjectGroup[]
  ): Promise<Buffer> {
    const developmentPlanRevision = await this.developmentPlanRevisionRepo.findOne({
      where: { id: developmentPlanRevisionId },
      relations: ['developmentPlan', 'revisionType'],
    });
    if (!developmentPlanRevision) throw new Error(`DevelopmentPlanRevision with ID ${developmentPlanRevisionId} not found`);

    const developmentPlanId = developmentPlanRevision.developmentPlan.id;
    const dp = await this.developmentPlanRepo.findOne({ where: { id: developmentPlanId } });
    if (!dp) throw new Error('DevelopmentPlan not found');

    const revisionTypeName = developmentPlanRevision.description || 'เปลี่ยนแปลง';
    const developmentPlanRevisionName = `${dp.name} ${revisionTypeName}`;

    // Resolve reportFormat from the parent plan
    const reportFormat = dp.reportFormat ?? ReportFormat.STRATEGY_BASED;

    let revisedProjects: RevisedProjectGroup[] = [];

    if (existingProjects) {
      revisedProjects = existingProjects;
    } else {
      revisedProjects = await this.revisedProjectGroupRepo.createQueryBuilder('revisedProject')
        .leftJoinAndSelect('revisedProject.developmentPlanRevision', 'developmentPlanRevision')
        .leftJoinAndSelect('developmentPlanRevision.developmentPlan', 'developmentPlan')
        .leftJoinAndSelect('developmentPlanRevision.revisionType', 'revisionType')
        .leftJoinAndSelect('revisedProject.projectGroup', 'projectGroup')
        .leftJoinAndSelect('revisedProject.strategy', 'strategy')
        .leftJoinAndSelect('revisedProject.tactic', 'tactic')
        .leftJoinAndSelect('revisedProject.plan', 'plan')
        .leftJoinAndSelect('revisedProject.developmentIssue', 'developmentIssue')
        .leftJoinAndSelect('revisedProject.budgets', 'budgets')
        .leftJoinAndSelect('revisedProject.responsibleAgency', 'responsibleAgency')
        .leftJoinAndSelect('revisedProject.originAgencyId', 'originAgencyId')
        .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
        .leftJoinAndSelect('revisedProject.trackingStatus', 'trackingStatus')
        .leftJoinAndSelect('trackingStatus.statusId', 'status')
        .where('developmentPlanRevision.id = :developmentPlanRevisionId', { developmentPlanRevisionId })
        .andWhere('revisionType.name = :revisionTypeName', { revisionTypeName: 'เปลี่ยนแปลง' })
        .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
        .andWhere('status.name IN (:...statusNames)', { statusNames: ['Pending_Approval', 'Approved'] })
        .orderBy('strategy.id', 'ASC')
        .getMany();
    }

    if (revisedProjects.length === 0) throw new Error('No projects found with status Pending_Approval or Approved');

    const projectsWithComparison = await Promise.all(
      revisedProjects.map(async (current) => this.findProjectComparisonForRevisionEdit(current, developmentPlanId))
    );
    const unifiedProjects = projectsWithComparison.map(p => p.current);

    const columnMap: Record<string, { text: string; key: string }> = {
      index: { text: 'ที่', key: 'index' },
      title: { text: 'โครงการ', key: 'title' },
      objective: { text: 'วัตถุประสงค์', key: 'objective' },
      target: { text: 'เป้าหมาย \n(ผลผลิตของโครงการ)', key: 'target' },
      budget: { text: 'งบประมาณ (บาท)', key: 'budget' },
      kpi: { text: 'ตัวชี้วัด (KPI)', key: 'kpi' },
      expectedResult: { text: 'ผลที่คาดว่าจะได้รับ', key: 'expectedResult' },
      mainAgency: { text: 'หน่วยงาน\nรับผิดชอบหลัก', key: 'mainAgency' },
      amphoe: { text: 'อำเภอ', key: 'amphoe' },
      coordinates: { text: 'พิกัดทาง \nภูมิศาสตร์', key: 'coordinates' },
    };

    const availableColumns = reportFormat === ReportFormat.ISSUE_BASED
      ? selectedColumns.filter(col => columnMap[col] && col !== 'kpi')
      : selectedColumns.filter(col => columnMap[col]);
    const fonts = this.getPdfFonts();
    const years = Array.from({ length: dp.endYear - dp.startYear + 1 }, (_, index) => dp.startYear + index);
    const pageMargins: [number, number, number, number] = [15, 60, 15, 40];
    const pageOrientation = 'landscape';

    const pdfBuffers: Buffer[] = [];
    let pageOffset = 0;

    if (reportFormat === ReportFormat.ISSUE_BASED) {
      // --- ISSUE_BASED path ---
      const { issues, overallSum, overallCount } = this.prepareIssueBasedReportAggregations(unifiedProjects, years);

      const summaryDoc = createIssueBasedRevisionEditSummaryPartDocDefinition({
        developmentPlanRevisionName, years, issues, overallSum, overallCount,
        pageMargins, pageOrientation, newWord: this.newWord.bind(this),
      });

      const groupedByIssue = new Map<string, typeof projectsWithComparison>();
      for (const project of projectsWithComparison) {
        const current = project.current;
        const issueName = current.developmentIssue?.name ?? 'ไม่ระบุประเด็น';
        if (!groupedByIssue.has(issueName)) groupedByIssue.set(issueName, []);
        groupedByIssue.get(issueName)!.push(project);
      }

      if (summaryDoc) {
        const summaryBuffer = await this.createPdfBuffer(summaryDoc, fonts);
        pdfBuffers.push(summaryBuffer);
        const summaryPdf = await PDFDocument.load(summaryBuffer);
        pageOffset += summaryPdf.getPageCount();
      }

      const sortedIssueEntries = [...groupedByIssue.entries()].sort((a, b) => {
        const sortA = issues.get(a[0])?.sortOrder ?? 999;
        const sortB = issues.get(b[0])?.sortOrder ?? 999;
        return sortA - sortB;
      });

      for (const [issueName, groupProjectsValue] of sortedIssueEntries) {
        const coverPageDoc = createIssueBasedRevisionGroupCoverPageDocDefinition(
          issueName, developmentPlanRevisionName, pageMargins, pageOrientation,
          this.newWord.bind(this), pageOffset,
        );
        const coverPageBuffer = await this.createPdfBuffer(coverPageDoc, fonts);
        pdfBuffers.push(coverPageBuffer);
        const coverPagePdf = await PDFDocument.load(coverPageBuffer);
        pageOffset += coverPagePdf.getPageCount();

        const detailDoc = createIssueBasedRevisionGroupDetailDocDefinition({
          developmentPlanRevisionName, years, groupProjects: groupProjectsValue, availableColumns, columnMap,
          pageMargins, pageOrientation, newWord: this.newWord.bind(this),
          reportType: 'inAuthority', issueName, pageOffset,
        });

        if (detailDoc) {
          const detailBuffer = await this.createPdfBuffer(detailDoc, fonts);
          pdfBuffers.push(detailBuffer);
          const detailPdf = await PDFDocument.load(detailBuffer);
          pageOffset += detailPdf.getPageCount();
        }
      }
    } else {
      // --- STRATEGY_BASED path (existing logic) ---
      const { strategies, overallSum, overallCount } = this.prepareReportAggregations(unifiedProjects, years);

      const summaryDoc = createRevisionEditSummaryPartDocDefinition({
        developmentPlanRevisionName, years, strategies, overallSum, overallCount,
        pageMargins, pageOrientation, newWord: this.newWord.bind(this),
      });

      const groupedProjects = new Map<string, typeof projectsWithComparison>();
      for (const project of projectsWithComparison) {
        const current = project.current;
        const groupKey = `${current.strategy?.name || '-'}||${current.tactic?.name || '-'}||${current.plan?.name || '-'}`;
        if (!groupedProjects.has(groupKey)) groupedProjects.set(groupKey, []);
        groupedProjects.get(groupKey)!.push(project);
      }

      if (summaryDoc) {
        const summaryBuffer = await this.createPdfBuffer(summaryDoc, fonts);
        pdfBuffers.push(summaryBuffer);
        const summaryPdf = await PDFDocument.load(summaryBuffer);
        pageOffset += summaryPdf.getPageCount();
      }

      for (const [groupKey, groupProjectsValue] of groupedProjects.entries()) {
        const [strategyName, tacticName, planName] = groupKey.split('||');
        const coverPageDoc = createRevisionEditGroupCoverPageDocDefinition(
          strategyName, developmentPlanRevisionName, pageMargins, pageOrientation,
          this.newWord.bind(this), pageOffset,
        );
        const coverPageBuffer = await this.createPdfBuffer(coverPageDoc, fonts);
        pdfBuffers.push(coverPageBuffer);
        const coverPagePdf = await PDFDocument.load(coverPageBuffer);
        pageOffset += coverPagePdf.getPageCount();

        const detailDoc = createRevisionEditGroupDetailDocDefinition({
          developmentPlanRevisionName, years, groupProjects: groupProjectsValue, availableColumns, columnMap,
          pageMargins, pageOrientation, newWord: this.newWord.bind(this),
          reportType: 'inAuthority', strategyName, tacticName, planName, pageOffset,
        });

        if (detailDoc) {
          const detailBuffer = await this.createPdfBuffer(detailDoc, fonts);
          pdfBuffers.push(detailBuffer);
          const detailPdf = await PDFDocument.load(detailBuffer);
          pageOffset += detailPdf.getPageCount();
        }
      }
    }

    if (pdfBuffers.length === 0) throw new Error('No PDF documents could be generated');
    return this.mergePdfBuffers(pdfBuffers);
  }

  async saveRevisionChangeDraftPdfAndMeta(options: {
    developmentPlanId: string;
    developmentPlanRevisionId: string;
    revisionTypeName: string;
    revisionCount: number;
    pdfBuffer: Buffer;
    projectIdsSnapshot: Array<string | number>;
    createdById: string;
  }): Promise<{ version: number; filePath: string; fileUrl: string; projectCount: number; createdAt: string; createdBy: { id: string; firstname: string; lastname: string }; }> {
    const developmentPlan = await this.developmentPlanRepo.findOne({ where: { id: options.developmentPlanId } });
    if (!developmentPlan) throw new Error(`DevelopmentPlan with ID ${options.developmentPlanId} not found`);

    const version = await this.getNextRevisionChangeDraftVersion(options.developmentPlanRevisionId);
    // Wave 3 BE-WRITERS — plan-rooted change-revision key. `revisionCount`
    // is the revision's ordinal (revisionNumber) within the change
    // sibling timeline.
    const fileName = `draft-${this.buildVersionedPdfFileName(version)}`;
    const fileKey = this.storagePathService.revisionVersionKey({
      planId: developmentPlan.id,
      revisionType: 'change',
      revisionNumber: options.revisionCount,
      revisionId: options.developmentPlanRevisionId,
      versionNumber: version,
      fileName,
    });
    await this.storagePathService.writeFile(fileKey, options.pdfBuffer);

    const pdfRevisionChangeDraft = this.pdfRevisionChangeDraftRepo.create({
      developmentPlanRevisionId: String(options.developmentPlanRevisionId),
      version,
      filePath: fileKey,
      projectIdsSnapshot: options.projectIdsSnapshot,
      projectCount: options.projectIdsSnapshot.length,
      createdById: options.createdById,
    });

    const saved = await this.pdfRevisionChangeDraftRepo.save(pdfRevisionChangeDraft);
    const user = await this.userRepo.findOne({ where: { id: options.createdById }, select: ['id', 'firstname', 'lastname'] });

    return {
      version: saved.version, filePath: saved.filePath, fileUrl: `/v1/pdf/revision-change-draft/${options.developmentPlanId}/${options.developmentPlanRevisionId}/latest/stream`,
      projectCount: saved.projectCount, createdAt: saved.createdAt.toISOString(),
      createdBy: user ? { id: user.id, firstname: user.firstname, lastname: user.lastname } : { id: options.createdById, firstname: '', lastname: '' },
    };
  }

  async getLatestRevisionChangeDraftMeta(developmentPlanId: string, developmentPlanRevisionId: string): Promise<
    | { exists: false; }
    | { exists: true; version: number; fileUrl: string; projectCount: number; createdAt: string; projectIdsSnapshot: Array<string | number>; filePath: string; createdBy: { id: string; firstname: string; lastname: string }; }
  > {
    const latest = await this.pdfRevisionChangeDraftRepo.findOne({
      where: { developmentPlanRevisionId: String(developmentPlanRevisionId) },
      order: { version: 'DESC' },
      relations: ['createdBy']
    });

    if (!latest) return { exists: false };
    return {
      exists: true, version: latest.version, fileUrl: `/v1/pdf/revision-change-draft/${developmentPlanId}/${developmentPlanRevisionId}/latest/stream`,
      projectCount: latest.projectCount, createdAt: latest.createdAt.toISOString(), projectIdsSnapshot: latest.projectIdsSnapshot, filePath: latest.filePath,
      createdBy: { id: latest.createdBy.id, firstname: latest.createdBy.firstname, lastname: latest.createdBy.lastname }
    };
  }

  async readLatestRevisionChangeDraftFile(developmentPlanId: string, developmentPlanRevisionId: string): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const meta = await this.getLatestRevisionChangeDraftMeta(developmentPlanId, developmentPlanRevisionId);
    if (!meta || !meta.exists) return null;
    // Wave 3 BE-READERS — resolveStored handles legacy abs + new relative.
    const absPath = this.storagePathService.resolveStored(meta.filePath);
    return { filePath: meta.filePath, stream: fs.createReadStream(absPath) };
  }

  async getAllRevisionChangeDraftVersions(developmentPlanId: string, developmentPlanRevisionId: string): Promise<Array<{ version: number; fileUrl: string; projectCount: number; createdAt: string; createdBy: { id: string; firstname: string; lastname: string }; }>> {
    const versions = await this.pdfRevisionChangeDraftRepo.find({
      where: { developmentPlanRevisionId: String(developmentPlanRevisionId) },
      order: { version: 'DESC' },
      relations: ['createdBy']
    });

    return versions.map(v => ({
      version: v.version,
      fileUrl: `/v1/pdf/revision-change-draft/${developmentPlanId}/${developmentPlanRevisionId}/${v.version}/stream`,
      projectCount: v.projectCount,
      createdAt: v.createdAt.toISOString(),
      createdBy: { id: v.createdBy.id, firstname: v.createdBy.firstname, lastname: v.createdBy.lastname }
    }));
  }

  async readRevisionChangeDraftFileByVersion(version: number, developmentPlanId: string, developmentPlanRevisionId: string): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const draft = await this.pdfRevisionChangeDraftRepo.findOne({
      where: { developmentPlanRevisionId: String(developmentPlanRevisionId), version },
      relations: ['createdBy']
    });
    if (!draft) return null;
    // Wave 3 BE-READERS — resolveStored handles legacy abs + new relative.
    const absPath = this.storagePathService.resolveStored(draft.filePath);
    return { filePath: draft.filePath, stream: fs.createReadStream(absPath) };
  }

  // ===================================================================
  // ✅ 12. Approved Plan Management (แผนพัฒนาฯ ฉบับอนุมัติ)
  // ===================================================================

  async saveApprovedPdfAndMetaForPlan(options: {
    developmentPlanId: string;
    pdfBuffer: Buffer;
    projectIdsSnapshot: Array<string | number>;
    originalProjectIds?: Array<string | number>;
    createdById: string;
    pageMap?: Map<string, number>;
  }): Promise<{ version: number; filePath: string; fileUrl: string; projectCount: number; createdAt: string; createdBy: { id: string; firstname: string; lastname: string }; }> {
    const developmentPlan = await this.developmentPlanRepo.findOne({ where: { id: options.developmentPlanId } });
    if (!developmentPlan) throw new Error(`DevelopmentPlan with ID ${options.developmentPlanId} not found`);
    const developmentPlanId = developmentPlan.id;

    const version = await this.getNextApprovedVersion(developmentPlanId);
    // Wave 3 BE-WRITERS — plan-rooted approved key. Approved sits in the
    // same `main-plan-{planId}/v{N}/` dir as siblings; the leaf prefix
    // keeps the legacy "approved/" subfolder semantic via filename.
    const fileName = `approved-${this.buildVersionedPdfFileName(version)}`;
    const fileKey = this.storagePathService.mainPlanVersionKey(
      developmentPlanId,
      version,
      fileName,
    );
    await this.storagePathService.writeFile(fileKey, options.pdfBuffer);

    const pdfApproved = this.pdfApprovedRepo.create({
      developmentPlanId: String(developmentPlanId),
      version,
      filePath: fileKey,
      projectIdsSnapshot: options.projectIdsSnapshot,
      projectCount: options.projectIdsSnapshot.length,
      createdById: options.createdById,
    });

    const saved = await this.pdfApprovedRepo.save(pdfApproved);

    const projectGroupIdsToUpdate = options.originalProjectIds && options.originalProjectIds.length > 0
      ? options.originalProjectIds
      : options.projectIdsSnapshot;

    // Wave 110 W110-BE-01 — wrap the finalize-time PG bookings + plan
    // `isBooked = true` flip in a single transaction with the
    // orphan-cleanup cascade. The cascade fires BEFORE the booking
    // writes per §18.2 + workflow doc Trigger Event 2. Sites covered:
    // approved-plan loop (per-page) and bulk fallback. CLAUDE.md
    // §18.2.1 lists the original line numbers (1428 / 2370 / 2376) —
    // post-W110 line numbers may drift slightly due to inserted
    // comments, but the call topology is identical.
    await this.orphanDataSource.transaction(async (manager) => {
      await this.orphanCleanupService.cascadeOnBookFinalize(
        developmentPlan,
        'PLAN',
        manager,
        options.createdById,
      );

      if (projectGroupIdsToUpdate && projectGroupIdsToUpdate.length > 0) {
        const pgRepoTx = manager.getRepository(ProjectGroup);
        if (options.pageMap) {
          for (const [projectId, pageNumber] of options.pageMap.entries()) {
            await pgRepoTx.update(
              { id: projectId },
              { isBooked: true, bookedAt: new Date(), pageNumber }
            );
          }
        } else {
          await pgRepoTx.update(
            { id: In(projectGroupIdsToUpdate) },
            { isBooked: true, bookedAt: new Date() }
          );
        }
      }

      await manager
        .getRepository(DevelopmentPlan)
        .update({ id: developmentPlanId }, { isBooked: true });
    });

    const user = await this.userRepo.findOne({ where: { id: options.createdById }, select: ['id', 'firstname', 'lastname'] });

    return {
      version: saved.version, filePath: saved.filePath, fileUrl: `/v1/pdf/approved/${developmentPlanId}/stream`, projectCount: saved.projectCount,
      createdAt: saved.createdAt.toISOString(),
      createdBy: user ? { id: user.id, firstname: user.firstname, lastname: user.lastname } : { id: options.createdById, firstname: '', lastname: '' },
    };
  }

  async deprecateApprovedPdfsForPlan(
    developmentPlanId: string,
    deprecatedById: string,
  ): Promise<{ deprecatedCount: number; deprecatedFiles: string[]; }> {
    const pdfs = await this.pdfApprovedRepo.find({
      where: { developmentPlanId: String(developmentPlanId), isDeprecated: false },
    });

    if (pdfs.length === 0) return { deprecatedCount: 0, deprecatedFiles: [] };

    const deprecatedFiles: string[] = [];
    const now = new Date();

    for (const pdf of pdfs) {
      try {
        // Wave 3 BE-WRITERS — preserve stored shape on rewrite.
        const oldStored = pdf.filePath;
        const oldAbs = this.storagePathService.resolveStored(oldStored);
        const dir = path.dirname(oldStored);
        const ext = path.extname(oldStored);
        const baseName = path.basename(oldStored, ext);
        const newFileName = `${baseName}.deprecated-${now.getTime()}${ext}`;
        const newStored = (dir === '.' || dir === '')
          ? newFileName
          : `${dir}/${newFileName}`;
        const newAbs = path.isAbsolute(oldStored)
          ? path.join(path.dirname(oldAbs), newFileName)
          : this.storagePathService.toAbsolute(newStored);

        try {
          await fsp.access(oldAbs);
          await fsp.rename(oldAbs, newAbs);
          deprecatedFiles.push(newStored);
        } catch (error) {
          this.logger.warn(`PDF file not found: ${oldAbs}, skipping rename`);
        }

        await this.pdfApprovedRepo.update(
          { id: pdf.id },
          { isDeprecated: true, deprecatedAt: now, deprecatedById: deprecatedById, filePath: newStored },
        );
      } catch (error: any) {
        this.logger.error(`Failed to deprecate PDF ${pdf.id}: ${error.message}`);
      }
    }

    return { deprecatedCount: pdfs.length, deprecatedFiles: deprecatedFiles };
  }

  async getLatestApprovedMetaForPlan(developmentPlanId: string): Promise<
    | { exists: false }
    | { exists: true; version: number; fileUrl: string; projectCount: number; createdAt: string; projectIdsSnapshot: Array<string | number>; filePath: string; createdBy: { id: string; firstname: string; lastname: string }; }
  > {
    const latest = await this.pdfApprovedRepo.findOne({
      where: { developmentPlanId: String(developmentPlanId), isDeprecated: false },
      order: { version: 'DESC' },
      relations: ['createdBy']
    });

    if (!latest) return { exists: false };
    return {
      exists: true, version: latest.version, fileUrl: `/v1/pdf/approved/${developmentPlanId}/stream`, projectCount: latest.projectCount,
      createdAt: latest.createdAt.toISOString(), projectIdsSnapshot: latest.projectIdsSnapshot, filePath: latest.filePath,
      createdBy: { id: latest.createdBy.id, firstname: latest.createdBy.firstname, lastname: latest.createdBy.lastname },
    };
  }

  async getAllApprovedVersions(): Promise<Array<{ version: number; fileUrl: string; projectCount: number; createdAt: string; createdBy: { id: string; firstname: string; lastname: string }; }>> {
    const dp = await this.getLatestDevelopmentPlanOrFail();
    const versions = await this.pdfApprovedRepo.find({
      where: { developmentPlanId: String(dp.id) },
      order: { version: 'DESC' },
      relations: ['createdBy']
    });

    return versions.map(v => ({
      version: v.version, fileUrl: `/v1/pdf/approved/${v.version}/stream`, projectCount: v.projectCount,
      createdAt: v.createdAt.toISOString(), createdBy: { id: v.createdBy.id, firstname: v.createdBy.firstname, lastname: v.createdBy.lastname }
    }));
  }

  async readApprovedFileByVersion(version: number): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const dp = await this.getLatestDevelopmentPlanOrFail();
    const approved = await this.pdfApprovedRepo.findOne({
      where: { developmentPlanId: String(dp.id), version },
      relations: ['createdBy']
    });

    if (!approved) return null;
    // Wave 3 BE-READERS — resolveStored handles legacy abs + new relative.
    const absPath = this.storagePathService.resolveStored(approved.filePath);
    return { filePath: approved.filePath, stream: fs.createReadStream(absPath) };
  }

  async readLatestApprovedFileForPlan(developmentPlanId: string): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const meta = await this.getLatestApprovedMetaForPlan(developmentPlanId);
    if (!meta || !meta.exists) return null;

    // Wave 3 BE-READERS — resolveStored handles legacy abs + new relative.
    const absPath = this.storagePathService.resolveStored(meta.filePath);
    try {
      await fsp.access(absPath);
      return { filePath: meta.filePath, stream: fs.createReadStream(absPath) };
    } catch (error) {
      this.logger.warn(`PDF file not found: ${meta.filePath} (resolved: ${absPath})`);
      return null;
    }
  }

  // ===================================================================
  // ✅ 13. Revision Edit Approved Management (แผนแก้ไข ฉบับอนุมัติ)
  // ===================================================================

  async generateRevisionApprovedReportWithColumns(
    developmentPlanRevisionId: string,
    selectedColumns: string[],
  ): Promise<Buffer> {
    const developmentPlanRevision = await this.developmentPlanRevisionRepo.findOne({
      where: { id: developmentPlanRevisionId },
      relations: ['developmentPlan', 'revisionType'],
    });

    if (!developmentPlanRevision) throw new Error(`DevelopmentPlanRevision with ID ${developmentPlanRevisionId} not found`);

    const developmentPlanId = developmentPlanRevision.developmentPlan.id;
    const dp = await this.developmentPlanRepo.findOne({ where: { id: developmentPlanId } });
    if (!dp) throw new Error('DevelopmentPlan not found');

    // Resolve reportFormat from the parent plan
    const reportFormat = dp.reportFormat ?? ReportFormat.STRATEGY_BASED;

    const revisionTypeName = developmentPlanRevision.description || developmentPlanRevision.revisionType?.name || 'แก้ไข';
    const developmentPlanRevisionName = `${dp.name} ${revisionTypeName}`;

    const revisedProjects = await this.revisedProjectGroupRepo.createQueryBuilder('revisedProject')
      .leftJoinAndSelect('revisedProject.developmentPlanRevision', 'developmentPlanRevision')
      .leftJoinAndSelect('developmentPlanRevision.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('developmentPlanRevision.revisionType', 'revisionType')
      .leftJoinAndSelect('revisedProject.projectGroup', 'projectGroup')
      .leftJoinAndSelect('revisedProject.strategy', 'strategy')
      .leftJoinAndSelect('revisedProject.tactic', 'tactic')
      .leftJoinAndSelect('revisedProject.plan', 'plan')
      .leftJoinAndSelect('revisedProject.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('revisedProject.budgets', 'budgets')
      .leftJoinAndSelect('revisedProject.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('revisedProject.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .leftJoinAndSelect('revisedProject.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .where('developmentPlanRevision.id = :developmentPlanRevisionId', { developmentPlanRevisionId })
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :statusName', { statusName: 'Approved' })
      .getMany();

    if (revisedProjects.length === 0) throw new BadRequestException('ไม่พบโครงการที่มีสถานะอนุมัติ');

    const projectsWithComparison = await Promise.all(
      revisedProjects.map(async (current) => this.findProjectComparisonForRevisionEdit(current, developmentPlanId))
    );
    const unifiedProjects = projectsWithComparison.map(p => p.current);

    const columnMap: Record<string, { text: string; key: string }> = {
      index: { text: 'ที่', key: 'index' },
      title: { text: 'โครงการ', key: 'title' },
      objective: { text: 'วัตถุประสงค์', key: 'objective' },
      target: { text: 'เป้าหมาย \n(ผลผลิตของโครงการ)', key: 'target' },
      budget: { text: 'งบประมาณ (บาท)', key: 'budget' },
      kpi: { text: 'ตัวชี้วัด (KPI)', key: 'kpi' },
      expectedResult: { text: 'ผลที่คาดว่าจะได้รับ', key: 'expectedResult' },
      mainAgency: { text: 'หน่วยงาน\nรับผิดชอบหลัก', key: 'mainAgency' },
      amphoe: { text: 'อำเภอ', key: 'amphoe' },
      coordinates: { text: 'พิกัดทาง \nภูมิศาสตร์', key: 'coordinates' },
    };

    const availableColumns = reportFormat === ReportFormat.ISSUE_BASED
      ? selectedColumns.filter(col => columnMap[col] && col !== 'kpi')
      : selectedColumns.filter(col => columnMap[col]);
    const fonts = this.getPdfFonts();
    const years = Array.from({ length: dp.endYear - dp.startYear + 1 }, (_, index) => dp.startYear + index);
    const pageMargins: [number, number, number, number] = [15, 60, 15, 40];
    const pageOrientation = 'landscape';

    const pdfBuffers: Buffer[] = [];
    let pageOffset = 0;

    if (reportFormat === ReportFormat.ISSUE_BASED) {
      // --- ISSUE_BASED path ---
      const { issues, overallSum, overallCount } = this.prepareIssueBasedReportAggregations(unifiedProjects, years);

      const summaryDoc = createIssueBasedRevisionEditSummaryPartDocDefinition({
        developmentPlanRevisionName, years, issues, overallSum, overallCount,
        pageMargins, pageOrientation, newWord: this.newWord.bind(this),
      });

      const groupedByIssue = new Map<string, typeof projectsWithComparison>();
      for (const project of projectsWithComparison) {
        const current = project.current;
        const issueName = current.developmentIssue?.name ?? 'ไม่ระบุประเด็น';
        if (!groupedByIssue.has(issueName)) groupedByIssue.set(issueName, []);
        groupedByIssue.get(issueName)!.push(project);
      }

      if (summaryDoc) {
        const summaryBuffer = await this.createPdfBuffer(summaryDoc, fonts);
        pdfBuffers.push(summaryBuffer);
        const summaryPdf = await PDFDocument.load(summaryBuffer);
        pageOffset += summaryPdf.getPageCount();
      }

      const sortedIssueEntries = [...groupedByIssue.entries()].sort((a, b) => {
        const sortA = issues.get(a[0])?.sortOrder ?? 999;
        const sortB = issues.get(b[0])?.sortOrder ?? 999;
        return sortA - sortB;
      });

      for (const [issueName, groupProjectsValue] of sortedIssueEntries) {
        const coverPageDoc = createIssueBasedRevisionGroupCoverPageDocDefinition(
          issueName, developmentPlanRevisionName, pageMargins, pageOrientation,
          this.newWord.bind(this), pageOffset,
        );
        const coverPageBuffer = await this.createPdfBuffer(coverPageDoc, fonts);
        pdfBuffers.push(coverPageBuffer);
        const coverPagePdf = await PDFDocument.load(coverPageBuffer);
        pageOffset += coverPagePdf.getPageCount();

        const detailDoc = createIssueBasedRevisionGroupDetailDocDefinition({
          developmentPlanRevisionName, years, groupProjects: groupProjectsValue, availableColumns, columnMap,
          pageMargins, pageOrientation, newWord: this.newWord.bind(this),
          reportType: 'inAuthority', issueName, pageOffset,
        });

        if (detailDoc) {
          const detailBuffer = await this.createPdfBuffer(detailDoc, fonts);
          pdfBuffers.push(detailBuffer);
          const detailPdf = await PDFDocument.load(detailBuffer);
          pageOffset += detailPdf.getPageCount();
        }
      }
    } else {
      // --- STRATEGY_BASED path (existing logic) ---
      const { strategies, overallSum, overallCount } = this.prepareReportAggregations(unifiedProjects, years);

      const summaryDoc = createRevisionEditSummaryPartDocDefinition({
        developmentPlanRevisionName, years, strategies, overallSum, overallCount,
        pageMargins, pageOrientation, newWord: this.newWord.bind(this),
      });

      const groupedProjects = new Map<string, typeof projectsWithComparison>();
      for (const project of projectsWithComparison) {
        const current = project.current;
        const groupKey = `${current.strategy?.name || '-'}||${current.tactic?.name || '-'}||${current.plan?.name || '-'}`;
        if (!groupedProjects.has(groupKey)) groupedProjects.set(groupKey, []);
        groupedProjects.get(groupKey)!.push(project);
      }

      if (summaryDoc) {
        const summaryBuffer = await this.createPdfBuffer(summaryDoc, fonts);
        pdfBuffers.push(summaryBuffer);
        const summaryPdf = await PDFDocument.load(summaryBuffer);
        pageOffset += summaryPdf.getPageCount();
      }

      for (const [groupKey, groupProjectsValue] of groupedProjects.entries()) {
        const [strategyName, tacticName, planName] = groupKey.split('||');
        const coverPageDoc = createRevisionEditGroupCoverPageDocDefinition(
          strategyName, developmentPlanRevisionName, pageMargins, pageOrientation,
          this.newWord.bind(this), pageOffset,
        );
        const coverPageBuffer = await this.createPdfBuffer(coverPageDoc, fonts);
        pdfBuffers.push(coverPageBuffer);
        const coverPagePdf = await PDFDocument.load(coverPageBuffer);
        pageOffset += coverPagePdf.getPageCount();

        const detailDoc = createRevisionEditGroupDetailDocDefinition({
          developmentPlanRevisionName, years, groupProjects: groupProjectsValue, availableColumns, columnMap,
          pageMargins, pageOrientation, newWord: this.newWord.bind(this),
          reportType: 'inAuthority', strategyName, tacticName, planName, pageOffset,
        });

        if (detailDoc) {
          const detailBuffer = await this.createPdfBuffer(detailDoc, fonts);
          pdfBuffers.push(detailBuffer);
          const detailPdf = await PDFDocument.load(detailBuffer);
          pageOffset += detailPdf.getPageCount();
        }
      }
    }

    if (pdfBuffers.length === 0) throw new Error('No PDF documents could be generated');
    return this.mergePdfBuffers(pdfBuffers);
  }

  async generateRevisionApprovedReportWithPageTracking(
    developmentPlanRevisionId: string,
    selectedColumns: string[],
  ): Promise<{ buffer: Buffer; pageMap: Map<string, number> }> {
    const developmentPlanRevision = await this.developmentPlanRevisionRepo.findOne({
      where: { id: developmentPlanRevisionId },
      relations: ['developmentPlan', 'revisionType'],
    });

    if (!developmentPlanRevision) throw new Error(`DevelopmentPlanRevision with ID ${developmentPlanRevisionId} not found`);

    const developmentPlanId = developmentPlanRevision.developmentPlan.id;
    const dp = await this.developmentPlanRepo.findOne({ where: { id: developmentPlanId } });
    if (!dp) throw new Error('DevelopmentPlan not found');

    // Resolve reportFormat from the parent plan
    const reportFormat = dp.reportFormat ?? ReportFormat.STRATEGY_BASED;

    const revisionTypeName = developmentPlanRevision.description || developmentPlanRevision.revisionType?.name || 'แก้ไข';
    const developmentPlanRevisionName = `${dp.name} ${revisionTypeName}`;

    const revisedProjects = await this.revisedProjectGroupRepo.createQueryBuilder('revisedProject')
      .leftJoinAndSelect('revisedProject.developmentPlanRevision', 'developmentPlanRevision')
      .leftJoinAndSelect('developmentPlanRevision.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('developmentPlanRevision.revisionType', 'revisionType')
      .leftJoinAndSelect('revisedProject.projectGroup', 'projectGroup')
      .leftJoinAndSelect('revisedProject.strategy', 'strategy')
      .leftJoinAndSelect('revisedProject.tactic', 'tactic')
      .leftJoinAndSelect('revisedProject.plan', 'plan')
      .leftJoinAndSelect('revisedProject.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('revisedProject.budgets', 'budgets')
      .leftJoinAndSelect('revisedProject.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('revisedProject.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .leftJoinAndSelect('revisedProject.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .where('developmentPlanRevision.id = :developmentPlanRevisionId', { developmentPlanRevisionId })
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :statusName', { statusName: 'Approved' })
      .getMany();

    if (revisedProjects.length === 0) throw new BadRequestException('ไม่พบโครงการที่มีสถานะอนุมัติ');

    const projectsWithComparison = await Promise.all(
      revisedProjects.map(async (current) => this.findProjectComparisonForRevisionEdit(current, developmentPlanId))
    );
    const unifiedProjects = projectsWithComparison.map(p => p.current);

    const columnMap: Record<string, { text: string; key: string }> = {
      index: { text: 'ที่', key: 'index' },
      title: { text: 'โครงการ', key: 'title' },
      objective: { text: 'วัตถุประสงค์', key: 'objective' },
      target: { text: 'เป้าหมาย \n(ผลผลิตของโครงการ)', key: 'target' },
      budget: { text: 'งบประมาณ (บาท)', key: 'budget' },
      kpi: { text: 'ตัวชี้วัด (KPI)', key: 'kpi' },
      expectedResult: { text: 'ผลที่คาดว่าจะได้รับ', key: 'expectedResult' },
      mainAgency: { text: 'หน่วยงาน\nรับผิดชอบหลัก', key: 'mainAgency' },
      amphoe: { text: 'อำเภอ', key: 'amphoe' },
      coordinates: { text: 'พิกัดทาง \nภูมิศาสตร์', key: 'coordinates' },
    };

    const availableColumns = reportFormat === ReportFormat.ISSUE_BASED
      ? selectedColumns.filter(col => columnMap[col] && col !== 'kpi')
      : selectedColumns.filter(col => columnMap[col]);
    const fonts = this.getPdfFonts();
    const years = Array.from({ length: dp.endYear - dp.startYear + 1 }, (_, index) => dp.startYear + index);
    const pageMargins: [number, number, number, number] = [15, 60, 15, 40];
    const pageOrientation = 'landscape';

    const pdfBuffers: Buffer[] = [];
    const pageMap = new Map<string, number>();
    let pageOffset = 0;

    if (reportFormat === ReportFormat.ISSUE_BASED) {
      // --- ISSUE_BASED path with page tracking ---
      const { issues, overallSum, overallCount } = this.prepareIssueBasedReportAggregations(unifiedProjects, years);

      const summaryDoc = createIssueBasedRevisionEditSummaryPartDocDefinition({
        developmentPlanRevisionName, years, issues, overallSum, overallCount,
        pageMargins, pageOrientation, newWord: this.newWord.bind(this),
      });

      const groupedByIssue = new Map<string, typeof projectsWithComparison>();
      for (const project of projectsWithComparison) {
        const current = project.current;
        const issueName = current.developmentIssue?.name ?? 'ไม่ระบุประเด็น';
        if (!groupedByIssue.has(issueName)) groupedByIssue.set(issueName, []);
        groupedByIssue.get(issueName)!.push(project);
      }

      if (summaryDoc) {
        const summaryBuffer = await this.createPdfBuffer(summaryDoc, fonts);
        pdfBuffers.push(summaryBuffer);
        const summaryPdf = await PDFDocument.load(summaryBuffer);
        pageOffset += summaryPdf.getPageCount();
      }

      const sortedIssueEntries = [...groupedByIssue.entries()].sort((a, b) => {
        const sortA = issues.get(a[0])?.sortOrder ?? 999;
        const sortB = issues.get(b[0])?.sortOrder ?? 999;
        return sortA - sortB;
      });

      for (const [issueName, groupProjectsValue] of sortedIssueEntries) {
        const coverPageDoc = createIssueBasedRevisionGroupCoverPageDocDefinition(
          issueName, developmentPlanRevisionName, pageMargins, pageOrientation,
          this.newWord.bind(this), pageOffset,
        );
        const coverPageBuffer = await this.createPdfBuffer(coverPageDoc, fonts);
        pdfBuffers.push(coverPageBuffer);
        const coverPagePdf = await PDFDocument.load(coverPageBuffer);
        pageOffset += coverPagePdf.getPageCount();

        for (const project of groupProjectsValue) {
          pageMap.set(project.current.id, pageOffset + 1);

          const detailDoc = createIssueBasedRevisionGroupDetailDocDefinition({
            developmentPlanRevisionName, years, groupProjects: [project], availableColumns, columnMap,
            pageMargins, pageOrientation, newWord: this.newWord.bind(this),
            reportType: 'inAuthority', issueName, pageOffset,
          });

          if (detailDoc) {
            const detailBuffer = await this.createPdfBuffer(detailDoc, fonts);
            pdfBuffers.push(detailBuffer);
            const detailPdf = await PDFDocument.load(detailBuffer);
            pageOffset += detailPdf.getPageCount();
          }
        }
      }
    } else {
      // --- STRATEGY_BASED path (existing logic) ---
      const { strategies, overallSum, overallCount } = this.prepareReportAggregations(unifiedProjects, years);

      const summaryDoc = createRevisionEditSummaryPartDocDefinition({
        developmentPlanRevisionName, years, strategies, overallSum, overallCount,
        pageMargins, pageOrientation, newWord: this.newWord.bind(this),
      });

      const groupedProjects = new Map<string, typeof projectsWithComparison>();
      for (const project of projectsWithComparison) {
        const current = project.current;
        const groupKey = `${current.strategy?.name || '-'}||${current.tactic?.name || '-'}||${current.plan?.name || '-'}`;
        if (!groupedProjects.has(groupKey)) groupedProjects.set(groupKey, []);
        groupedProjects.get(groupKey)!.push(project);
      }

      if (summaryDoc) {
        const summaryBuffer = await this.createPdfBuffer(summaryDoc, fonts);
        pdfBuffers.push(summaryBuffer);
        const summaryPdf = await PDFDocument.load(summaryBuffer);
        pageOffset += summaryPdf.getPageCount();
      }

      for (const [groupKey, groupProjectsValue] of groupedProjects.entries()) {
        const [strategyName, tacticName, planName] = groupKey.split('||');

        const coverPageDoc = createRevisionEditGroupCoverPageDocDefinition(
          strategyName, developmentPlanRevisionName, pageMargins, pageOrientation,
          this.newWord.bind(this), pageOffset,
        );
        const coverPageBuffer = await this.createPdfBuffer(coverPageDoc, fonts);
        pdfBuffers.push(coverPageBuffer);
        const coverPagePdf = await PDFDocument.load(coverPageBuffer);
        pageOffset += coverPagePdf.getPageCount();

        for (const project of groupProjectsValue) {
          pageMap.set(project.current.id, pageOffset + 1);

          const detailDoc = createRevisionEditGroupDetailDocDefinition({
            developmentPlanRevisionName, years, groupProjects: [project], availableColumns, columnMap,
            pageMargins, pageOrientation, newWord: this.newWord.bind(this),
            reportType: 'inAuthority', strategyName, tacticName, planName, pageOffset,
          });

          if (detailDoc) {
            const detailBuffer = await this.createPdfBuffer(detailDoc, fonts);
            pdfBuffers.push(detailBuffer);
            const detailPdf = await PDFDocument.load(detailBuffer);
            pageOffset += detailPdf.getPageCount();
          }
        }
      }
    }

    if (pdfBuffers.length === 0) throw new Error('No PDF documents could be generated');
    const mergedBuffer = await this.mergePdfBuffers(pdfBuffers);
    
    return { buffer: mergedBuffer, pageMap };
  }

  async saveRevisionEditApprovedPdfAndMeta(options: {
    developmentPlanId: string;
    developmentPlanRevisionId: string;
    pdfBuffer: Buffer;
    projectIdsSnapshot: Array<string | number>;
    createdById: string;
    editNo: number;
    originalProjectIds?: Array<string | number>;
    pageMap?: Map<string, number>;
  }): Promise<{ version: number; filePath: string; fileUrl: string; projectCount: number; createdAt: string; createdBy: { id: string; firstname: string; lastname: string }; }> {

    const developmentPlan = await this.developmentPlanRepo.findOne({ where: { id: options.developmentPlanId } });
    if (!developmentPlan) throw new Error(`DevelopmentPlan with ID ${options.developmentPlanId} not found`);

    const version = await this.getNextRevisionEditApprovedVersion(options.developmentPlanRevisionId);
    // Wave 3 BE-WRITERS — plan-rooted edit-revision approved key.
    const fileName = `approved-${this.buildVersionedPdfFileName(version)}`;
    const fileKey = this.storagePathService.revisionVersionKey({
      planId: developmentPlan.id,
      revisionType: 'edit',
      revisionNumber: options.editNo,
      revisionId: options.developmentPlanRevisionId,
      versionNumber: version,
      fileName,
    });
    await this.storagePathService.writeFile(fileKey, options.pdfBuffer);

    const pdfRevisionEditApproved = this.pdfRevisionEditApprovedRepo.create({
      developmentPlanRevisionId: String(options.developmentPlanRevisionId),
      version,
      filePath: fileKey,
      projectIdsSnapshot: options.projectIdsSnapshot,
      projectCount: options.projectIdsSnapshot.length,
      createdById: options.createdById,
    });

    const saved = await this.pdfRevisionEditApprovedRepo.save(pdfRevisionEditApproved);

    // Update pageNumber for each project if pageMap is provided
    if (options.pageMap && options.pageMap.size > 0) {
      for (const [projectId, pageNumber] of options.pageMap.entries()) {
        await this.revisedProjectGroupRepo.update(projectId, { pageNumber });
      }
    }

    const user = await this.userRepo.findOne({
      where: { id: options.createdById },
      select: ['id', 'firstname', 'lastname']
    });

    return {
      version: saved.version,
      filePath: saved.filePath,
      fileUrl: `/v1/pdf/revision-edit-approved/${options.developmentPlanId}/${options.developmentPlanRevisionId}/latest/stream`,
      projectCount: saved.projectCount,
      createdAt: saved.createdAt.toISOString(),
      createdBy: user ? { id: user.id, firstname: user.firstname, lastname: user.lastname } : { id: options.createdById, firstname: '', lastname: '' },
    };
  }

  async getLatestApprovedMetaForEditRevision(developmentPlanRevisionId: string): Promise<
    | { exists: false }
    | { exists: true; version: number; fileUrl: string; projectCount: number; createdAt: string; projectIdsSnapshot: Array<string | number>; filePath: string; createdBy: { id: string; firstname: string; lastname: string }; }
  > {
    const latest = await this.pdfRevisionEditApprovedRepo.findOne({
      where: { developmentPlanRevisionId: String(developmentPlanRevisionId) },
      order: { version: 'DESC' },
      relations: ['createdBy']
    });

    if (!latest) return { exists: false };

    const revision = await this.developmentPlanRevisionRepo.findOne({
      where: { id: developmentPlanRevisionId },
      relations: ['developmentPlan'],
    });
    const developmentPlanId = revision?.developmentPlan?.id || 'unknown';

    return {
      exists: true,
      version: latest.version,
      fileUrl: `/v1/pdf/revision-edit-approved/${developmentPlanId}/${developmentPlanRevisionId}/latest/stream`,
      projectCount: latest.projectCount,
      createdAt: latest.createdAt.toISOString(),
      projectIdsSnapshot: latest.projectIdsSnapshot,
      filePath: latest.filePath,
      createdBy: { id: latest.createdBy.id, firstname: latest.createdBy.firstname, lastname: latest.createdBy.lastname }
    };
  }

  async readLatestApprovedFileForEditRevision(developmentPlanRevisionId: string): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const meta = await this.getLatestApprovedMetaForEditRevision(developmentPlanRevisionId);
    if (!meta || !meta.exists) return null;
    // Wave 3 BE-READERS — resolveStored handles legacy abs + new relative.
    const absPath = this.storagePathService.resolveStored(meta.filePath);
    return { filePath: meta.filePath, stream: fs.createReadStream(absPath) };
  }

  // ===================================================================
  // ✅ 14. Revision Change Approved Management (แผนเปลี่ยนแปลง ฉบับอนุมัติ)
  // ===================================================================

  async saveRevisionChangeApprovedPdfAndMeta(options: {
    developmentPlanId: string;
    developmentPlanRevisionId: string;
    pdfBuffer: Buffer;
    projectIdsSnapshot: Array<string | number>;
    createdById: string;
    changeNo: number;
    originalProjectIds?: Array<string | number>;
    pageMap?: Map<string, number>;
  }): Promise<{ version: number; filePath: string; fileUrl: string; projectCount: number; createdAt: string; createdBy: { id: string; firstname: string; lastname: string }; }> {

    const developmentPlan = await this.developmentPlanRepo.findOne({ where: { id: options.developmentPlanId } });
    if (!developmentPlan) throw new Error(`DevelopmentPlan with ID ${options.developmentPlanId} not found`);

    const version = await this.getNextRevisionChangeApprovedVersion(options.developmentPlanRevisionId);
    // Wave 3 BE-WRITERS — plan-rooted change-revision approved key.
    const fileName = `approved-${this.buildVersionedPdfFileName(version)}`;
    const fileKey = this.storagePathService.revisionVersionKey({
      planId: developmentPlan.id,
      revisionType: 'change',
      revisionNumber: options.changeNo,
      revisionId: options.developmentPlanRevisionId,
      versionNumber: version,
      fileName,
    });
    await this.storagePathService.writeFile(fileKey, options.pdfBuffer);

    const pdfRevisionChangeApproved = this.pdfRevisionChangeApprovedRepo.create({
      developmentPlanRevisionId: String(options.developmentPlanRevisionId),
      version,
      filePath: fileKey,
      projectIdsSnapshot: options.projectIdsSnapshot,
      projectCount: options.projectIdsSnapshot.length,
      createdById: options.createdById,
    });

    const saved = await this.pdfRevisionChangeApprovedRepo.save(pdfRevisionChangeApproved);

    // Update pageNumber for each project if pageMap is provided
    if (options.pageMap && options.pageMap.size > 0) {
      for (const [projectId, pageNumber] of options.pageMap.entries()) {
        await this.revisedProjectGroupRepo.update(projectId, { pageNumber });
      }
    }

    const user = await this.userRepo.findOne({
      where: { id: options.createdById },
      select: ['id', 'firstname', 'lastname']
    });

    return {
      version: saved.version,
      filePath: saved.filePath,
      fileUrl: `/v1/pdf/revision-change-approved/${options.developmentPlanId}/${options.developmentPlanRevisionId}/latest/stream`,
      projectCount: saved.projectCount,
      createdAt: saved.createdAt.toISOString(),
      createdBy: user ? { id: user.id, firstname: user.firstname, lastname: user.lastname } : { id: options.createdById, firstname: '', lastname: '' },
    };
  }

  async getLatestApprovedMetaForChangeRevision(developmentPlanRevisionId: string): Promise<
    | { exists: false }
    | { exists: true; version: number; fileUrl: string; projectCount: number; createdAt: string; projectIdsSnapshot: Array<string | number>; filePath: string; createdBy: { id: string; firstname: string; lastname: string }; }
  > {
    const latest = await this.pdfRevisionChangeApprovedRepo.findOne({
      where: { developmentPlanRevisionId: String(developmentPlanRevisionId) },
      order: { version: 'DESC' },
      relations: ['createdBy']
    });

    if (!latest) return { exists: false };

    const revision = await this.developmentPlanRevisionRepo.findOne({
      where: { id: developmentPlanRevisionId },
      relations: ['developmentPlan'],
    });
    const developmentPlanId = revision?.developmentPlan?.id || 'unknown';

    return {
      exists: true,
      version: latest.version,
      fileUrl: `/v1/pdf/revision-change-approved/${developmentPlanId}/${developmentPlanRevisionId}/latest/stream`,
      projectCount: latest.projectCount,
      createdAt: latest.createdAt.toISOString(),
      projectIdsSnapshot: latest.projectIdsSnapshot,
      filePath: latest.filePath,
      createdBy: { id: latest.createdBy.id, firstname: latest.createdBy.firstname, lastname: latest.createdBy.lastname }
    };
  }

  async readLatestApprovedFileForChangeRevision(developmentPlanRevisionId: string): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const meta = await this.getLatestApprovedMetaForChangeRevision(developmentPlanRevisionId);
    if (!meta || !meta.exists) return null;
    // Wave 3 BE-READERS — resolveStored handles legacy abs + new relative.
    const absPath = this.storagePathService.resolveStored(meta.filePath);
    return { filePath: meta.filePath, stream: fs.createReadStream(absPath) };
  }

}
