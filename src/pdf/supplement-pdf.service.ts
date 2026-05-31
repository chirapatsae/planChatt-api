// ===================================================================
// SupplementPdfService — SUPP_PRINT_BE_01
// ===================================================================
//
// Draft + Approved PDF pipeline for `DevelopmentPlanSupplement`.
//
// Mirrors `PdfService.generateRevisionEditDraftFromStatus` (draft) and
// `PdfService.generateOutAuthorityFromStatus` / `saveApprovedPdfAndMetaForPlan`
// (approved finalize, single-click per Q5=B).
//
// Locked decisions referenced inline:
//   - Q2 = default flavor only (draft + approved; out-authority deferred
//     to SUPP_PRINT_WAVE_B)
//   - Q3 = cover label string is owned by BE_02 renderer; service passes
//     supplement + parent plan context to renderer
//   - Q4 = Approved finalize only — no Rejected / out-authority variant
//   - Q5 = Single-click finalize (no 3-part wizard)
//   - Q6 = `pageNumber` 1..N assigned at finalize-time by the same sort
//     the renderer uses
//   - Q7 = Attachment filename list only (no thumbnails) — renderer
//     concern, this service simply joins attachments for the renderer
//   - Q8 = Admin + super-admin only — enforced in BE_03 controller
//   - Q9 = Cascade-before-isBooked — orphan cleanup runs BEFORE the
//     `isBooked = true` flip inside the same transaction
//
// CLAUDE.md compliance:
//   - §12 audit — this service does NOT write `tracking_status`. The
//     cascade writes it; finalize itself is NOT a project-status
//     transition.
//   - §14 lineage lock — read-only; SPGs have no lineage descendants
//     in the current schema, but the cascade delegates to
//     `LineageLockService` defensively.
//   - §15 book lineage — `BookLockService.assertEditable` runs on
//     finalize to reject locked rounds (§15.4). Draft generation is
//     read-only and works on locked rounds per §15.5 read exemption.
//   - §16.5 classification shape — the renderer branches on
//     `parentPlan.reportFormat`; the service surfaces it.
//   - §17 — no AI side-effects. No `TrackingStatus` writes from this
//     service. PII is limited to a WorkHistory-adjacent `User` lookup
//     for the createdBy display.
//   - §18 — finalize wraps cascade-before-isBooked inside a single
//     `dataSource.transaction(...)` boundary so the cascade and
//     `isBooked = true` commit or roll back atomically.
//   - PII / §17 — `createdById` is the authenticated user's id and
//     MUST be supplied by the controller (BE_03 controller
//     responsibility per task §9). The service does not introspect
//     the request.
// ===================================================================

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { promises as fsp } from 'fs';

import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { User } from 'src/users/entities/user.entity';

import { PdfSupplementDraftDocument } from './entities/pdf-supplement-draft-document.entity';
import { PdfSupplementApprovedDocument } from './entities/pdf-supplement-approved-document.entity';

import {
  BookLockService,
  BOOK_HAS_NEWER_REVISION,
} from 'src/common/book-lock/book-lock.service';
import { STATUS_NAMES } from 'src/common/status-names';
import { ReportFormat } from 'src/development-plan/types/report-format.enum';

// Wave 3 BE-READERS — storage path resolution for the new plan-rooted
// hierarchy (umbrella §7.3). `resolveStored` accepts legacy absolute
// paths AND new relative keys during the migration window.
import { StoragePathService } from 'src/storage/storage-path.service';

// BE-SUPP-01 — external alignment block (NS / MS / SDG / PS) for the
// STRATEGY_BASED supplement detail renderer. One `resolveMany` call per
// PDF render; per-group rows are looked up by name-key. ISSUE_BASED
// supplements are untouched.
import { AlignmentResolverService } from 'src/project-alignment-mapping/alignment-resolver.service';
import {
  AlignmentRow,
  AlignmentTriple,
  buildTripleKey,
} from 'src/project-alignment-mapping/types/alignment.types';

// SUPP_PRINT_BE_01b — renderer wiring. The supplement PDF is composed
// of three doc-definitions (cover → summary → detail) merged via pdf-lib,
// matching the pattern used by `PdfService.generateProjectsReport*`
// (`pdf.service.ts:~950–1066`). All renderer parts are stateless and
// were delivered by SUPP_PRINT_BE_02.
import { PDFDocument } from 'pdf-lib';
import { PdfService } from './pdf.service';
import { createSupplementSummaryDocDefinition } from './report-supplement-summary.part';
import {
  createSupplementGroupCoverPageDocDefinition,
  createSupplementGroupDetailDocDefinition,
} from './report-supplement-detail.part';
import {
  createIssueBasedSupplementGroupCoverPageDocDefinition,
  createIssueBasedSupplementGroupDetailDocDefinition,
} from './report-supplement-detail-issue-based.part';
import { orderApprovedSupplementsForPdf } from './helpers/supplement-pdf-ordering';

/** Public return shape mirrors `generateRevisionEditDraftFromStatus`. */
export interface SupplementPdfVersionPayload {
  version: number;
  filePath: string;
  fileUrl: string;
  projectCount: number;
  createdAt: string;
  createdBy: { id: string; firstname: string; lastname: string };
}

/** Listing entry shape used for version-history responses. */
export interface SupplementPdfVersionListEntry {
  version: number;
  fileUrl: string;
  projectCount: number;
  createdAt: string;
  createdBy: { id: string; firstname: string; lastname: string };
}

/** Book context returned for FE display (lock state + parent metadata). */
export interface SupplementBookContext {
  id: string;
  supplementNumber: number;
  isBooked: boolean;
  isLocked: boolean;
  startDate: Date | null;
  endDate: Date | null;
  parentPlan: {
    id: string;
    name: string;
    startYear: number;
    endYear: number;
    reportFormat: ReportFormat;
  };
}

@Injectable()
export class SupplementPdfService {
  private readonly logger = new Logger(SupplementPdfService.name);

