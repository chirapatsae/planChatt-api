/**
 * Public Archive Service.
 *
 * Read-only access to assembled development plan books for ANONYMOUS
 * (non-logged-in) callers. The Local Development Plan is a public-record
 * document under พ.ร.บ. ข้อมูลข่าวสารฯ, so the assembled PDF + minimal
 * metadata are exposed without authentication.
 *
 * Differences from `BookAssemblyService.getAssemblyHistory`:
 *   1. NO `loadAndValidateWorkHistory` call (no user context).
 *   2. Only returns versions where `status = COMPLETED` (drafts and
 *      deprecated versions are never exposed publicly).
 *   3. Strips PII from the payload — no creator user, no work-history.
 *      Only `bookName`, `versionNumber`, `mergedAt`, `totalPages` survive
 *      the transform.
 *   4. Returns supplements as a parallel timeline once SupplementAssembly
 *      surfaces a public-ready service (currently a stub returning []).
 *
 * Project-search:
 *   `searchProjects(q)` returns approved projects (PG + RPG) whose title
 *   contains `q`, joined back to a plan that has at least one COMPLETED
 *   book version. This answers the citizen-facing question "ตำบลเรามี
 *   โครงการสร้างถนนหน้าบ้านในปีไหน อยู่ในเล่มไหน?".
 *
 * Status table: §17.2 advisory — viewing the archive does not gate
 * any workflow transition; CLAUDE.md ownership rules are unaffected.
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, In, Repository } from 'typeorm';

import { BookAssemblyVersion } from 'src/book-assembly/entities/book-assembly-version.entity';
import {
  BookAssemblySourceType,
  BookAssemblyVersionStatus,
} from 'src/book-assembly/enums/book-assembly.enums';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { BookAssemblyService } from 'src/book-assembly/book-assembly.service';
import { SupplementAssemblyVersion } from 'src/supplement-assembly/entities/supplement-assembly-version.entity';
import { SupplementAssemblyVersionStatus } from 'src/supplement-assembly/enums/supplement-assembly.enums';
import { SupplementAssemblyService } from 'src/supplement-assembly/supplement-assembly.service';
import { ReportFormat } from 'src/development-plan/types/report-format.enum';

/* ── Public DTO shapes (no PII) ──────────────────────────────────── */

export interface PublicVersionDto {
  versionNumber: number;
  mergedAt: string;
  totalPages: number | null;
  /** Download URL for streaming the assembled PDF. */
  downloadUrl: string;
}

export interface PublicRevisionDto {
  revisionId: string;
  revisionName: string;
  versions: PublicVersionDto[];
}

/**
 * Public-archive shape for a `DevelopmentPlanSupplement` book.
 * Wave public-archive-supplement BE-01.
 *
 * Mirrors `PublicRevisionDto` but is sourced from the parallel
 * `supplement_assembly_versions` table (see `docs/supplement-book-domain.md`
 * §9 — supplements deliberately do NOT share the BookAssembly enum).
 *
 * `supplementName` follows the Thai convention "เพิ่มเติม ครั้งที่ N"
 * so the FE can render the badge identically to revisions.
 */
export interface PublicSupplementDto {
  supplementId: string;
  supplementName: string;
  versions: PublicVersionDto[];
}

export interface PublicPlanDto {
  planId: string;
  planName: string;
  startYear: number;
  endYear: number;
  mainBook: { versions: PublicVersionDto[] } | null;
  editRevisions: PublicRevisionDto[];
  changeRevisions: PublicRevisionDto[];
  /**
   * Publicly-eligible supplements under this plan (Wave
   * public-archive-supplement BE-01). Always non-null; defaults to `[]`.
   * A supplement appears here only when (a) parent plan is publicly
   * published (existing `getPublishedPlanIds` gate), (b) the supplement
   * has ≥1 COMPLETED `supplement_assembly_versions` row, and
   * (c) `development_plan_supplement.deleted_at IS NULL`.
   */
  supplements: PublicSupplementDto[];
  /** Engagement counters — always non-null, default 0 (CLAUDE.md §17.2 advisory). */
  viewCount: number;
  downloadCount: number;
}

export interface PublicProjectSearchHit {
  projectId: string;
  projectTitle: string;
  projectYear: number;
  /**
   * Which book the project belongs to. Widened to `'supplement'` for
   * `SupplementProjectGroup` hits (Wave public-archive-supplement BE-01).
   */
  sourceType:
    | 'main_plan'
    | 'edit_revision'
    | 'change_revision'
    | 'supplement';
  sourceId: string;
  planId: string;
  planName: string;
  bookName: string;
  /** Engagement counters — always non-null, default 0 (CLAUDE.md §17.2 advisory). */
  likeCount: number;
  viewCount: number;
}

/**
 * Public Archive — Project Detail DTO (PDPA-bound contract).
 *
 * This DTO is the SOLE redaction mechanism for the detail endpoint —
 * the service constructs it field-by-field and NEVER spreads an entity
 * into the response. Adding a field here is a deliberate, reviewable
 * action; an entity column drift will NOT silently leak.
 *
 * See `docs/tasks/wave-public-archive-project-detail/BE-01.md` §7.3 for
 * the canonical whitelist and the explicit exclusion list.
 *
 * Excluded by design (NEVER emit):
 *   - createdBy (WorkHistory) — exposes creator user id + LAO / agency
 *   - responsibleAgency contact info (phone, address) — only `name`
 *     is exposed via `responsibleAgencyName`
 *   - TrackingStatus history rows — staff names + transition reasons
 *   - Comments / staff remarks
 *   - User PII (email, phone, line uid, citizen id)
 *   - AI snapshot rows (§17 — read-side authorization is owner / staff)
 *   - Internal flags: isDraft, isBooked, bookedAt,
 *     deletedAt, createdAt, updatedAt
 *
 * `pageNumber` is now ALSO exposed in the `book` section because the
 * assembled PDF book is itself public per §16 / §18 — surfacing the
 * page index that a citizen would look up in the same PDF is no
 * broader than the existing public surface.
 *
 * Budget WAS previously deferred but is now exposed as a SUMMARY ONLY
 * (total amount + per-year breakdown). Budget rows are already
 * published verbatim in the assembled PDF books (which are themselves
 * public per §16 / §18), so a per-year summary is no broader than the
 * existing public surface. We deliberately do NOT expose per-row
 * `id`, `createdAt`, or any owning-FK metadata — only `{year, amount}`
 * pairs and the total.
 */
