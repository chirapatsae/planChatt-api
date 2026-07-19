import { Injectable, Logger } from '@nestjs/common';

import { UnifiedEquipmentService } from 'src/unified-equipment/unified-equipment.service';
import type { UnifiedEquipmentRow } from 'src/unified-equipment/types/unified-equipment-row';
import {
  REVISION_ROUND_LABEL_MAIN,
  resolveRevisionRoundLabel,
  bookDisplayLabel,
} from '../constants/revision-round-label';

/**
 * Wave AI-Exec-Chat-Equipment-ผ.03 — BE node N2
 * (docs/tasks/AI_EXEC_CHAT_EQUIPMENT_P03_COVERAGE.md §3.2).
 *
 * Tier-B aggregation surface for the seven equipment (ผ.03) executive
 * tools. The equipment analog of the project-side Tier-B services, with
 * ONE deliberate architectural difference: instead of re-implementing
 * the EPG/RELPG/SEPG HEAD-of-lineage merge, this service delegates its
 * ENTIRE spine to `UnifiedEquipmentService.executiveList` — the SINGLE
 * canonical source of:
 *
 *   - §14.2 HEAD-of-lineage REPLACE anti-joins (EPG↔RELPG, RELPG chain)
 *   - §10 per-row plan-scope binding (EPG → plan; RELPG → DPR → plan;
 *     SEPG → DPS → plan)
 *   - W67 executive post-processing (Ready / Pull_Back /
 *     Returned_For_Revision stripped; `executiveStatusGroup` 4-group tag)
 *
 * Query-shape guarantee (task §3.2 "no N+1"): each public method issues
 * EXACTLY ONE `executiveList` call, which internally runs one batched
 * `Promise.all` of three eager-join queries (EPG / RELPG / SEPG). All
 * grouping / filtering / rollup math below is in-memory — acceptable and
 * intentional at single-municipality (เทศบาลตำบลหนองกระทุ่ม) scale.
 *
 * PII discipline (task §9): `UnifiedEquipmentRow.createdBy` carries
 * firstName / lastName / profileImageUrl. NONE of those fields are ever
 * projected into `EquipmentToolItem` — the LLM-visible surface is
 * creator-free by construction. (Verified by the sibling spec.)
 *
 * CLAUDE.md references: §17.2 advisory / READ-only; §17.11 no role
 * exemption (role assertion lives in the tool handlers); §16.5 dual
 * classification shape (rows carry strategy/tactic/plan OR
 * developmentIssue — this service never assumes STRATEGY_BASED).
 */

/** Book scope filter — mirrors the project tools' scope vocabulary. */
export type EquipmentBookScope = 'all' | 'main' | 'revision' | 'supplement';

/**
 * LLM-visible equipment row. Token-cheap, PII-free projection of
 * `UnifiedEquipmentRow`. Nullable members follow the §17.9
 * nullable-via-required-only registry convention.
 */
export interface EquipmentToolItem {
  equipmentId: string;
  equipmentKind: 'equipment' | 'revised-equipment' | 'supplement-equipment';
  /** e.g. "เล่มหลัก" | "เล่มแก้ไขครุภัณฑ์ ครั้งที่ 1" | "เล่มเพิ่มเติมครุภัณฑ์ ครั้งที่ 2" */
  bookLabel: string;
  name: string;
  categoryCode: number | null;
  categoryName: string | null;
  planId: string | null;
  planName: string | null;
  currentStatus: string | null;
  statusTh: string | null;
  /** W67 4-group rollup — non-null by construction on the executive path. */
  executiveStatus: string | null;
  responsibleAgencyName: string | null;
  /** Sum of the row's per-year budgets (บาท). */
  totalBudget: number;
  isBooked: boolean;
  pageNumber: number | null;
  createdAt: string;
}

export interface EquipmentSearchResult {
  items: EquipmentToolItem[];
  totalMatched: number;
}

export interface EquipmentPagedResult {
  items: EquipmentToolItem[];
  totalCount: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
}