  constructor(
    @InjectRepository(DevelopmentPlan)
    private readonly developmentPlanRepo: Repository<DevelopmentPlan>,
    @InjectRepository(DevelopmentPlanSupplement)
    private readonly developmentPlanSupplementRepo: Repository<DevelopmentPlanSupplement>,
    @InjectRepository(SupplementProjectGroup)
    private readonly supplementProjectGroupRepo: Repository<SupplementProjectGroup>,
    @InjectRepository(PdfSupplementDraftDocument)
    private readonly pdfSupplementDraftRepo: Repository<PdfSupplementDraftDocument>,
    @InjectRepository(PdfSupplementApprovedDocument)
    private readonly pdfSupplementApprovedRepo: Repository<PdfSupplementApprovedDocument>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly bookLockService: BookLockService,
    // SUPP_PRINT_BE_01b — reuse PdfService for word-cutter (Thai line
    // breaks), font resolution, single-doc buffer rendering, and
    // multi-buffer merge. The promoted helpers are pure and stateless;
    // no behavior of the main-plan / revision flows is affected.
    private readonly pdfService: PdfService,
    // Wave 3 BE-READERS — every reader below routes through this
    // service to resolve legacy abs + new relative `file_path` values
    // (umbrella §7.3).
    private readonly storagePathService: StoragePathService,
    // BE-SUPP-01 — batched alignment resolver. STRATEGY_BASED branch of
    // `generateSupplementPdfBuffer` calls `resolveMany` exactly ONCE per
    // render with the unique (strategy, tactic, plan) triples extracted
    // from the grouped projects. Per-group renderers receive the
    // resolved `AlignmentRow | null` via the new `alignment` param.
    private readonly alignmentResolver: AlignmentResolverService,
  ) {}

  // ===================================================================
  // Path / version helpers
  // ===================================================================

  // Wave 3 BE-WRITERS — `getDraftBaseDir` / `buildStorageDir` legacy
  // helpers (BE-SCAN "Scattered literals" — `'uploads/pdf'` root) have
  // been removed. The single live writer in this file
  // (`saveSupplementDraftPdfAndMeta`) now composes its relative key
  // via `StoragePathService.supplementVersionKey(...)`. Readers that
  // previously dereferenced these helpers resolve stored paths via
  // `StoragePathService.resolveStored(...)` (BE-READERS wave).

  private buildFileName(version: number): string {
    const now = new Date();
    const [datePart, timePart] = now.toISOString().split('T');
    const [year, month, day] = datePart.split('-');
    const [hours, minutes] = timePart.split(':');
    return `${year}-${month}-${day}-${hours}-${minutes}-v${version}.pdf`;
  }

  private async getNextSupplementDraftVersion(
    developmentPlanSupplementId: string,
    em?: EntityManager,
  ): Promise<number> {
    const repo = em
      ? em.getRepository(PdfSupplementDraftDocument)
      : this.pdfSupplementDraftRepo;
    const latest = await repo.findOne({
      where: { developmentPlanSupplementId },
      order: { version: 'DESC' },
    });
    return latest ? latest.version + 1 : 1;
  }

  private async getNextSupplementApprovedVersion(
    developmentPlanSupplementId: string,
    em?: EntityManager,
  ): Promise<number> {
    const repo = em
      ? em.getRepository(PdfSupplementApprovedDocument)
      : this.pdfSupplementApprovedRepo;
    const latest = await repo.findOne({
      where: { developmentPlanSupplementId },
      order: { version: 'DESC' },
    });
    return latest ? latest.version + 1 : 1;
  }

  // ===================================================================
  // Internal — loaders
  // ===================================================================

  private async loadSupplementOrFail(
    developmentPlanSupplementId: string,
    em?: EntityManager,
  ): Promise<{
    supplement: DevelopmentPlanSupplement;
    plan: DevelopmentPlan;
  }> {
    const repo = em
      ? em.getRepository(DevelopmentPlanSupplement)
      : this.developmentPlanSupplementRepo;

    const supplement = await repo.findOne({
      where: { id: developmentPlanSupplementId },
      relations: ['developmentPlan'],
    });

    if (!supplement || supplement.deletedAt) {
      throw new NotFoundException(
        `DevelopmentPlanSupplement ${developmentPlanSupplementId} not found`,
      );
    }
    if (!supplement.developmentPlan) {
      throw new NotFoundException(
        `Parent DevelopmentPlan not found for supplement ${developmentPlanSupplementId}`,
      );
    }
    return { supplement, plan: supplement.developmentPlan };
  }

  /**
   * Internal helper consumed by both draft + approved finalize paths.
   *
   * Draft predicate (default):
   *   - SPG `deletedAt IS NULL`
   *   - parent supplement id matches
   *   - latest TrackingStatus.status.name IN
   *     (Pending, Verified, Pending_Approval, Approved)
   *
   * Approved predicate (`approvedOnly = true`):
   *   - same plus latest status = Approved only
   *
   * Sort:
   *   - STRATEGY_BASED: strategy.id, tactic.id, plan.id, title
   *   - ISSUE_BASED: developmentIssue.sortOrder, title
   *
   * The sort is the canonical ordering for cover-page assembly AND for
   * `pageNumber 1..N` assignment at finalize-time (Q6=B). Renderer
   * (BE_02) MUST consume rows in this same order.
   */
  async listSupplementProjectsForPdf(
    developmentPlanSupplementId: string,
    options: {
      approvedOnly: boolean;
      em?: EntityManager;
    },
  ): Promise<SupplementProjectGroup[]> {
    const repo = options.em
      ? options.em.getRepository(SupplementProjectGroup)
      : this.supplementProjectGroupRepo;

    const allowedStatuses = options.approvedOnly
      ? [STATUS_NAMES.APPROVED]
      : [
          STATUS_NAMES.PENDING,
          STATUS_NAMES.VERIFIED,
          STATUS_NAMES.PENDING_APPROVAL,
          STATUS_NAMES.APPROVED,
        ];

    const qb = repo
      .createQueryBuilder('spg')
      .leftJoinAndSelect('spg.developmentPlanSupplement', 'dps')
      .leftJoinAndSelect('dps.developmentPlan', 'dp')
      .leftJoinAndSelect('spg.strategy', 'strategy')
      .leftJoinAndSelect('spg.tactic', 'tactic')
      .leftJoinAndSelect('spg.plan', 'plan')
      .leftJoinAndSelect('spg.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('spg.budgets', 'budgets')
      .leftJoinAndSelect('spg.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('spg.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .leftJoinAndSelect('spg.amphoe', 'amphoe')
      .leftJoinAndSelect('spg.localAdministrativeOrganization', 'creatorLao')
      .leftJoinAndSelect('spg.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('spg.attachments', 'attachments')
      .leftJoinAndSelect('spg.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .where('dps.id = :supplementId', {
        supplementId: developmentPlanSupplementId,
      })
      .andWhere('spg.deletedAt IS NULL')
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name IN (:...statusNames)', {
        statusNames: allowedStatuses,
      });

    const rows = await qb.getMany();

    // Deterministic in-memory sort. We deliberately sort in-app (rather
    // than via ORDER BY) so that the renderer and the finalize-time
    // pageNumber assignment share the SAME sort comparator and the
    // result is independent of DB collation / null-order conventions.
    return [...rows].sort((a, b) => this.compareForPdf(a, b));
  }