export interface PublicProjectDetailDto {
  projectId: string;
  projectTitle: string;
  objective: string;
  goal: string;
  expected: string;
  projectYear: number;
  /** Populated for STRATEGY_BASED plans only; null for ISSUE_BASED (§16.5). */
  indicator: string | null;
  classification: {
    reportFormat: 'STRATEGY_BASED' | 'ISSUE_BASED';
    strategyName?: string;
    tacticName?: string;
    planName?: string;
    developmentIssueName?: string;
  };
  geo: {
    startLat: number | null;
    startLng: number | null;
    endLat: number | null;
    endLng: number | null;
  };
  /**
   * Budget summary (year + amount only — no per-row id, no FK
   * metadata). Same data is already in the published PDF books.
   * `totalAmount` is the sum across all years; `perYear` is sorted
   * ascending by year.
   */
  budget: {
    totalAmount: number;
    perYear: Array<{ year: number; amount: number }>;
  };
  /** Agency NAME only — no contact info, no address, no phone (PDPA). */
  responsibleAgencyName: string | null;
  /**
   * Originating LAO NAME — populated ONLY for LAO-coordinated projects
   * (CLAUDE.md §5.2). For agency-origin projects this is `null` and
   * the FE suppresses the "ประสานมาจาก" line. Name ONLY; the LAO row
   * carries no PII directly.
   */
  originAgencyName: string | null;
  parentPlan: {
    planId: string;
    planName: string;
    startYear: number;
    endYear: number;
  };
  book: {
    /**
     * `'supplement'` indicates a `DevelopmentPlanSupplement` book,
     * served by the parallel `supplement_assembly_versions` table
     * (Wave public-archive-supplement BE-01).
     */
    sourceType:
      | 'main_plan'
      | 'edit_revision'
      | 'change_revision'
      | 'supplement';
    sourceId: string;
    bookName: string;
    latestVersionNumber: number;
    downloadUrl: string;
    /**
     * Page index inside the assembled PDF that this project appears
     * on. NULL when the project hasn't been booked yet OR the book
     * generation didn't write a page index. Citizens use this to
     * locate the project quickly inside a downloaded PDF.
     */
    pageNumber: number | null;
  };
  /** Always 'อนุมัติ' on this endpoint (eligibility predicate enforces it). */
  currentStatusThName: string;
  /**
   * Engagement counters (CLAUDE.md §17.2 advisory). Always non-null,
   * default 0. The optional `downloadCount` is the parent plan's
   * total download count across every version (not per-version) —
   * see BE-01 §4 out-of-scope.
   */
  engagement: {
    likeCount: number;
    viewCount: number;
    downloadCount?: number;
  };
}

@Injectable()
export class PublicArchiveService {
  private readonly logger = new Logger(PublicArchiveService.name);

  constructor(
    @InjectRepository(BookAssemblyVersion)
    private readonly versionRepo: Repository<BookAssemblyVersion>,
    @InjectRepository(DevelopmentPlan)
    private readonly devPlanRepo: Repository<DevelopmentPlan>,
    @InjectRepository(DevelopmentPlanRevision)
    private readonly devPlanRevisionRepo: Repository<DevelopmentPlanRevision>,
    @InjectRepository(DevelopmentPlanSupplement)
    private readonly devPlanSupplementRepo: Repository<DevelopmentPlanSupplement>,
    @InjectRepository(ProjectGroup)
    private readonly projectGroupRepo: Repository<ProjectGroup>,
    @InjectRepository(RevisedProjectGroup)
    private readonly revisedProjectGroupRepo: Repository<RevisedProjectGroup>,
    @InjectRepository(SupplementProjectGroup)
    private readonly supplementProjectGroupRepo: Repository<SupplementProjectGroup>,
    @InjectRepository(SupplementAssemblyVersion)
    private readonly supplementVersionRepo: Repository<SupplementAssemblyVersion>,
    private readonly bookAssemblyService: BookAssemblyService,
    private readonly supplementAssemblyService: SupplementAssemblyService,
  ) {}

  /**
   * Shared eligibility predicate for the public surface.
   *
   * A DevelopmentPlan is "publicly published" when it has at least one
   * `BookAssemblyVersion` with `sourceType=MAIN_PLAN` and
   * `status=COMPLETED`. This Set is the gate used by BOTH
   * `searchProjects` and `getProjectDetail` — every public-facing
   * project lookup MUST filter through it so anonymous callers can
   * never reach a project whose plan has no public assembled copy.
   *
   * Refreshed on every call (no caching) — a plan that was de-published
   * mid-session MUST disappear immediately. Cheap query (small table,
   * indexed on (sourceType, status)).
   */
  /**
   * Public accessor for the same eligibility set. Used by
   * `PublicEngagementService` so the like / view endpoints share the
   * exact same publish gate (no drift). Delegates to the private
   * implementation to keep a single source of truth.
   */
  async getPublishedPlanIdsPublic(): Promise<Set<string>> {
    return this.getPublishedPlanIds();
  }

  private async getPublishedPlanIds(): Promise<Set<string>> {
    const publishedMainVersions = await this.versionRepo.find({
      where: {
        sourceType: BookAssemblySourceType.MAIN_PLAN,
        status: BookAssemblyVersionStatus.COMPLETED,
      },
      select: { sourceId: true },
    });
    return new Set(publishedMainVersions.map((v) => v.sourceId));
  }

  /**
   * Build the path the FE will hand to its axios instance. The leading
   * `/v1` is NOT included because `VITE_API_BASE_URL` on the FE already
   * carries the version prefix.
   *
   * Accepts a `BookAssemblySourceType` (main/edit/change) OR the
   * dedicated `'supplement'` discriminator. The controller's PDF route
   * accepts both literal sets after Wave public-archive-supplement
   * widened the closed enum.
   */
  private buildDownloadUrl(
    sourceType: BookAssemblySourceType | 'supplement',
    sourceId: string,
    versionNumber: number,
  ): string {
    return `/public/plans/${sourceType}/${sourceId}/v${versionNumber}/pdf`;
  }