export interface EquipmentBudgetSummary {
  // `headItemCount` = HEAD-of-lineage count (latest version per lineage), NOT
  // the document count printed in the book. For "เล่ม X มีกี่ครุภัณฑ์" use
  // getPlanCatalogOverview / listEquipmentInPlan totalCount (document). This is
  // a BUDGET tool; the count is explicitly HEAD-labeled to stop misroute.
  headItemCount: number;
  totalBudget: number;
  averageBudget: number;
  byYear: Array<{
    year: number | null;
    headItemCount: number;
    totalBudget: number;
  }>;
  // Wave AI-EXEC-CHAT-LIVE-QA-4BUG (BUG3) — the old single `revision` bucket
  // MERGED เล่มแก้ไข (edit) + เล่มเปลี่ยนแปลง (change), which VIOLATES the hard
  // แก้ไข≠เปลี่ยนแปลง invariant (the LLM then labelled the merged 600k as
  // "เล่มแก้ไข"). Split into two distinct buckets so each revision type is
  // reported separately with its own correct amount.
  byBook: {
    main: { headItemCount: number; totalBudget: number };
    edit: { headItemCount: number; totalBudget: number };
    change: { headItemCount: number; totalBudget: number };
    supplement: { headItemCount: number; totalBudget: number };
  };
}

export interface EquipmentStatusBreakdown {
  totalCount: number;
  items: Array<{ status: string; statusTh: string; count: number }>;
  executiveStatusBreakdown: {
    pendingReviewCount: number;
    awaitingApprovalCount: number;
    approvedCount: number;
    rejectedCount: number;
  };
}

/**
 * Wave AI-EXEC-CHAT-BOOK-ANSWER-QUALITY / BE-AGG-01 — token-cheap
 * per-child-book equipment counts (COUNTS ONLY — no item projection),
 * consumed by the `getPlanCatalogOverview` orchestrator so plan-level
 * answers can enumerate ครุภัณฑ์ (ผ.03) per child book **แยกรายรอบ**.
 *
 * D1 (contract-binding): "แก้ไข" and "เปลี่ยนแปลง" are DISTINCT book
 * types — `byRevision[]` carries the raw `revisionTypeName` so the caller
 * never collapses the two. Counts are grouped by the child book's own id
 * (revisionId / supplementId), NOT rolled up per `kind`.
 */
export interface EquipmentChildBookCounts {
  /** เล่มหลัก (kind='equipment') item count. */
  main: { itemCount: number };
  byRevision: Array<{
    revisionId: string;
    revisionNumber: number;
    /** 'แก้ไข' | 'เปลี่ยนแปลง' (or edit/change) — NEVER collapsed. */
    revisionTypeName: string;
    itemCount: number;
  }>;
  bySupplement: Array<{
    supplementId: string;
    supplementNumber: number;
    itemCount: number;
  }>;
  /**
   * Defensive drift guard — rows whose `kind` implies a child book but
   * whose parent-book meta id is missing. Counted here (never silently
   * dropped) so downstream totals stay reconcilable.
   */
  unresolvedCount: number;
}

/**
 * Wave AI-EXEC-CHAT-EQUIPMENT-HEAD-ROSTER — one row per equipment lineage in
 * a plan, pointing at the CURRENT HEAD book + page + status. The equipment
 * analog of the project `listProjectHeadRoster`. Deduped (1 row per lineage)
 * because it is derived from `executiveList` (HEAD-of-lineage rows). Book
 * labels use `resolveRevisionRoundLabel` (DPR/DPS description) so they read
 * IDENTICALLY to the project roster ("แก้ไข ครั้งที่ 1/2569"), NOT the
 * equipment-specific "เล่มแก้ไขครุภัณฑ์ ครั้งที่ N" phrasing.
 */
export interface EquipmentHeadRosterRow {
  equipmentName: string;
  categoryName: string | null;
  originBookType: 'main' | 'revised' | 'supplement';
  headBookLabel: string;
  headBookType: 'main' | 'edit' | 'change' | 'supplement';
  headRevisionNumber: number | null;
  headPageNumber: number | null;
  headStatusTh: string | null;
}

export interface EquipmentCategoryBreakdown {
  totalCount: number;
  items: Array<{
    categoryCode: number | null;
    categoryName: string | null;
    itemCount: number;
    totalBudget: number;
  }>;
}

export interface EquipmentRevisionBookResult extends EquipmentPagedResult {
  revisionMeta: {
    revisionId: string;
    revisionNumber: number;
    revisionTypeName: string;
    isOpen: boolean;
    isBooked: boolean;
  };
}