  private compareForPdf(
    a: SupplementProjectGroup,
    b: SupplementProjectGroup,
  ): number {
    // ISSUE_BASED — both rows must satisfy the §16.5 ISSUE_BASED shape
    // so developmentIssue is present. STRATEGY_BASED rows have it null.
    const aIssue = a.developmentIssue;
    const bIssue = b.developmentIssue;
    if (aIssue && bIssue) {
      const so = (aIssue.sortOrder ?? 999) - (bIssue.sortOrder ?? 999);
      if (so !== 0) return so;
      return (a.title ?? '').localeCompare(b.title ?? '', 'th');
    }

    // STRATEGY_BASED — strategy / tactic / plan are all present per
    // §16.5 invariant. Compare by stable id, then by title for the leaf
    // tie-break.
    const aStratId = a.strategy?.id ?? '';
    const bStratId = b.strategy?.id ?? '';
    if (aStratId !== bStratId) {
      return aStratId < bStratId ? -1 : 1;
    }
    const aTacticId = a.tactic?.id ?? '';
    const bTacticId = b.tactic?.id ?? '';
    if (aTacticId !== bTacticId) {
      return aTacticId < bTacticId ? -1 : 1;
    }
    const aPlanId = a.plan?.id ?? '';
    const bPlanId = b.plan?.id ?? '';
    if (aPlanId !== bPlanId) {
      return aPlanId < bPlanId ? -1 : 1;
    }
    return (a.title ?? '').localeCompare(b.title ?? '', 'th');
  }

  // ===================================================================
  // PDF renderer wiring (SUPP_PRINT_BE_01b)
  // ===================================================================