  /**
   * Map a COMPLETED BookAssemblyVersion entity to the PII-stripped
   * public shape. Returns null if the version is NOT completed (drafts
   * and deprecated versions are never exposed publicly).
   */
  private toPublicVersion(v: BookAssemblyVersion): PublicVersionDto | null {
    if (v.status !== BookAssemblyVersionStatus.COMPLETED) return null;
    return {
      versionNumber: v.versionNumber,
      mergedAt: v.mergedAt instanceof Date ? v.mergedAt.toISOString() : String(v.mergedAt),
      totalPages: v.totalPages,
      downloadUrl: this.buildDownloadUrl(v.sourceType, v.sourceId, v.versionNumber),
    };
  }

  /**
   * Map a COMPLETED `SupplementAssemblyVersion` to the same public
   * version shape as a regular BookAssembly version. The two tables are
   * deliberately separate (see `docs/supplement-book-domain.md` §9), so
   * we use the dedicated `'supplement'` discriminator when building the
   * download URL.
   *
   * `totalPages` is not tracked on supplement versions today (no
   * `total_pages` column on `supplement_assembly_versions`); we return
   * `null` so the FE renders parity with the historical pre-totalPages
   * BookAssembly shape.
   */
  private toPublicSupplementVersion(
    v: SupplementAssemblyVersion,
  ): PublicVersionDto | null {
    if (v.status !== SupplementAssemblyVersionStatus.COMPLETED) return null;
    return {
      versionNumber: v.versionNumber,
      mergedAt:
        v.mergedAt instanceof Date
          ? v.mergedAt.toISOString()
          : String(v.mergedAt),
      totalPages: null,
      downloadUrl: this.buildDownloadUrl(
        'supplement',
        v.developmentPlanSupplementId,
        v.versionNumber,
      ),
    };
  }

  /* ── #1 List plans (with optional filters) ───────────────────── */

  /**
   * Filter contract:
   *   - `q` — case-insensitive contains on plan name
   *   - `year` — single fiscal year that must fall within
   *     `[startYear, endYear]`
   *   - `type` — book type discriminator: 'all' | 'main' | 'edit' |
   *     'change'. Plans without a matching version are dropped when
   *     `type` is anything other than 'all'.
   *
   * The shape mirrors `BookAssemblyService.getAssemblyHistory` so the
   * FE can reuse most of its rendering primitives — minus the PII.
   */
  async listPlans(filters: {
    q?: string;
    year?: number;
    type?: 'all' | 'main' | 'edit' | 'change' | 'supplement';
  }): Promise<PublicPlanDto[]> {
    const { q, year, type = 'all' } = filters;

    // Plan WHERE: name contains q (if provided), year inside range.
    const planWhere: Record<string, unknown> = {};
    if (q && q.trim().length > 0) {
      planWhere.name = ILike(`%${q.trim()}%`);
    }
    const plans = await this.devPlanRepo.find({
      where: planWhere,
      order: { startYear: 'DESC' },
    });
    const yearFiltered = year
      ? plans.filter((p) => p.startYear <= year && year <= p.endYear)
      : plans;
    if (yearFiltered.length === 0) return [];

    const planIds = yearFiltered.map((p) => p.id);

    // Fetch revisions, supplements, and main-plan versions in parallel.
    // Supplements live in their OWN table per
    // `docs/supplement-book-domain.md` §9 — DO NOT union with
    // `book_assembly_versions`.
    const [revisions, supplements, mainVersions] = await Promise.all([
      this.devPlanRevisionRepo.find({
        where: { developmentPlan: { id: In(planIds) } },
        relations: ['revisionType', 'developmentPlan'],
        order: { revisionNumber: 'ASC' },
      }),
      this.devPlanSupplementRepo.find({
        where: { developmentPlan: { id: In(planIds) } },
        relations: ['developmentPlan'],
        // `deletedAt IS NULL` is implicit (TypeORM soft-delete column).
        order: { supplementNumber: 'ASC' },
      }),
      this.versionRepo.find({
        where: {
          sourceType: BookAssemblySourceType.MAIN_PLAN,
          sourceId: In(planIds),
          status: BookAssemblyVersionStatus.COMPLETED,
        },
        order: { versionNumber: 'DESC' },
      }),
    ]);

    const revisionIds = revisions.map((r) => r.id);
    let childVersions: BookAssemblyVersion[] = [];
    if (revisionIds.length > 0) {
      childVersions = await this.versionRepo.find({
        where: [
          {
            sourceType: BookAssemblySourceType.EDIT_REVISION,
            sourceId: In(revisionIds),
            status: BookAssemblyVersionStatus.COMPLETED,
          },
          {
            sourceType: BookAssemblySourceType.CHANGE_REVISION,
            sourceId: In(revisionIds),
            status: BookAssemblyVersionStatus.COMPLETED,
          },
        ],
        order: { versionNumber: 'DESC' },
      });
    }

    // Supplement versions live in a parallel table — load only
    // COMPLETED rows so drafts / future-DEPRECATED rows never surface.
    const supplementIds = supplements.map((s) => s.id);
    let supplementVersions: SupplementAssemblyVersion[] = [];
    if (supplementIds.length > 0) {
      supplementVersions = await this.supplementVersionRepo.find({
        where: {
          developmentPlanSupplementId: In(supplementIds),
          status: SupplementAssemblyVersionStatus.COMPLETED,
        },
        order: { versionNumber: 'DESC' },
      });
    }

    // Index by (sourceType:sourceId).
    const versionMap = new Map<string, BookAssemblyVersion[]>();
    for (const v of [...mainVersions, ...childVersions]) {
      const key = `${v.sourceType}:${v.sourceId}`;
      if (!versionMap.has(key)) versionMap.set(key, []);
      versionMap.get(key)!.push(v);
    }

    // Separate map for supplement versions — keyed by supplementId only
    // (no BookAssembly sourceType key collision risk).
    const supplementVersionMap = new Map<string, SupplementAssemblyVersion[]>();
    for (const sv of supplementVersions) {
      const arr = supplementVersionMap.get(sv.developmentPlanSupplementId) ?? [];
      arr.push(sv);
      supplementVersionMap.set(sv.developmentPlanSupplementId, arr);
    }

    // Revisions grouped by plan + by type.
    const revByPlan = new Map<string, DevelopmentPlanRevision[]>();
    for (const r of revisions) {
      const pid = r.developmentPlan?.id;
      if (!pid) continue;
      if (!revByPlan.has(pid)) revByPlan.set(pid, []);
      revByPlan.get(pid)!.push(r);
    }

    // Supplements grouped by plan.
    const supplementsByPlan = new Map<string, DevelopmentPlanSupplement[]>();
    for (const s of supplements) {
      const pid = s.developmentPlan?.id;
      if (!pid) continue;
      if (!supplementsByPlan.has(pid)) supplementsByPlan.set(pid, []);
      supplementsByPlan.get(pid)!.push(s);
    }

    const buildSupplementDtos = (
      planSupplements: DevelopmentPlanSupplement[],
    ): PublicSupplementDto[] => {
      return planSupplements
        .map((s) => {
          const versions = (supplementVersionMap.get(s.id) ?? [])
            .map((v) => this.toPublicSupplementVersion(v))
            .filter((v): v is PublicVersionDto => v !== null);
          return {
            supplementId: s.id,
            supplementName: `เพิ่มเติม ครั้งที่ ${s.supplementNumber}`,
            versions,
          };
        })
        .filter((s) => s.versions.length > 0); // only emit supplements that have a published version
    };

    const buildRevisionDtos = (
      planRevisions: DevelopmentPlanRevision[],
      typeName: 'แก้ไข' | 'เปลี่ยนแปลง',
      sourceType: BookAssemblySourceType,
    ): PublicRevisionDto[] => {
      return planRevisions
        .filter((r) => r.revisionType?.name === typeName)
        .map((r) => {
          const versions = (versionMap.get(`${sourceType}:${r.id}`) ?? [])
            .map((v) => this.toPublicVersion(v))
            .filter((v): v is PublicVersionDto => v !== null);
          return {
            revisionId: r.id,
            revisionName: `${typeName} ครั้งที่ ${r.revisionNumber}`,
            versions,
          };
        })
        .filter((r) => r.versions.length > 0); // only emit revisions that have a published version
    };

    const result: PublicPlanDto[] = yearFiltered.map((plan) => {
      const mainKey = `${BookAssemblySourceType.MAIN_PLAN}:${plan.id}`;
      const mainVersionDtos = (versionMap.get(mainKey) ?? [])
        .map((v) => this.toPublicVersion(v))
        .filter((v): v is PublicVersionDto => v !== null);

      const planRevisions = revByPlan.get(plan.id) ?? [];
      const editRevisions = buildRevisionDtos(
        planRevisions,
        'แก้ไข',
        BookAssemblySourceType.EDIT_REVISION,
      );
      const changeRevisions = buildRevisionDtos(
        planRevisions,
        'เปลี่ยนแปลง',
        BookAssemblySourceType.CHANGE_REVISION,
      );
      const planSupplements = supplementsByPlan.get(plan.id) ?? [];
      const supplementDtos = buildSupplementDtos(planSupplements);

      return {
        planId: plan.id,
        planName: plan.name,
        startYear: plan.startYear,
        endYear: plan.endYear,
        mainBook: mainVersionDtos.length > 0 ? { versions: mainVersionDtos } : null,
        editRevisions,
        changeRevisions,
        supplements: supplementDtos,
        // Engagement counters off the denormalized columns (CLAUDE.md
        // §17.2 advisory). Both default to 0 in the DB so the cast is
        // defensive only.
        viewCount: Number(plan.viewCount ?? 0),
        downloadCount: Number(plan.downloadCount ?? 0),
      };
    });

    // Type filter (drop plans whose matching book is empty).
    if (type === 'main') return result.filter((p) => p.mainBook !== null);
    if (type === 'edit') return result.filter((p) => p.editRevisions.length > 0);
    if (type === 'change') return result.filter((p) => p.changeRevisions.length > 0);
    if (type === 'supplement') return result.filter((p) => p.supplements.length > 0);

    // Drop plans with NO published content at all.
    return result.filter(
      (p) =>
        p.mainBook !== null ||
        p.editRevisions.length > 0 ||
        p.changeRevisions.length > 0 ||
        p.supplements.length > 0,
    );
  }