export interface EquipmentSupplementBookResult extends EquipmentPagedResult {
  supplementMeta: {
    supplementId: string;
    supplementNumber: number;
    isOpen: boolean;
    isBooked: boolean;
  };
}

const SCOPE_TO_KIND: Record<
  Exclude<EquipmentBookScope, 'all'>,
  UnifiedEquipmentRow['kind']
> = {
  main: 'equipment',
  revision: 'revised-equipment',
  supplement: 'supplement-equipment',
};

@Injectable()
export class UnifiedEquipmentAggregatorService {
  private readonly logger = new Logger(UnifiedEquipmentAggregatorService.name);

  constructor(private readonly unifiedEquipment: UnifiedEquipmentService) {}

  // ────────────────────────────────────────────────────────────────
  //  Public tool-facing methods (one spine call each)
  // ────────────────────────────────────────────────────────────────

  async search(
    keyword: string,
    opts: { scope?: EquipmentBookScope; planId?: string; limit?: number } = {},
  ): Promise<EquipmentSearchResult> {
    const rows = this.applyScope(await this.loadRows(opts.planId), opts.scope);
    const kw = (keyword ?? '').trim().toLowerCase();
    if (kw.length === 0) {
      return { items: [], totalMatched: 0 };
    }
    const matched = rows.filter(
      (r) =>
        r.equipmentName.toLowerCase().includes(kw) ||
        (r.equipmentCategory?.name ?? '').toLowerCase().includes(kw),
    );
    const limit = clampInt(opts.limit, 10, 1, 50);
    return {
      items: matched.slice(0, limit).map((r) => this.toItem(r)),
      totalMatched: matched.length,
    };
  }