  /**
   * Wires the supplement renderer parts
   * (`report-supplement-summary.part.ts`,
   * `report-supplement-detail.part.ts`,
   * `report-supplement-detail-issue-based.part.ts`) into the BE_01
   * finalize pipeline.
   *
   * Document order: Summary → loop[per-group cover + per-group detail],
   * mirroring revision-edit byte-for-byte. The per-group doc-definitions
   * are rendered to separate buffers via `PdfService.createPdfBuffer`
   * and concatenated with `PdfService.mergePdfBuffers` (pdf-lib copyPages),
   * matching the pattern used by `generateRevisionEditDraftReportWithColumns`
   * in `pdf.service.ts`.
   *
   * Page-number consistency (Q6=B): the renderer consumes the same
   * `orderApprovedSupplementsForPdf(projects, reportFormat)` ordering
   * that BE_01 uses for the `pageNumber 1..N` write inside the finalize
   * transaction. Sort is applied here defensively in case the caller
   * passes an unsorted list (draft path); the resulting render order
   * is therefore byte-identical regardless of caller.
   *
   * BE years (§Q3): `DevelopmentPlan.startYear` / `endYear` are
   * already stored in Buddhist Era — NO +543 conversion.
   */
  async generateSupplementPdfBuffer(args: {
    supplement: DevelopmentPlanSupplement;
    plan: DevelopmentPlan;
    projects: SupplementProjectGroup[];
    selectedColumns: string[];
    variant: 'draft' | 'approved';
    generatedAt?: Date;
    generatedByName?: string;
    /**
     * When `true`, skip Cover + Summary and render ONLY the per-group
     * detail tables. Matches the revision/change "details only" output
     * used by user-side paper-submission printing
     * (`generateRevisionEditDetailsOnly`). Default `false` preserves
     * the full Cover + Summary + Detail document used by finalize.
     */
    detailsOnly?: boolean;
    /**
     * Override the detail-table `reportType` discriminator. The detail
     * renderer hard-codes "ยังไม่ระบุ" for the หน่วยงานรับผิดชอบหลัก
     * column when `reportType !== 'inAuthority'`. SPG is agency-only
     * (§5.1 — `responsibleAgency` auto-assigned at create), so the
     * agency is ALWAYS known regardless of project status. Callers
     * that want the actual agency name rendered (user-side paper print,
     * mirroring `generateRevisionEditDetailsOnly`) MUST pass
     * `'inAuthority'`. When omitted, falls back to variant-derived
     * default (`approved → inAuthority`, `draft → default`).
     */
    reportType?: 'default' | 'inAuthority' | 'outAuthority';
  }): Promise<Buffer> {
    const reportFormat = args.plan.reportFormat ?? ReportFormat.STRATEGY_BASED;

    // 1. Deterministic sort — same comparator BE_01 uses to stamp
    //    `pageNumber 1..N`. Defensive: callers normally pre-sort via
    //    `listSupplementProjectsForPdf`, but we re-sort here so the
    //    renderer is robust to draft callers that don't.
    const orderedProjects = orderApprovedSupplementsForPdf(
      args.projects as any,
      reportFormat,
    ) as SupplementProjectGroup[];

    // 2. Shared rendering inputs.
    const fonts = this.pdfService.getPdfFonts();
    const newWord = this.pdfService.newWord.bind(this.pdfService);
    const pageMargins: [number, number, number, number] = [15, 60, 15, 40];
    const pageOrientation: 'portrait' | 'landscape' = 'landscape';
    const years = Array.from(
      { length: args.plan.endYear - args.plan.startYear + 1 },
      (_, i) => args.plan.startYear + i,
    );

    // Display name — prefer the user-supplied `description` set when the
    // round was opened (mirrors revision-edit which uses
    // `developmentPlanRevision.description`). Fall back to the generic
    // "เล่มเพิ่มเติมรอบที่ N พ.ศ. ..." label when description is empty.
    const supplementDescription = (args.supplement.description ?? '').trim();
    const supplementDisplayName = supplementDescription.length > 0
      ? supplementDescription
      : `เล่มเพิ่มเติมรอบที่ ${args.supplement.supplementNumber} พ.ศ. ${args.plan.startYear}-${args.plan.endYear}`;

    // 3. Column map shared with main-plan / revision generators.
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

    // KPI is omitted for ISSUE_BASED per §16.5 / §16.9. We also strip
    // `amphoe` / `coordinates` here — the per-group detail builder
    // re-adds them when any row carries an origin agency.
    const baseFiltered = args.selectedColumns.filter(
      (col) => columnMap[col] && col !== 'amphoe' && col !== 'coordinates',
    );
    const availableColumns =
      reportFormat === ReportFormat.ISSUE_BASED
        ? baseFiltered.filter((col) => col !== 'kpi')
        : baseFiltered;

    const pdfBuffers: Buffer[] = [];
    let pageOffset = 0;

    // reportType resolution:
    //   - caller-supplied override wins (e.g. user-side paper print
    //     passes 'inAuthority' so the auto-assigned responsibleAgency
    //     renders per §5.1)
    //   - otherwise variant-derived default (approved → inAuthority,
    //     draft → default)
    const resolvedReportType =
      args.reportType ?? (args.variant === 'approved' ? 'inAuthority' : 'default');

    // 4. Summary page (format-aware). Skipped on `detailsOnly` to mirror
    //    `generateRevisionEditDetailsOnly`. There is no top-level cover
    //    page — revision-edit has none, and we match exactly.
    if (!args.detailsOnly) {
      if (reportFormat === ReportFormat.ISSUE_BASED) {
        const { issues, overallSum, overallCount } =
          this.pdfService.prepareIssueBasedReportAggregations(
            orderedProjects as any,
            years,
          );
        const summaryDoc = createSupplementSummaryDocDefinition({ coverTitle: "บัญชีเพิ่มเติม",
          developmentPlanSupplementName: supplementDisplayName,
          years,
          reportFormat: 'ISSUE_BASED',
          issues,
          overallSum,
          overallCount,
          totalProjectCount: orderedProjects.length,
          pageMargins,
          pageOrientation,
          newWord,
        });
        const summaryBuffer = await this.pdfService.createPdfBuffer(
          summaryDoc,
          fonts,
        );
        pdfBuffers.push(summaryBuffer);
        const summaryPdf = await PDFDocument.load(summaryBuffer);
        pageOffset += summaryPdf.getPageCount();
      } else {
        const { strategies, overallSum, overallCount } =
          this.pdfService.prepareReportAggregations(
            orderedProjects as any,
            years,
          );
        const summaryDoc = createSupplementSummaryDocDefinition({ coverTitle: "บัญชีเพิ่มเติม",
          developmentPlanSupplementName: supplementDisplayName,
          years,
          reportFormat: 'STRATEGY_BASED',
          strategies,
          overallSum,
          overallCount,
          totalProjectCount: orderedProjects.length,
          pageMargins,
          pageOrientation,
          newWord,
        });
        const summaryBuffer = await this.pdfService.createPdfBuffer(
          summaryDoc,
          fonts,
        );
        pdfBuffers.push(summaryBuffer);
        const summaryPdf = await PDFDocument.load(summaryBuffer);
        pageOffset += summaryPdf.getPageCount();
      }
    }

    // 5. Detail pages — per-group cover + per-group detail loop, mirroring
    //    `generateRevisionEditDraftReportWithColumns`.
    if (reportFormat === ReportFormat.ISSUE_BASED) {
      // Group by DevelopmentIssue preserving the ordering produced by
      // `orderApprovedSupplementsForPdf`.
      const groupedByIssue = new Map<string, SupplementProjectGroup[]>();
      const issueSortOrder = new Map<string, number>();
      for (const project of orderedProjects) {
        const issueName = project.developmentIssue?.name || '-';
        const sortOrder = project.developmentIssue?.sortOrder ?? 999;
        if (!groupedByIssue.has(issueName)) {
          groupedByIssue.set(issueName, []);
          issueSortOrder.set(issueName, sortOrder);
        }
        groupedByIssue.get(issueName)!.push(project);
      }

      const sortedIssueEntries = [...groupedByIssue.entries()].sort((a, b) => {
        const soA = issueSortOrder.get(a[0]) ?? 999;
        const soB = issueSortOrder.get(b[0]) ?? 999;
        if (soA !== soB) return soA - soB;
        return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
      });

      for (const [issueName, groupProjects] of sortedIssueEntries) {
        const coverDoc = createIssueBasedSupplementGroupCoverPageDocDefinition(
          issueName,
          supplementDisplayName,
          pageMargins,
          pageOrientation,
          newWord,
          pageOffset,
        );
        const coverBuffer = await this.pdfService.createPdfBuffer(coverDoc, fonts);
        pdfBuffers.push(coverBuffer);
        const coverPdf = await PDFDocument.load(coverBuffer);
        pageOffset += coverPdf.getPageCount();

        const detailDoc = createIssueBasedSupplementGroupDetailDocDefinition({
          developmentPlanSupplementName: supplementDisplayName,
          years,
          groupProjects,
          availableColumns,
          columnMap,
          pageMargins,
          pageOrientation,
          newWord,
          reportType: resolvedReportType,
          issueName,
          pageOffset,
        });
        if (detailDoc) {
          const detailBuffer = await this.pdfService.createPdfBuffer(
            detailDoc,
            fonts,
          );
          pdfBuffers.push(detailBuffer);
          const detailPdf = await PDFDocument.load(detailBuffer);
          pageOffset += detailPdf.getPageCount();
        }
      }
    } else {
      // STRATEGY_BASED — group by Strategy/Tactic/Plan preserving order.
      const groupedProjects = new Map<string, SupplementProjectGroup[]>();
      for (const project of orderedProjects) {
        const strategyName = project.strategy?.name || '-';
        const tacticName = project.tactic?.name || '-';
        const planName = project.plan?.name || '-';
        const groupKey = `${strategyName}||${tacticName}||${planName}`;
        if (!groupedProjects.has(groupKey)) groupedProjects.set(groupKey, []);
        groupedProjects.get(groupKey)!.push(project);
      }

      // BE-SUPP-01 — batch external alignment lookup. Extract unique
      // (strategyId, tacticId, planId) triples by peeking at the first
      // project of each group, then resolve all in ONE SQL call. The
      // grouped-projects map is keyed by name (matching the existing
      // loop below); we keep a parallel name-key → AlignmentRow|null
      // map so the per-group loop reads alignment by the same key it
      // already uses for the cover/detail dispatch.
      const nameKeyToTriple = new Map<string, AlignmentTriple | null>();
      const triples: AlignmentTriple[] = [];
      for (const [groupKey, projects] of groupedProjects.entries()) {
        const head = projects?.[0];
        const strategyId = head?.strategy?.id;
        const tacticId = head?.tactic?.id;
        const planId = head?.plan?.id;
        if (!strategyId || !tacticId || !planId) {
          nameKeyToTriple.set(groupKey, null);
          continue;
        }
        const triple: AlignmentTriple = {
          strategyId: String(strategyId),
          tacticId: String(tacticId),
          planId: String(planId),
        };
        nameKeyToTriple.set(groupKey, triple);
        triples.push(triple);
      }
      const resolvedAlignment = await this.alignmentResolver.resolveMany(triples);
      const alignmentByGroupKey = new Map<string, AlignmentRow | null>();
      for (const [groupKey, triple] of nameKeyToTriple.entries()) {
        alignmentByGroupKey.set(
          groupKey,
          triple ? resolvedAlignment.get(buildTripleKey(triple)) ?? null : null,
        );
      }

      for (const [groupKey, groupProjects] of groupedProjects.entries()) {
        const [strategyName, tacticName, planName] = groupKey.split('||');
        const coverDoc = createSupplementGroupCoverPageDocDefinition(
          strategyName,
          supplementDisplayName,
          pageMargins,
          pageOrientation,
          newWord,
          pageOffset,
        );
        const coverBuffer = await this.pdfService.createPdfBuffer(coverDoc, fonts);
        pdfBuffers.push(coverBuffer);
        const coverPdf = await PDFDocument.load(coverBuffer);
        pageOffset += coverPdf.getPageCount();

        const strategyCode = groupProjects?.[0]?.strategy?.id ?? null;
        const detailDoc = createSupplementGroupDetailDocDefinition({
          developmentPlanSupplementName: supplementDisplayName,
          years,
          groupProjects,
          availableColumns,
          columnMap,
          pageMargins,
          pageOrientation,
          newWord,
          reportType: resolvedReportType,
          strategyName,
          strategyCode,
          tacticName,
          planName,
          pageOffset,
          alignment: alignmentByGroupKey.get(groupKey) ?? null,
        });
        if (detailDoc) {
          const detailBuffer = await this.pdfService.createPdfBuffer(
            detailDoc,
            fonts,
          );
          pdfBuffers.push(detailBuffer);
          const detailPdf = await PDFDocument.load(detailBuffer);
          pageOffset += detailPdf.getPageCount();
        }
      }
    }

    // 6. Merge Summary + per-group(Cover + Detail) into a single Buffer.
    return this.pdfService.mergePdfBuffers(pdfBuffers);
  }