  /* ── #2 Stream PDF (anon access) ─────────────────────────────── */

  /**
   * Resolves the absolute disk path of a COMPLETED book version's
   * merged PDF. Drafts and deprecated versions are explicitly rejected
   * so an anonymous caller cannot stumble onto an unpublished file by
   * URL guess.
   *
   * Supports the BookAssembly source types (main/edit/change) AND the
   * dedicated `'supplement'` discriminator (Wave public-archive-
   * supplement BE-01). Supplement assembly lives in a parallel
   * subsystem (`docs/supplement-book-domain.md` §9) so we route through
   * `SupplementAssemblyService.getMergedAbsolutePath` rather than
   * `BookAssemblyService.getMergedPdfPath`. Both return absolute paths
   * resolvable from the storage root.
   */
  async resolvePublicPdfPath(
    sourceType: BookAssemblySourceType | 'supplement',
    sourceId: string,
    versionNumber: number,
  ): Promise<string> {
    if (sourceType === 'supplement') {
      // Eligibility gates: supplement must (a) exist, (b) be
      // non-soft-deleted, (c) have a COMPLETED version at the requested
      // number, AND (d) parent plan must be publicly published. All
      // failures collapse to uniform 404.
      const publishedPlanIds = await this.getPublishedPlanIds();
      if (publishedPlanIds.size === 0) {
        throw new NotFoundException('ไม่พบเล่มที่ระบุ');
      }
      const supplement = await this.devPlanSupplementRepo.findOne({
        where: { id: sourceId },
        relations: ['developmentPlan'],
      });
      if (!supplement || !supplement.developmentPlan) {
        throw new NotFoundException('ไม่พบเล่มที่ระบุ');
      }
      if (!publishedPlanIds.has(supplement.developmentPlan.id)) {
        throw new NotFoundException('ไม่พบเล่มที่ระบุ');
      }
      const version = await this.supplementVersionRepo.findOne({
        where: {
          developmentPlanSupplementId: sourceId,
          versionNumber,
        },
      });
      if (!version) {
        throw new NotFoundException('ไม่พบเล่มที่ระบุ');
      }
      if (version.status !== SupplementAssemblyVersionStatus.COMPLETED) {
        throw new NotFoundException('ไม่พบเล่มที่ระบุ');
      }
      return this.supplementAssemblyService.getMergedAbsolutePath(
        sourceId,
        versionNumber,
      );
    }

    const version = await this.versionRepo.findOne({
      where: { sourceType, sourceId, versionNumber },
    });
    if (!version) {
      throw new NotFoundException('ไม่พบเล่มที่ระบุ');
    }
    if (version.status !== BookAssemblyVersionStatus.COMPLETED) {
      // 404 (not 403) — do not reveal that the version exists but is
      // private. Anonymous callers see "not found" uniformly.
      throw new NotFoundException('ไม่พบเล่มที่ระบุ');
    }
    return this.bookAssemblyService.getMergedPdfPath(sourceType, sourceId, versionNumber);
  }