  async listInPlan(
    // Wave FOLLOWUP-CONTINUITY — `planId` is optional. `undefined` =
    // WHOLE-MUNICIPALITY listing (the loaders apply the plan filter
    // conditionally), symmetric with budgetSummary / statusBreakdown.
    planId: string | undefined,
    opts: {
      scope?: EquipmentBookScope;
      status?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<EquipmentPagedResult> {
    // Wave AI-EXEC-CHAT-WHOLE-PLAN-EQUIPMENT-LISTING-HEAD-CONSISTENCY —
    // scope-based source switch so the LISTING agrees with the COUNT:
    //   • WHOLE-PLAN (scope 'all' or omitted) → HEAD-of-lineage rows
    //     (`loadRows` = executiveList, §14.2 REPLACE anti-join, deduped to the
    //     latest version of each lineage). This is the SAME HEAD spine that
    //     feeds budgetSummary.headItemCount / statusBreakdown.totalCount, so
    //     "ครุภัณฑ์ในแผนมีกี่รายการ" (count=3) and "ขอดูรายละเอียด...ในแผน"
    //     (listing=3) return the SAME distinct set — NOT the 5 document rows.
    //   • PER-BOOK (scope 'main' | 'revision' | 'supplement') → DOCUMENT rows
    //     (`loadDocumentRows`, no anti-join) so a single-book listing matches
    //     the printed ผ.03 book + documentCountsByBook (main still counts an
    //     item later revised in another book). UNCHANGED — deliberate prior fix.
    const wholePlan = !opts.scope || opts.scope === 'all';
    let rows = wholePlan
      ? await this.loadRows(planId)
      : this.applyScope(await this.loadDocumentRows(planId), opts.scope);
    if (opts.status) {
      rows = rows.filter((r) => r.status.name === opts.status);
    }
    // WHOLE-PLAN HEAD rows carry the roster-style book label ("เล่มแก้ไข
    // ครั้งที่ 1/2569") so the HEAD listing reads identically to
    // listEquipmentHeadRoster; per-book listing keeps the document bookLabel.
    return this.paginate(rows, opts.limit, opts.offset, wholePlan);
  }

  async budgetSummary(
    opts: { planId?: string; scope?: EquipmentBookScope } = {},
  ): Promise<EquipmentBudgetSummary> {
    const rows = this.applyScope(await this.loadRows(opts.planId), opts.scope);

    let totalBudget = 0;
    const byYearMap = new Map<
      string,
      { year: number | null; headItemCount: number; totalBudget: number }
    >();
    const byBook = {
      main: { headItemCount: 0, totalBudget: 0 },
      edit: { headItemCount: 0, totalBudget: 0 },
      change: { headItemCount: 0, totalBudget: 0 },
      supplement: { headItemCount: 0, totalBudget: 0 },
    };

    for (const row of rows) {
      const rowTotal = this.rowTotalBudget(row);
      totalBudget += rowTotal;

      // BUG3 — revised-equipment rows are further discriminated into
      // edit (แก้ไข) vs change (เปลี่ยนแปลง) via the same DPR-type logic as
      // `rosterHeadBookType`, so the two revision types are NEVER merged.
      const bookKey: 'main' | 'edit' | 'change' | 'supplement' =
        row.kind === 'equipment'
          ? 'main'
          : row.kind === 'supplement-equipment'
            ? 'supplement'
            : this.revisedEquipmentBookKind(row);
      byBook[bookKey].headItemCount += 1;
      byBook[bookKey].totalBudget += rowTotal;

      for (const b of row.budgets) {
        const key = b.year === null ? 'null' : String(b.year);
        const bucket = byYearMap.get(key) ?? {
          year: b.year,
          headItemCount: 0,
          totalBudget: 0,
        };
        bucket.headItemCount += 1;
        bucket.totalBudget += b.quantity || 0;
        byYearMap.set(key, bucket);
      }
    }

    const byYear = [...byYearMap.values()].sort((a, b) => {
      // Nulls last; otherwise ascending fiscal year.
      if (a.year === null) return 1;
      if (b.year === null) return -1;
      return a.year - b.year;
    });

    const headItemCount = rows.length;
    return {
      headItemCount,
      totalBudget,
      averageBudget: headItemCount === 0 ? 0 : totalBudget / headItemCount,
      byYear,
      byBook,
    };
  }

  async statusBreakdown(
    opts: { planId?: string; scope?: EquipmentBookScope } = {},
  ): Promise<EquipmentStatusBreakdown> {
    const rows = this.applyScope(await this.loadRows(opts.planId), opts.scope);

    const byStatus = new Map<string, { statusTh: string; count: number }>();
    const exec = {
      pendingReviewCount: 0,
      awaitingApprovalCount: 0,
      approvedCount: 0,
      rejectedCount: 0,
    };

    for (const row of rows) {
      const name = row.status.name || '(ไม่ระบุ)';
      const bucket = byStatus.get(name) ?? {
        statusTh: row.status.thName ?? '-',
        count: 0,
      };
      bucket.count += 1;
      byStatus.set(name, bucket);

      switch (row.executiveStatusGroup) {
        case 'pending_review':
          exec.pendingReviewCount += 1;
          break;
        case 'awaiting_approval':
          exec.awaitingApprovalCount += 1;
          break;
        case 'approved':
          exec.approvedCount += 1;
          break;
        case 'rejected':
          exec.rejectedCount += 1;
          break;
        default:
          // Defensive — the executive-list path tags every surviving row.
          break;
      }
    }

    const items = [...byStatus.entries()]
      .map(([status, v]) => ({ status, statusTh: v.statusTh, count: v.count }))
      .sort((a, b) => b.count - a.count);

    return {
      totalCount: rows.length,
      items,
      executiveStatusBreakdown: exec,
    };
  }

  async categoryBreakdown(
    opts: { planId?: string; scope?: EquipmentBookScope } = {},
  ): Promise<EquipmentCategoryBreakdown> {
    const rows = this.applyScope(await this.loadRows(opts.planId), opts.scope);

    const byCategory = new Map<
      string,
      {
        categoryCode: number | null;
        categoryName: string | null;
        itemCount: number;
        totalBudget: number;
      }
    >();

    for (const row of rows) {
      const key = row.equipmentCategory?.id ?? 'uncategorized';
      const bucket = byCategory.get(key) ?? {
        categoryCode: row.equipmentCategory?.code ?? null,
        categoryName: row.equipmentCategory?.name ?? null,
        itemCount: 0,
        totalBudget: 0,
      };
      bucket.itemCount += 1;
      bucket.totalBudget += this.rowTotalBudget(row);
      byCategory.set(key, bucket);
    }

    const items = [...byCategory.values()].sort(
      (a, b) => b.itemCount - a.itemCount,
    );

    return { totalCount: rows.length, items };
  }

  /**
   * BE-AGG-01 — per-child-book equipment counts (COUNTS ONLY).
   *
   * ONE spine call (`loadRows`) + in-memory grouping by the child book's
   * own id — same "no N+1" guarantee as the sibling methods. PII-free
   * (never touches `createdBy`). Rows are grouped WITHOUT collapsing
   * "แก้ไข" vs "เปลี่ยนแปลง" (D1) — each `revisionId` is its own bucket
   * and carries the raw `revisionTypeName`.
   */
  async countsByChildBook(planId?: string): Promise<EquipmentChildBookCounts> {
    // 2026-07-18 — switched from HEAD-of-lineage grouping to DOCUMENT-level
    // counts. A book-catalog answer must reflect the ผ.03 as PRINTED in each
    // book (a main-book equipment that was later revised still counts in the
    // main book), matching the ผ.02 project catalog and the issued document
    // ("เล่มหลักมี 3 ครุภัณฑ์"). The old HEAD grouping under-counted the main
    // book (a revised item's HEAD moved to its revision book → main lost it).
    // Delegates to `UnifiedEquipmentService.documentCountsByBook` which counts
    // every non-deleted EPG/RELPG/SEPG per book (no REPLACE anti-join).
    if (!planId) {
      return {
        main: { itemCount: 0 },
        byRevision: [],
        bySupplement: [],
        unresolvedCount: 0,
      };
    }

    const doc = await this.unifiedEquipment.documentCountsByBook(planId);

    return {
      main: { itemCount: doc.main },
      byRevision: doc.byRevision.map((r) => ({
        revisionId: r.revisionId,
        revisionNumber: r.revisionNumber,
        // Keep แก้ไข vs เปลี่ยนแปลง distinct (D1) — never collapsed.
        revisionTypeName: r.revisionTypeName,
        itemCount: r.itemCount,
      })),
      bySupplement: doc.bySupplement.map((s) => ({
        supplementId: s.supplementId,
        supplementNumber: s.supplementNumber,
        itemCount: s.itemCount,
      })),
      // Document counts join child-book rows directly to their parent-book
      // FK, so a missing FK is impossible (INNER JOIN) → no unresolved drift.
      unresolvedCount: 0,
    };
  }

  /**
   * Wave AI-EXEC-CHAT-EQUIPMENT-HEAD-ROSTER — per-plan HEAD roster of every
   * equipment lineage (the ผ.03 analog of `listProjectHeadRoster`). Derived
   * from `executiveList` (HEAD-of-lineage rows, in-flight stripped, deduped)
   * plus per-row ORIGIN classification. `originScope` filters by the
   * lineage's origin book; omit → all equipment in the plan.
   */
  async headRoster(
    planId: string,
    originScope?: 'main' | 'revised' | 'supplement',
  ): Promise<EquipmentHeadRosterRow[]> {
    const rows = await this.unifiedEquipment.executiveList({
      developmentPlanId: planId,
    });
    const out: EquipmentHeadRosterRow[] = [];
    for (const row of rows) {
      let originBookType: 'main' | 'revised' | 'supplement';
      if (row.kind === 'equipment') {
        originBookType = 'main';
      } else if (row.kind === 'supplement-equipment') {
        originBookType = 'supplement';
      } else {
        // revised-equipment — walk the lineage backward to find its origin.
        originBookType = await this.unifiedEquipment.resolveEquipmentOriginBookType(
          row.id,
        );
      }
      if (originScope && originScope !== originBookType) continue;
      out.push({
        equipmentName: row.equipmentName,
        categoryName: row.equipmentCategory?.name ?? null,
        originBookType,
        // Wave BOOK-LABEL-DOUBLING-FIX — self-contained label (always exactly
        // one "เล่ม" prefix) so rule #61/#62 render templates emit verbatim.
        headBookLabel: bookDisplayLabel(this.rosterHeadBookLabel(row)),
        headBookType: this.rosterHeadBookType(row),
        headRevisionNumber: row.developmentPlanRevision?.revisionNumber ?? null,
        headPageNumber: row.pageNumber,
        headStatusTh: row.status?.thName ?? null,
      });
    }
    return out;
  }

  /**
   * Head book label consistent with the PROJECT roster — uses the DPR/DPS
   * `description` verbatim via `resolveRevisionRoundLabel` (e.g. "แก้ไข
   * ครั้งที่ 1/2569"), NOT the equipment-specific `bookLabel()` phrasing.
   */
  private rosterHeadBookLabel(row: UnifiedEquipmentRow): string {
    if (row.kind === 'equipment') return REVISION_ROUND_LABEL_MAIN;
    if (row.kind === 'revised-equipment') {
      const dpr = row.developmentPlanRevision;
      const typeRaw = (dpr?.revisionTypeName ?? '').toLowerCase();
      const isChange =
        typeRaw === 'change' ||
        (dpr?.revisionTypeName ?? '').includes('เปลี่ยนแปลง');
      return resolveRevisionRoundLabel({
        type: isChange ? 'change' : 'edit',
        number: dpr?.revisionNumber ?? null,
        description: dpr?.description ?? null,
      });
    }
    const dps = row.developmentPlanSupplement;
    return resolveRevisionRoundLabel({
      type: 'supplement',
      number: dps?.supplementNumber ?? null,
      description: dps?.description ?? null,
    });
  }

  private rosterHeadBookType(
    row: UnifiedEquipmentRow,
  ): 'main' | 'edit' | 'change' | 'supplement' {
    if (row.kind === 'equipment') return 'main';
    if (row.kind === 'supplement-equipment') return 'supplement';
    return this.revisedEquipmentBookKind(row);
  }

  /**
   * BUG3 (แก้ไข≠เปลี่ยนแปลง) — classify a `revised-equipment` row's OWN book
   * as `edit` (แก้ไข) or `change` (เปลี่ยนแปลง) from its DPR `revisionTypeName`.
   * Shared by `budgetSummary().byBook` and `rosterHeadBookType`.
   */
  private revisedEquipmentBookKind(row: UnifiedEquipmentRow): 'edit' | 'change' {
    const dpr = row.developmentPlanRevision;
    const typeRaw = (dpr?.revisionTypeName ?? '').toLowerCase();
    return typeRaw === 'change' ||
      (dpr?.revisionTypeName ?? '').includes('เปลี่ยนแปลง')
      ? 'change'
      : 'edit';
  }

  async listInRevisionBook(
    revisionId: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<EquipmentRevisionBookResult> {
    const rows = (await this.loadRows(undefined)).filter(
      (r) =>
        r.kind === 'revised-equipment' &&
        r.developmentPlanRevision?.id === revisionId,
    );
    const meta = rows[0]?.developmentPlanRevision;
    return {
      ...this.paginate(rows, opts.limit, opts.offset),
      revisionMeta: {
        revisionId,
        revisionNumber: meta?.revisionNumber ?? 0,
        revisionTypeName: meta?.revisionTypeName ?? '(ไม่ระบุ)',
        isOpen: meta?.isOpen ?? false,
        isBooked: meta?.isBooked ?? false,
      },
    };
  }

  async listInSupplementBook(
    supplementId: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<EquipmentSupplementBookResult> {
    const rows = (await this.loadRows(undefined)).filter(
      (r) =>
        r.kind === 'supplement-equipment' &&
        r.developmentPlanSupplement?.id === supplementId,
    );
    const meta = rows[0]?.developmentPlanSupplement;
    return {
      ...this.paginate(rows, opts.limit, opts.offset),
      supplementMeta: {
        supplementId,
        supplementNumber: meta?.supplementNumber ?? 0,
        isOpen: meta?.isOpen ?? false,
        isBooked: meta?.isBooked ?? false,
      },
    };
  }

  // ────────────────────────────────────────────────────────────────
  //  Internals
  // ────────────────────────────────────────────────────────────────

  /** ONE spine call — see class doc "no N+1" guarantee. */
  private loadRows(planId: string | undefined): Promise<UnifiedEquipmentRow[]> {
    return this.unifiedEquipment.executiveList({
      developmentPlanId: planId,
    });
  }

  /**
   * Wave AI-EXEC-CHAT-DOCUMENT-EQUIPMENT-LISTING — document-level rows (no
   * §14.2 HEAD REPLACE) for the per-book LISTING path so
   * "เล่มหลักมีครุภัณฑ์อะไรบ้าง" enumerates every EPG/RELPG/SEPG as printed
   * in the ผ.03 book (main includes items later revised) — consistent with
   * `documentCountsByBook` and the ผ.02 project catalog. Analytical methods
   * (budget / status / category / search) intentionally keep `loadRows`
   * (HEAD executive view).
   */
  private loadDocumentRows(
    planId: string | undefined,
  ): Promise<UnifiedEquipmentRow[]> {
    return this.unifiedEquipment.documentList({
      developmentPlanId: planId,
    });
  }

  private applyScope(
    rows: UnifiedEquipmentRow[],
    scope: EquipmentBookScope | undefined,
  ): UnifiedEquipmentRow[] {
    if (!scope || scope === 'all') return rows;
    const kind = SCOPE_TO_KIND[scope];
    return rows.filter((r) => r.kind === kind);
  }

  private paginate(
    rows: UnifiedEquipmentRow[],
    limitRaw: number | undefined,
    offsetRaw: number | undefined,
    // Wave WHOLE-PLAN-EQUIPMENT-LISTING-HEAD-CONSISTENCY — when true (the
    // HEAD/whole-plan path) each item's `bookLabel` is rendered in the roster
    // style ("เล่มแก้ไข ครั้งที่ 1/2569") for continuity with the head roster.
    useRosterLabel = false,
  ): EquipmentPagedResult {
    const limit = clampInt(limitRaw, 50, 1, 200);
    const offset = Math.max(Math.trunc(Number(offsetRaw ?? 0)) || 0, 0);
    const page = rows.slice(offset, offset + limit);
    const nextOffset = offset + page.length < rows.length ? offset + limit : null;
    return {
      items: page.map((r) => this.toItem(r, useRosterLabel)),
      totalCount: rows.length,
      limit,
      offset,
      nextOffset,
    };
  }

  private rowTotalBudget(row: UnifiedEquipmentRow): number {
    return row.budgets.reduce((sum, b) => sum + (b.quantity || 0), 0);
  }

  private bookLabel(row: UnifiedEquipmentRow): string {
    if (row.kind === 'equipment') return 'เล่มหลัก';
    if (row.kind === 'revised-equipment') {
      const dpr = row.developmentPlanRevision;
      const typeName = dpr?.revisionTypeName ?? 'แก้ไข';
      const round =
        dpr?.revisionNumber != null ? ` ครั้งที่ ${dpr.revisionNumber}` : '';
      return `เล่ม${typeName}ครุภัณฑ์${round}`;
    }
    const dps = row.developmentPlanSupplement;
    const round =
      dps?.supplementNumber != null ? ` ครั้งที่ ${dps.supplementNumber}` : '';
    return `เล่มเพิ่มเติมครุภัณฑ์${round}`;
  }

  /**
   * PII-free projection — MUST NOT reference `row.createdBy` /
   * `row.createdByWorkHistoryId` (task §9; §17.3 discipline).
   */
  private toItem(
    row: UnifiedEquipmentRow,
    // Wave WHOLE-PLAN-EQUIPMENT-LISTING-HEAD-CONSISTENCY — HEAD/whole-plan
    // listing uses the roster-style label (DPR/DPS description verbatim, exactly
    // one "เล่ม" prefix); per-book document listing keeps the equipment-specific
    // `bookLabel()` phrasing ("เล่มแก้ไขครุภัณฑ์ ครั้งที่ 1").
    useRosterLabel = false,
  ): EquipmentToolItem {
    return {
      equipmentId: row.id,
      equipmentKind: row.kind,
      bookLabel: useRosterLabel
        ? bookDisplayLabel(this.rosterHeadBookLabel(row))
        : this.bookLabel(row),
      name: row.equipmentName,
      categoryCode: row.equipmentCategory?.code ?? null,
      categoryName: row.equipmentCategory?.name ?? null,
      planId: row.developmentPlan.id || null,
      planName: row.developmentPlan.name || null,
      currentStatus: row.status.name || null,
      statusTh: row.status.thName || null,
      executiveStatus: row.executiveStatusGroup ?? null,
      responsibleAgencyName: row.responsibleAgency?.name ?? null,
      totalBudget: this.rowTotalBudget(row),
      isBooked: row.isBooked,
      pageNumber: row.pageNumber,
      createdAt: row.createdAt,
    };
  }
}

function clampInt(
  raw: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Math.trunc(Number(raw ?? fallback));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