  // ===================================================================
  // Public — Draft
  // ===================================================================

  /**
   * Generate a fresh draft PDF for the supplement round. Read-only with
   * respect to workflow state. Draft generation is allowed on
   * §15-locked rounds per §15.5 read exemption — we do NOT call
   * `BookLockService.assertEditable` here. The controller may choose
   * to UI-disable the action on locked rounds (UX report §5.2), but
   * the service does not gate.
   */
  async generateSupplementDraftFromStatus(args: {
    developmentPlanSupplementId: string;
    createdById: string;
    selectedColumns?: string[];
  }): Promise<SupplementPdfVersionPayload> {
    const { supplement, plan } = await this.loadSupplementOrFail(
      args.developmentPlanSupplementId,
    );

    const projects = await this.listSupplementProjectsForPdf(
      args.developmentPlanSupplementId,
      { approvedOnly: false },
    );
    if (projects.length === 0) {
      throw new BadRequestException(
        'ยังไม่มีโครงการที่พร้อมพิมพ์ในรอบเพิ่มเติมนี้',
      );
    }

    const selectedColumns =
      args.selectedColumns && args.selectedColumns.length > 0
        ? args.selectedColumns
        : [
            'index',
            'title',
            'objective',
            'target',
            'budget',
            'expectedResult',
            'mainAgency',
          ];

    // SUPP_PRINT_BE_01b — resolve the generator's display name for the
    // cover page (Thai-BE "จัดทำโดย: …" line). The Q3 cover label is
    // owned by the renderer; service supplies the metadata.
    const generatedByUser = await this.userRepo.findOne({
      where: { id: args.createdById },
      select: ['id', 'firstname', 'lastname'],
    });
    const generatedByName = generatedByUser
      ? `${generatedByUser.firstname ?? ''} ${generatedByUser.lastname ?? ''}`.trim() || '-'
      : '-';

    const pdfBuffer = await this.generateSupplementPdfBuffer({
      supplement,
      plan,
      projects,
      selectedColumns,
      variant: 'draft',
      generatedAt: new Date(),
      generatedByName,
      // 2026-05-14 — SPG agency-only (§5.1) → responsibleAgency known
      // from create. Override reportType so the admin draft preview
      // shows the actual agency name instead of "ยังไม่ระบุ".
      reportType: 'inAuthority',
    });

    return this.saveSupplementDraftPdfAndMeta({
      supplement,
      plan,
      pdfBuffer,
      projectIdsSnapshot: projects.map((p) => p.id),
      createdById: args.createdById,
    });
  }

  private async saveSupplementDraftPdfAndMeta(args: {
    supplement: DevelopmentPlanSupplement;
    plan: DevelopmentPlan;
    pdfBuffer: Buffer;
    projectIdsSnapshot: Array<string | number>;
    createdById: string;
  }): Promise<SupplementPdfVersionPayload> {
    const version = await this.getNextSupplementDraftVersion(
      args.supplement.id,
    );

    // Wave 3 BE-WRITERS — plan-rooted supplement-draft key
    // (umbrella §7.1). Prefix the leaf filename with `draft-` so the
    // sibling approved artifact (when re-introduced post-Wave SUPP
    // STANDALONE) stays distinguishable inside the same vN/ directory.
    const fileName = `draft-${this.buildFileName(version)}`;
    const fileKey = this.storagePathService.supplementVersionKey({
      planId: args.plan.id,
      supplementNumber: args.supplement.supplementNumber,
      supplementId: args.supplement.id,
      versionNumber: version,
      fileName,
    });
    await this.storagePathService.writeFile(fileKey, args.pdfBuffer);

    const row = this.pdfSupplementDraftRepo.create({
      developmentPlanSupplementId: args.supplement.id,
      version,
      filePath: fileKey,
      projectIdsSnapshot: args.projectIdsSnapshot,
      projectCount: args.projectIdsSnapshot.length,
      createdById: args.createdById,
    });
    const saved = await this.pdfSupplementDraftRepo.save(row);

    const user = await this.userRepo.findOne({
      where: { id: args.createdById },
      select: ['id', 'firstname', 'lastname'],
    });

    return {
      version: saved.version,
      filePath: saved.filePath,
      fileUrl: `/v1/pdf/supplement-draft/${args.supplement.id}/latest/stream`,
      projectCount: saved.projectCount,
      createdAt: saved.createdAt.toISOString(),
      createdBy: user
        ? { id: user.id, firstname: user.firstname, lastname: user.lastname }
        : { id: args.createdById, firstname: '', lastname: '' },
    };
  }