  /* ── #3 Project search ──────────────────────────────────────── */

  /**
   * Find approved projects whose title contains `q`, scoped to plans
   * that have at least one COMPLETED published book. Returns up to
   * `limit` results combined across PG + RPG, ordered by mergedAt of
   * the parent book (newest first).
   *
   * Only approved projects are returned to avoid surfacing in-flight
   * drafts via title search. Approved status check is via the latest
   * `TrackingStatus` row.
   */
  async searchProjects(
    q: string,
    limit: number = 50,
  ): Promise<PublicProjectSearchHit[]> {
    const trimmed = q?.trim();
    if (!trimmed || trimmed.length < 2) return [];

    // Pre-fetch plans that have at least one published main book to
    // avoid surfacing projects whose plan has no public assembled copy.
    // Delegates to the shared `getPublishedPlanIds` helper so the
    // eligibility predicate stays consistent with `getProjectDetail`.
    const publishedPlanIds = await this.getPublishedPlanIds();
    if (publishedPlanIds.size === 0) return [];

    // PG search.
    const pgRows = await this.projectGroupRepo
      .createQueryBuilder('pg')
      .leftJoinAndSelect('pg.developmentPlan', 'plan')
      .leftJoin('pg.trackingStatus', 'ts', 'ts.isLatest = true')
      .leftJoin('ts.statusId', 'status')
      .where('pg.title ILIKE :q', { q: `%${trimmed}%` })
      .andWhere('pg.deletedAt IS NULL')
      .andWhere('plan.id IN (:...planIds)', { planIds: Array.from(publishedPlanIds) })
      .andWhere('status.name = :statusName', { statusName: 'Approved' })
      .orderBy('pg.createdAt', 'DESC')
      .limit(limit)
      .getMany();

    const pgHits: PublicProjectSearchHit[] = pgRows.map((pg) => ({
      projectId: pg.id,
      projectTitle: pg.title,
      projectYear: pg.projectYear,
      sourceType: 'main_plan',
      sourceId: pg.developmentPlan?.id ?? '',
      planId: pg.developmentPlan?.id ?? '',
      planName: pg.developmentPlan?.name ?? '',
      bookName: pg.developmentPlan?.name ?? '',
      likeCount: Number(pg.likeCount ?? 0),
      viewCount: Number(pg.viewCount ?? 0),
    }));

    // RPG search — joined via developmentPlanRevision → developmentPlan.
    const rpgRows = await this.revisedProjectGroupRepo
      .createQueryBuilder('rpg')
      .leftJoinAndSelect('rpg.developmentPlanRevision', 'rev')
      .leftJoinAndSelect('rev.developmentPlan', 'plan')
      .leftJoinAndSelect('rev.revisionType', 'revType')
      .leftJoin('rpg.trackingStatus', 'ts', 'ts.isLatest = true')
      .leftJoin('ts.statusId', 'status')
      .where('rpg.title ILIKE :q', { q: `%${trimmed}%` })
      .andWhere('rpg.deletedAt IS NULL')
      .andWhere('plan.id IN (:...planIds)', { planIds: Array.from(publishedPlanIds) })
      .andWhere('status.name = :statusName', { statusName: 'Approved' })
      .orderBy('rpg.createdAt', 'DESC')
      .limit(limit)
      .getMany();

    const rpgHits: PublicProjectSearchHit[] = rpgRows
      .filter((rpg) => rpg.developmentPlanRevision?.id)
      .map((rpg) => {
        const rev = rpg.developmentPlanRevision!;
        const isChange = rev.revisionType?.name === 'เปลี่ยนแปลง';
        return {
          projectId: rpg.id,
          projectTitle: rpg.title,
          projectYear: rpg.projectYear,
          sourceType: isChange ? 'change_revision' : 'edit_revision',
          sourceId: rev.id,
          planId: rev.developmentPlan?.id ?? '',
          planName: rev.developmentPlan?.name ?? '',
          bookName: `${rev.revisionType?.name ?? ''} ครั้งที่ ${rev.revisionNumber}`,
          likeCount: Number(rpg.likeCount ?? 0),
          viewCount: Number(rpg.viewCount ?? 0),
        };
      });

    // SPG search — joined via developmentPlanSupplement → developmentPlan.
    // The supplement subsystem is parallel to BookAssembly
    // (`docs/supplement-book-domain.md` §9), but the same
    // publish-plan eligibility gate applies (§10 of the explainer).
    const spgRows = await this.supplementProjectGroupRepo
      .createQueryBuilder('spg')
      .leftJoinAndSelect('spg.developmentPlanSupplement', 'sup')
      .leftJoinAndSelect('sup.developmentPlan', 'plan')
      .leftJoin('spg.trackingStatus', 'ts', 'ts.isLatest = true')
      .leftJoin('ts.statusId', 'status')
      .where('spg.title ILIKE :q', { q: `%${trimmed}%` })
      .andWhere('spg.deletedAt IS NULL')
      .andWhere('sup.deleted_at IS NULL')
      .andWhere('plan.id IN (:...planIds)', {
        planIds: Array.from(publishedPlanIds),
      })
      .andWhere('status.name = :statusName', { statusName: 'Approved' })
      .orderBy('spg.createdAt', 'DESC')
      .limit(limit)
      .getMany();

    const spgHits: PublicProjectSearchHit[] = spgRows
      .filter((spg) => spg.developmentPlanSupplement?.id)
      .map((spg) => {
        const sup = spg.developmentPlanSupplement!;
        return {
          projectId: spg.id,
          projectTitle: spg.title,
          projectYear: spg.projectYear,
          sourceType: 'supplement' as const,
          sourceId: sup.id,
          planId: sup.developmentPlan?.id ?? '',
          planName: sup.developmentPlan?.name ?? '',
          bookName: `เพิ่มเติม ครั้งที่ ${sup.supplementNumber}`,
          likeCount: Number(spg.likeCount ?? 0),
          viewCount: Number(spg.viewCount ?? 0),
        };
      });

    return [...pgHits, ...rpgHits, ...spgHits].slice(0, limit);
  }

  /* ── #4 Project detail (anon access) ─────────────────────────── */

  /**
   * Returns a PII-redacted detail DTO for a single approved project
   * (PG or RPG) whose parent plan has at least one COMPLETED published
   * book. Used by the public-archive detail modal + permalink page.
   *
   * Uniform 404 contract — every ineligibility (not found, soft-deleted,
   * not approved, plan not publicly published, sourceType / id mismatch)
   * returns the SAME `NotFoundException('ไม่พบโครงการที่ระบุ')`. This
   * prevents enumeration of internal projects and PDPA leakage.
   *
   * Branches on:
   *   - `sourceType` → PG vs RPG repo
   *   - parent plan's `reportFormat` → STRATEGY_BASED vs ISSUE_BASED
   *     classification fields (§16.5)
   */
  async getProjectDetail(
    sourceType:
      | 'main_plan'
      | 'edit_revision'
      | 'change_revision'
      | 'supplement',
    projectId: string,
  ): Promise<PublicProjectDetailDto> {
    // Cheap UUID shape gate. Defensive — Express already strips most
    // junk via param parsing but a malformed string would otherwise
    // raise a 500 from Postgres' uuid cast.
    if (!projectId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
      throw new NotFoundException('ไม่พบโครงการที่ระบุ');
    }

    const publishedPlanIds = await this.getPublishedPlanIds();
    if (publishedPlanIds.size === 0) {
      throw new NotFoundException('ไม่พบโครงการที่ระบุ');
    }

    if (sourceType === 'main_plan') {
      return this.getProjectGroupDetail(projectId, publishedPlanIds);
    }
    if (sourceType === 'supplement') {
      return this.getSupplementProjectGroupDetail(projectId, publishedPlanIds);
    }
    return this.getRevisedProjectGroupDetail(projectId, sourceType, publishedPlanIds);
  }

  private async getProjectGroupDetail(
    projectId: string,
    publishedPlanIds: Set<string>,
  ): Promise<PublicProjectDetailDto> {
    const pg = await this.projectGroupRepo
      .createQueryBuilder('pg')
      .leftJoinAndSelect('pg.developmentPlan', 'plan')
      .leftJoinAndSelect('pg.strategy', 'strategy')
      .leftJoinAndSelect('pg.tactic', 'tactic')
      .leftJoinAndSelect('pg.plan', 'planClassification')
      .leftJoinAndSelect('pg.developmentIssue', 'devIssue')
      .leftJoinAndSelect('pg.responsibleAgency', 'respAgency')
      .leftJoinAndSelect('pg.originAgencyId', 'originAgency')
      .leftJoinAndSelect('pg.budgets', 'budgets')
      .leftJoin('pg.trackingStatus', 'ts', 'ts.isLatest = true')
      .leftJoin('ts.statusId', 'status')
      .where('pg.id = :id', { id: projectId })
      .andWhere('pg.deletedAt IS NULL')
      .andWhere('status.name = :statusName', { statusName: 'Approved' })
      .getOne();

    if (!pg || !pg.developmentPlan) {
      throw new NotFoundException('ไม่พบโครงการที่ระบุ');
    }
    const plan = pg.developmentPlan;
    if (!publishedPlanIds.has(plan.id)) {
      throw new NotFoundException('ไม่พบโครงการที่ระบุ');
    }

    const latestVersion = await this.versionRepo.findOne({
      where: {
        sourceType: BookAssemblySourceType.MAIN_PLAN,
        sourceId: plan.id,
        status: BookAssemblyVersionStatus.COMPLETED,
      },
      order: { versionNumber: 'DESC' },
    });
    if (!latestVersion) {
      // Defensive: predicate already required at least one, but the
      // plan may have just been de-published in a race. Uniform 404.
      throw new NotFoundException('ไม่พบโครงการที่ระบุ');
    }

    this.logger.log(
      `[public] detail main_plan id=${pg.id} plan=${plan.id} v${latestVersion.versionNumber}`,
    );

    return this.assembleDetail({
      projectId: pg.id,
      title: pg.title,
      objective: pg.objective,
      goal: pg.goal,
      expected: pg.expected,
      projectYear: pg.projectYear,
      indicator: pg.indicator,
      startLat: pg.startLat,
      startLng: pg.startLng,
      endLat: pg.endLat,
      endLng: pg.endLng,
      strategyName: pg.strategy?.name ?? null,
      tacticName: pg.tactic?.name ?? null,
      planClassificationName: pg.plan?.name ?? null,
      developmentIssueName: pg.developmentIssue?.name ?? null,
      responsibleAgencyName: pg.responsibleAgency?.name ?? null,
      originAgencyName: pg.originAgencyId?.name ?? null,
      budgets: pg.budgets ?? [],
      parentPlan: plan,
      book: {
        sourceType: 'main_plan',
        sourceId: plan.id,
        bookName: plan.name,
        latestVersionNumber: latestVersion.versionNumber,
        pageNumber: pg.pageNumber,
      },
      engagement: {
        likeCount: Number(pg.likeCount ?? 0),
        viewCount: Number(pg.viewCount ?? 0),
        downloadCount: Number(plan.downloadCount ?? 0),
      },
    });
  }