  async getSupplementDraftVersions(
    developmentPlanSupplementId: string,
  ): Promise<SupplementPdfVersionListEntry[]> {
    const rows = await this.pdfSupplementDraftRepo.find({
      where: { developmentPlanSupplementId },
      order: { version: 'DESC' },
      relations: ['createdBy'],
    });
    return rows.map((v) => ({
      version: v.version,
      fileUrl: `/v1/pdf/supplement-draft/${developmentPlanSupplementId}/${v.version}/stream`,
      projectCount: v.projectCount,
      createdAt: v.createdAt.toISOString(),
      createdBy: v.createdBy
        ? {
            id: v.createdBy.id,
            firstname: v.createdBy.firstname,
            lastname: v.createdBy.lastname,
          }
        : { id: v.createdById, firstname: '', lastname: '' },
    }));
  }

  async downloadSupplementDraft(
    documentId: string,
  ): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const row = await this.pdfSupplementDraftRepo.findOne({
      where: { id: documentId },
    });
    if (!row) return null;
    // Wave 3 BE-READERS — resolveStored handles legacy abs + new relative.
    const absPath = this.storagePathService.resolveStored(row.filePath);
    try {
      await fsp.access(absPath);
    } catch {
      this.logger.warn(`Supplement draft file missing: ${row.filePath} (resolved: ${absPath})`);
      return null;
    }
    return {
      filePath: row.filePath,
      stream: fs.createReadStream(absPath),
    };
  }

  // ===================================================================
  // Public — Approved version read helpers
  // ===================================================================
  //
  // SUPP_STANDALONE_CLEANUP_BE_01 (Wave 5, 2026-05-14) — the legacy
  // single-click finalize entry point (`finalizeSupplementApproved`)
  // was deleted in this wave. The §18.2.1 SUPPLEMENT finalize trigger
  // surface now lives EXCLUSIVELY in
  // `SupplementAssemblyService.merge()` under
  // `src/supplement-assembly/`. The version read helpers below are
  // retained for legacy archive read access (existing
  // `PdfSupplementApprovedDocument` rows remain queryable).

  async getSupplementApprovedVersions(
    developmentPlanSupplementId: string,
  ): Promise<SupplementPdfVersionListEntry[]> {
    const rows = await this.pdfSupplementApprovedRepo.find({
      where: { developmentPlanSupplementId },
      order: { version: 'DESC' },
      relations: ['createdBy'],
    });
    return rows.map((v) => ({
      version: v.version,
      fileUrl: `/v1/pdf/supplement-approved/${developmentPlanSupplementId}/${v.version}/stream`,
      projectCount: v.projectCount,
      createdAt: v.createdAt.toISOString(),
      createdBy: v.createdBy
        ? {
            id: v.createdBy.id,
            firstname: v.createdBy.firstname,
            lastname: v.createdBy.lastname,
          }
        : { id: v.createdById, firstname: '', lastname: '' },
    }));
  }

  async downloadSupplementApproved(
    documentId: string,
  ): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const row = await this.pdfSupplementApprovedRepo.findOne({
      where: { id: documentId },
    });
    if (!row) return null;
    // Wave 3 BE-READERS — resolveStored handles legacy abs + new relative.
    const absPath = this.storagePathService.resolveStored(row.filePath);
    try {
      await fsp.access(absPath);
    } catch {
      this.logger.warn(`Supplement approved file missing: ${row.filePath} (resolved: ${absPath})`);
      return null;
    }
    return {
      filePath: row.filePath,
      stream: fs.createReadStream(absPath),
    };
  }

  // ===================================================================
  // Public — Controller helpers (SUPP_PRINT_BE_03)
  // ===================================================================
  //
  // BE_03 (controller) endpoints expose URL patterns of the form
  // `/:developmentPlanId/:developmentPlanSupplementId/{latest|version}/...`.
  // The helpers below mirror the revision-edit-draft analogs on
  // `PdfService` (e.g. `getLatestRevisionEditDraftMeta`,
  // `readRevisionEditDraftFileByVersion`) so the controller stays
  // symmetrical with the existing revision endpoints. Each helper
  // verifies that the URL-supplied `developmentPlanId` matches the
  // supplement's parent plan and returns `null` on mismatch — the
  // controller surfaces 404 per task §11.

  /**
   * Resolve a supplement and assert its parent plan id matches the
   * caller-supplied `developmentPlanId`. Returns null when the
   * supplement does not exist, has been soft-deleted, or belongs to a
   * different plan.
   */
  private async resolveSupplementForPlan(
    developmentPlanId: string,
    developmentPlanSupplementId: string,
  ): Promise<{
    supplement: DevelopmentPlanSupplement;
    plan: DevelopmentPlan;
  } | null> {
    const supplement = await this.developmentPlanSupplementRepo.findOne({
      where: { id: developmentPlanSupplementId },
      relations: ['developmentPlan'],
    });
    if (!supplement || supplement.deletedAt) return null;
    if (!supplement.developmentPlan) return null;
    if (supplement.developmentPlan.id !== developmentPlanId) return null;
    return { supplement, plan: supplement.developmentPlan };
  }

  /** Latest DRAFT version metadata for `(planId, supplementId)`. */
  async getLatestSupplementDraftMeta(
    developmentPlanId: string,
    developmentPlanSupplementId: string,
  ): Promise<
    | (SupplementPdfVersionListEntry & {
        exists: true;
        filePath: string;
        projectIdsSnapshot: Array<string | number>;
      })
    | null
  > {
    const resolved = await this.resolveSupplementForPlan(
      developmentPlanId,
      developmentPlanSupplementId,
    );
    if (!resolved) return null;

    const latest = await this.pdfSupplementDraftRepo.findOne({
      where: { developmentPlanSupplementId },
      order: { version: 'DESC' },
      relations: ['createdBy'],
    });
    if (!latest) return null;

    // 2026-05-16 BUGFIX — FE `SupplementPdfMeta` interface expects
    // `exists: true` + `filePath` + `projectIdsSnapshot` to trigger the
    // post-print UI flip ("พิมพ์เล่มร่าง" → file viewer / download
    // buttons). The previous shape omitted those three fields, so the
    // FE's `!draftPdfMeta?.exists` check at SupplementPrintPresent.tsx
    // lines 528/737/747/786 always evaluated to "no draft yet" → the
    // print button never switched. Mirrors the main-plan analogs at
    // pdf.service.ts:1280 (`getLatestAgencyDraftMeta`) +
    // pdf.service.ts:1399 (`getLatestCoordinateDraftMeta`) which all
    // return `exists: true` alongside the canonical metadata.
    return {
      exists: true,
      version: latest.version,
      fileUrl: `/v1/pdf/supplement-draft/${developmentPlanId}/${developmentPlanSupplementId}/${latest.version}/stream`,
      projectCount: latest.projectCount,
      createdAt: latest.createdAt.toISOString(),
      projectIdsSnapshot: latest.projectIdsSnapshot,
      filePath: latest.filePath,
      createdBy: latest.createdBy
        ? {
            id: latest.createdBy.id,
            firstname: latest.createdBy.firstname,
            lastname: latest.createdBy.lastname,
          }
        : { id: latest.createdById, firstname: '', lastname: '' },
    };
  }

  /** Latest DRAFT file stream for `(planId, supplementId)`. */
  async readLatestSupplementDraftFile(
    developmentPlanId: string,
    developmentPlanSupplementId: string,
  ): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const resolved = await this.resolveSupplementForPlan(
      developmentPlanId,
      developmentPlanSupplementId,
    );
    if (!resolved) return null;

    const latest = await this.pdfSupplementDraftRepo.findOne({
      where: { developmentPlanSupplementId },
      order: { version: 'DESC' },
    });
    if (!latest) return null;
    // Wave 3 BE-READERS — resolveStored handles legacy abs + new relative.
    const absPath = this.storagePathService.resolveStored(latest.filePath);
    try {
      await fsp.access(absPath);
    } catch {
      this.logger.warn(`Supplement draft file missing: ${latest.filePath} (resolved: ${absPath})`);
      return null;
    }
    return {
      filePath: latest.filePath,
      stream: fs.createReadStream(absPath),
    };
  }

  /** Specific DRAFT version stream for `(planId, supplementId, version)`. */
  async readSupplementDraftFileByVersion(
    developmentPlanId: string,
    developmentPlanSupplementId: string,
    version: number,
  ): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const resolved = await this.resolveSupplementForPlan(
      developmentPlanId,
      developmentPlanSupplementId,
    );
    if (!resolved) return null;

    const row = await this.pdfSupplementDraftRepo.findOne({
      where: { developmentPlanSupplementId, version },
    });
    if (!row) return null;
    // Wave 3 BE-READERS — resolveStored handles legacy abs + new relative.
    const absPath = this.storagePathService.resolveStored(row.filePath);
    try {
      await fsp.access(absPath);
    } catch {
      this.logger.warn(`Supplement draft file missing: ${row.filePath} (resolved: ${absPath})`);
      return null;
    }
    return {
      filePath: row.filePath,
      stream: fs.createReadStream(absPath),
    };
  }

  /** Plan-scoped DRAFT version listing. */
  async getAllSupplementDraftVersionsForPlan(
    developmentPlanId: string,
    developmentPlanSupplementId: string,
  ): Promise<SupplementPdfVersionListEntry[] | null> {
    const resolved = await this.resolveSupplementForPlan(
      developmentPlanId,
      developmentPlanSupplementId,
    );
    if (!resolved) return null;

    const rows = await this.pdfSupplementDraftRepo.find({
      where: { developmentPlanSupplementId },
      order: { version: 'DESC' },
      relations: ['createdBy'],
    });
    return rows.map((v) => ({
      version: v.version,
      fileUrl: `/v1/pdf/supplement-draft/${developmentPlanId}/${developmentPlanSupplementId}/${v.version}/stream`,
      projectCount: v.projectCount,
      createdAt: v.createdAt.toISOString(),
      createdBy: v.createdBy
        ? {
            id: v.createdBy.id,
            firstname: v.createdBy.firstname,
            lastname: v.createdBy.lastname,
          }
        : { id: v.createdById, firstname: '', lastname: '' },
    }));
  }

  /** Latest APPROVED metadata for a supplement (no plan-id gate — approved is supplement-scoped only). */
  async getLatestSupplementApprovedMeta(
    developmentPlanSupplementId: string,
  ): Promise<SupplementPdfVersionListEntry | null> {
    const supplement = await this.developmentPlanSupplementRepo.findOne({
      where: { id: developmentPlanSupplementId },
    });
    if (!supplement || supplement.deletedAt) return null;

    const latest = await this.pdfSupplementApprovedRepo.findOne({
      where: { developmentPlanSupplementId },
      order: { version: 'DESC' },
      relations: ['createdBy'],
    });
    if (!latest) return null;

    return {
      version: latest.version,
      fileUrl: `/v1/pdf/supplement-approved/${developmentPlanSupplementId}/${latest.version}/stream`,
      projectCount: latest.projectCount,
      createdAt: latest.createdAt.toISOString(),
      createdBy: latest.createdBy
        ? {
            id: latest.createdBy.id,
            firstname: latest.createdBy.firstname,
            lastname: latest.createdBy.lastname,
          }
        : { id: latest.createdById, firstname: '', lastname: '' },
    };
  }

  /** Latest APPROVED file stream for a supplement. */
  async readLatestSupplementApprovedFile(
    developmentPlanSupplementId: string,
  ): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const supplement = await this.developmentPlanSupplementRepo.findOne({
      where: { id: developmentPlanSupplementId },
    });
    if (!supplement || supplement.deletedAt) return null;

    const latest = await this.pdfSupplementApprovedRepo.findOne({
      where: { developmentPlanSupplementId },
      order: { version: 'DESC' },
    });
    if (!latest) return null;
    // Wave 3 BE-READERS — resolveStored handles legacy abs + new relative.
    const absPath = this.storagePathService.resolveStored(latest.filePath);
    try {
      await fsp.access(absPath);
    } catch {
      this.logger.warn(
        `Supplement approved file missing: ${latest.filePath} (resolved: ${absPath})`,
      );
      return null;
    }
    return {
      filePath: latest.filePath,
      stream: fs.createReadStream(absPath),
    };
  }

  /** Specific APPROVED version stream. */
  async readSupplementApprovedFileByVersion(
    developmentPlanSupplementId: string,
    version: number,
  ): Promise<{ filePath: string; stream: fs.ReadStream } | null> {
    const supplement = await this.developmentPlanSupplementRepo.findOne({
      where: { id: developmentPlanSupplementId },
    });
    if (!supplement || supplement.deletedAt) return null;

    const row = await this.pdfSupplementApprovedRepo.findOne({
      where: { developmentPlanSupplementId, version },
    });
    if (!row) return null;
    // Wave 3 BE-READERS — resolveStored handles legacy abs + new relative.
    const absPath = this.storagePathService.resolveStored(row.filePath);
    try {
      await fsp.access(absPath);
    } catch {
      this.logger.warn(`Supplement approved file missing: ${row.filePath} (resolved: ${absPath})`);
      return null;
    }
    return {
      filePath: row.filePath,
      stream: fs.createReadStream(absPath),
    };
  }

  /**
   * Load SPGs by ids for the `generate-supplement-custom` endpoint.
   * Mirrors the existing `PdfService.findRevisedProjectsByIds` shape.
   */
  async findSupplementProjectsByIds(
    ids: string[],
  ): Promise<SupplementProjectGroup[]> {
    if (!ids || ids.length === 0) return [];
    return await this.supplementProjectGroupRepo.find({
      where: { id: In(ids) },
      relations: [
        'developmentPlanSupplement',
        'developmentPlanSupplement.developmentPlan',
        'strategy',
        'tactic',
        'plan',
        'developmentIssue',
        'budgets',
        'responsibleAgency',
        'originAgencyId',
        'amphoe',
        'localAdministrativeOrganization',
        'createdBy',
        'createdBy.user',
        'attachments',
      ],
    });
  }

  /**
   * One-shot custom PDF buffer for `generate-supplement-custom`. Mirrors
   * `PdfService.generateRevisionEditDraftReportWithColumns`. Does NOT
   * persist a `PdfSupplementDraftDocument` row — the custom endpoint is
   * a transient download, not a versioned save.
   */
  async generateSupplementCustomBuffer(args: {
    projects: SupplementProjectGroup[];
    selectedColumns: string[];
    createdById: string;
  }): Promise<{ buffer: Buffer; supplementId: string }> {
    if (args.projects.length === 0) {
      throw new BadRequestException('projects must not be empty');
    }
    const first = args.projects[0];
    const supplement = first.developmentPlanSupplement;
    if (!supplement || supplement.deletedAt) {
      throw new NotFoundException(
        'Parent DevelopmentPlanSupplement not found for the supplied projects',
      );
    }
    const plan = supplement.developmentPlan;
    if (!plan) {
      throw new NotFoundException(
        `Parent DevelopmentPlan not found for supplement ${supplement.id}`,
      );
    }

    // Defensive: every SPG MUST share the same supplement — the cover
    // label / page-number sequence is supplement-scoped, so a
    // mixed-supplement payload would silently produce a corrupted PDF.
    for (const spg of args.projects) {
      if (spg.developmentPlanSupplement?.id !== supplement.id) {
        throw new BadRequestException(
          'All supplied SPGs must belong to the same DevelopmentPlanSupplement',
        );
      }
    }

    // Resolve cover-page generatedBy display name (matches the draft /
    // finalize paths).
    const generatedByUser = await this.userRepo.findOne({
      where: { id: args.createdById },
      select: ['id', 'firstname', 'lastname'],
    });
    const generatedByName = generatedByUser
      ? `${generatedByUser.firstname ?? ''} ${generatedByUser.lastname ?? ''}`.trim() || '-'
      : '-';

    const buffer = await this.generateSupplementPdfBuffer({
      supplement,
      plan,
      projects: args.projects, // generator re-sorts deterministically
      selectedColumns: args.selectedColumns,
      variant: 'draft',
      generatedAt: new Date(),
      generatedByName,
      // 2026-05-14 — user-side custom print uses the SAME "details only"
      // output shape as `generateRevisionEditDetailsOnly`. No cover, no
      // summary — just the grouped detail tables for paper submission.
      detailsOnly: true,
      // 2026-05-14 — bug fix: SPG is agency-only (§5.1) so
      // `responsibleAgency` is auto-assigned at create and ALWAYS known
      // for any in-flight / approved status. The detail renderer
      // hard-codes "ยังไม่ระบุ" when reportType !== 'inAuthority'; force
      // 'inAuthority' so the actual agency name renders, mirroring the
      // revision-edit `generateRevisionEditDetailsOnly` behavior.
      reportType: 'inAuthority',
    });

    return { buffer, supplementId: supplement.id };
  }

  // ===================================================================
  // Public — Book context (FE display)
  // ===================================================================

  /**
   * Returns the round metadata FE needs to render the print / draft /
   * finalize surfaces (UX report §5.1–§5.3). The `isLocked` field is
   * a live read of `BookLockService` per §15.7 — there is no cached
   * column.
   */
  async getSupplementBookContext(
    developmentPlanSupplementId: string,
  ): Promise<SupplementBookContext> {
    const { supplement, plan } = await this.loadSupplementOrFail(
      developmentPlanSupplementId,
    );

    const isLocked = await this.bookLockService.hasNewerRevision(
      supplement.id,
      'development_plan_supplement',
      this.dataSource.manager,
    );

    return {
      id: supplement.id,
      supplementNumber: supplement.supplementNumber,
      isBooked: supplement.isBooked,
      isLocked,
      startDate: supplement.startDate,
      endDate: supplement.endDate,
      parentPlan: {
        id: plan.id,
        name: plan.name,
        startYear: plan.startYear,
        endYear: plan.endYear,
        reportFormat: plan.reportFormat ?? ReportFormat.STRATEGY_BASED,
      },
    };
  }
}