  private async getRevisedProjectGroupDetail(
    projectId: string,
    sourceType: 'edit_revision' | 'change_revision',
    publishedPlanIds: Set<string>,
  ): Promise<PublicProjectDetailDto> {
    const rpg = await this.revisedProjectGroupRepo
      .createQueryBuilder('rpg')
      .leftJoinAndSelect('rpg.developmentPlanRevision', 'rev')
      .leftJoinAndSelect('rev.developmentPlan', 'plan')
      .leftJoinAndSelect('rev.revisionType', 'revType')
      .leftJoinAndSelect('rpg.strategy', 'strategy')
      .leftJoinAndSelect('rpg.tactic', 'tactic')
      .leftJoinAndSelect('rpg.plan', 'planClassification')
      .leftJoinAndSelect('rpg.developmentIssue', 'devIssue')
      .leftJoinAndSelect('rpg.responsibleAgency', 'respAgency')
      .leftJoinAndSelect('rpg.originAgencyId', 'originAgency')
      .leftJoinAndSelect('rpg.budgets', 'budgets')
      .leftJoin('rpg.trackingStatus', 'ts', 'ts.isLatest = true')
      .leftJoin('ts.statusId', 'status')
      .where('rpg.id = :id', { id: projectId })
      .andWhere('rpg.deletedAt IS NULL')
      .andWhere('status.name = :statusName', { statusName: 'Approved' })
      .getOne();

    if (!rpg || !rpg.developmentPlanRevision || !rpg.developmentPlanRevision.developmentPlan) {
      throw new NotFoundException('ไม่พบโครงการที่ระบุ');
    }

    const rev = rpg.developmentPlanRevision;
    const plan = rev.developmentPlan!;
    if (!publishedPlanIds.has(plan.id)) {
      throw new NotFoundException('ไม่พบโครงการที่ระบุ');
    }

    // Enforce sourceType ↔ revisionType pairing. Mismatched calls
    // (main_plan param against an RPG id, change_revision against an
    // edit RPG, …) get a uniform 404.
    const revTypeName = rev.revisionType?.name;
    const expectedTypeName: 'แก้ไข' | 'เปลี่ยนแปลง' =
      sourceType === 'change_revision' ? 'เปลี่ยนแปลง' : 'แก้ไข';
    if (revTypeName !== expectedTypeName) {
      throw new NotFoundException('ไม่พบโครงการที่ระบุ');
    }

    const bookSourceType =
      sourceType === 'change_revision'
        ? BookAssemblySourceType.CHANGE_REVISION
        : BookAssemblySourceType.EDIT_REVISION;
    const latestVersion = await this.versionRepo.findOne({
      where: {
        sourceType: bookSourceType,
        sourceId: rev.id,
        status: BookAssemblyVersionStatus.COMPLETED,
      },
      order: { versionNumber: 'DESC' },
    });
    if (!latestVersion) {
      // The revision book itself may have no published version even
      // though the parent plan is published. Uniform 404 — the public
      // surface only shows projects whose own book is downloadable.
      throw new NotFoundException('ไม่พบโครงการที่ระบุ');
    }

    this.logger.log(
      `[public] detail ${sourceType} id=${rpg.id} rev=${rev.id} v${latestVersion.versionNumber}`,
    );

    return this.assembleDetail({
      projectId: rpg.id,
      title: rpg.title,
      objective: rpg.objective,
      goal: rpg.goal,
      expected: rpg.expected,
      projectYear: rpg.projectYear,
      indicator: rpg.indicator,
      startLat: rpg.startLat,
      startLng: rpg.startLng,
      endLat: rpg.endLat,
      endLng: rpg.endLng,
      strategyName: rpg.strategy?.name ?? null,
      tacticName: rpg.tactic?.name ?? null,
      planClassificationName: rpg.plan?.name ?? null,
      developmentIssueName: rpg.developmentIssue?.name ?? null,
      responsibleAgencyName: rpg.responsibleAgency?.name ?? null,
      originAgencyName: rpg.originAgencyId?.name ?? null,
      budgets: rpg.budgets ?? [],
      parentPlan: plan,
      book: {
        sourceType,
        sourceId: rev.id,
        bookName: `${revTypeName} ครั้งที่ ${rev.revisionNumber}`,
        latestVersionNumber: latestVersion.versionNumber,
        pageNumber: rpg.pageNumber,
      },
      engagement: {
        likeCount: Number(rpg.likeCount ?? 0),
        viewCount: Number(rpg.viewCount ?? 0),
        downloadCount: Number(plan.downloadCount ?? 0),
      },
    });
  }

  private async getSupplementProjectGroupDetail(
    projectId: string,
    publishedPlanIds: Set<string>,
  ): Promise<PublicProjectDetailDto> {
    // SPG mirrors PG's relation shape (per
    // `docs/supplement-book-domain.md` §6 field parity table). The same
    // `assembleDetail` helper is reused field-by-field — no entity
    // spread, so a future column drift on SPG cannot leak through.
    const spg = await this.supplementProjectGroupRepo
      .createQueryBuilder('spg')
      .leftJoinAndSelect('spg.developmentPlanSupplement', 'sup')
      .leftJoinAndSelect('sup.developmentPlan', 'plan')
      .leftJoinAndSelect('spg.strategy', 'strategy')
      .leftJoinAndSelect('spg.tactic', 'tactic')
      .leftJoinAndSelect('spg.plan', 'planClassification')
      .leftJoinAndSelect('spg.developmentIssue', 'devIssue')
      .leftJoinAndSelect('spg.responsibleAgency', 'respAgency')
      .leftJoinAndSelect('spg.originAgencyId', 'originAgency')
      .leftJoinAndSelect('spg.budgets', 'budgets')
      .leftJoin('spg.trackingStatus', 'ts', 'ts.isLatest = true')
      .leftJoin('ts.statusId', 'status')
      .where('spg.id = :id', { id: projectId })
      .andWhere('spg.deletedAt IS NULL')
      .andWhere('status.name = :statusName', { statusName: 'Approved' })
      .getOne();

    if (
      !spg ||
      !spg.developmentPlanSupplement ||
      !spg.developmentPlanSupplement.developmentPlan
    ) {
      throw new NotFoundException('ไม่พบโครงการที่ระบุ');
    }

    const sup = spg.developmentPlanSupplement;
    // Defensive: a soft-deleted parent supplement collapses to 404 so
    // anonymous callers can never reach an SPG whose book has been
    // cancelled (CLAUDE.md §18 orphan-cleanup cascade soft-deletes
    // SPGs alongside the book; this guard handles the inverse race).
    if (sup.deletedAt) {
      throw new NotFoundException('ไม่พบโครงการที่ระบุ');
    }
    const plan = sup.developmentPlan;
    if (!publishedPlanIds.has(plan.id)) {
      throw new NotFoundException('ไม่พบโครงการที่ระบุ');
    }

    const latestVersion = await this.supplementVersionRepo.findOne({
      where: {
        developmentPlanSupplementId: sup.id,
        status: SupplementAssemblyVersionStatus.COMPLETED,
      },
      order: { versionNumber: 'DESC' },
    });
    if (!latestVersion) {
      // Parent plan is published but this specific supplement book has
      // no COMPLETED version yet. Uniform 404 — the public surface only
      // shows projects whose own book is downloadable.
      throw new NotFoundException('ไม่พบโครงการที่ระบุ');
    }

    this.logger.log(
      `[public] detail supplement id=${spg.id} sup=${sup.id} v${latestVersion.versionNumber}`,
    );

    return this.assembleDetail({
      projectId: spg.id,
      title: spg.title,
      objective: spg.objective,
      goal: spg.goal,
      expected: spg.expected,
      projectYear: spg.projectYear,
      indicator: spg.indicator,
      startLat: spg.startLat,
      startLng: spg.startLng,
      endLat: spg.endLat,
      endLng: spg.endLng,
      strategyName: spg.strategy?.name ?? null,
      tacticName: spg.tactic?.name ?? null,
      planClassificationName: spg.plan?.name ?? null,
      developmentIssueName: spg.developmentIssue?.name ?? null,
      responsibleAgencyName: spg.responsibleAgency?.name ?? null,
      // SPG is agency-only origin per workflow-add-project-supplement.md
      // (Q1+Q2) — `originAgencyId` is effectively unused. Surfacing the
      // name if it were ever populated keeps the FE branch consistent.
      originAgencyName: spg.originAgencyId?.name ?? null,
      budgets: spg.budgets ?? [],
      parentPlan: plan,
      book: {
        sourceType: 'supplement',
        sourceId: sup.id,
        bookName: `เพิ่มเติม ครั้งที่ ${sup.supplementNumber}`,
        latestVersionNumber: latestVersion.versionNumber,
        pageNumber: spg.pageNumber,
      },
      engagement: {
        likeCount: Number(spg.likeCount ?? 0),
        viewCount: Number(spg.viewCount ?? 0),
        downloadCount: Number(plan.downloadCount ?? 0),
      },
    });
  }

  /**
   * Field-by-field DTO assembly. NEVER spread an entity here — every
   * field is named explicitly so a future entity column drift cannot
   * leak through accidentally (PDPA + §17 audit-trail integrity).
   *
   * Branches on parent plan's `reportFormat` per §16.5 to keep the
   * classification shape mutually exclusive. If the source row has a
   * shape that does not match `reportFormat` (legacy bug), the
   * populated half is emitted as-is — see BE-01 §11 risk note.
   */
  private assembleDetail(input: {
    projectId: string;
    title: string;
    objective: string;
    goal: string;
    expected: string;
    projectYear: number;
    indicator: string | null;
    startLat: number | null;
    startLng: number | null;
    endLat: number | null;
    endLng: number | null;
    strategyName: string | null;
    tacticName: string | null;
    planClassificationName: string | null;
    developmentIssueName: string | null;
    responsibleAgencyName: string | null;
    /**
     * Originating LAO name for LAO-coordinated projects. Null for
     * agency-origin projects (FE suppresses the line). CLAUDE.md §5.2.
     */
    originAgencyName: string | null;
    /**
     * Raw Budget rows from the project. The assembler keeps ONLY
     * `{year, amount}` pairs — every other column (id, FK metadata,
     * createdAt) is discarded so a future entity drift cannot leak.
     */
    budgets: Array<{ year: number; quantity: number | string }>;
    parentPlan: DevelopmentPlan;
    book: {
      sourceType:
        | 'main_plan'
        | 'edit_revision'
        | 'change_revision'
        | 'supplement';
      sourceId: string;
      bookName: string;
      latestVersionNumber: number;
      pageNumber: number | null;
    };
    engagement: {
      likeCount: number;
      viewCount: number;
      downloadCount: number;
    };
  }): PublicProjectDetailDto {
    const plan = input.parentPlan;
    const reportFormat: 'STRATEGY_BASED' | 'ISSUE_BASED' =
      plan.reportFormat === ReportFormat.ISSUE_BASED ? 'ISSUE_BASED' : 'STRATEGY_BASED';

    const classification: PublicProjectDetailDto['classification'] =
      reportFormat === 'ISSUE_BASED'
        ? {
            reportFormat,
            developmentIssueName: input.developmentIssueName ?? undefined,
          }
        : {
            reportFormat,
            strategyName: input.strategyName ?? undefined,
            tacticName: input.tacticName ?? undefined,
            planName: input.planClassificationName ?? undefined,
          };

    return {
      projectId: input.projectId,
      projectTitle: input.title,
      objective: input.objective,
      goal: input.goal,
      expected: input.expected,
      projectYear: input.projectYear,
      indicator: reportFormat === 'STRATEGY_BASED' ? input.indicator : null,
      classification,
      geo: {
        startLat: input.startLat !== null ? Number(input.startLat) : null,
        startLng: input.startLng !== null ? Number(input.startLng) : null,
        endLat: input.endLat !== null ? Number(input.endLat) : null,
        endLng: input.endLng !== null ? Number(input.endLng) : null,
      },
      budget: (() => {
        // Aggregate raw rows → {year, amount} per year (sum across
        // duplicates, defensive). decimal columns arrive as strings
        // from pg, hence `Number()` here.
        const perYearMap = new Map<number, number>();
        for (const row of input.budgets) {
          const amount = Number(row.quantity);
          if (!Number.isFinite(amount)) continue;
          perYearMap.set(row.year, (perYearMap.get(row.year) ?? 0) + amount);
        }
        const perYear = Array.from(perYearMap.entries())
          .map(([year, amount]) => ({ year, amount }))
          .sort((a, b) => a.year - b.year);
        const totalAmount = perYear.reduce((sum, r) => sum + r.amount, 0);
        return { totalAmount, perYear };
      })(),
      responsibleAgencyName: input.responsibleAgencyName,
      originAgencyName: input.originAgencyName,
      parentPlan: {
        planId: plan.id,
        planName: plan.name,
        startYear: plan.startYear,
        endYear: plan.endYear,
      },
      book: {
        sourceType: input.book.sourceType,
        sourceId: input.book.sourceId,
        bookName: input.book.bookName,
        latestVersionNumber: input.book.latestVersionNumber,
        downloadUrl: this.buildDownloadUrl(
          input.book.sourceType === 'main_plan'
            ? BookAssemblySourceType.MAIN_PLAN
            : input.book.sourceType === 'change_revision'
              ? BookAssemblySourceType.CHANGE_REVISION
              : input.book.sourceType === 'edit_revision'
                ? BookAssemblySourceType.EDIT_REVISION
                : 'supplement',
          input.book.sourceId,
          input.book.latestVersionNumber,
        ),
        pageNumber: input.book.pageNumber,
      },
      currentStatusThName: 'อนุมัติ',
      engagement: {
        likeCount: input.engagement.likeCount,
        viewCount: input.engagement.viewCount,
        downloadCount: input.engagement.downloadCount,
      },
    };
  }
}
