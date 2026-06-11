/**
 * Staff Home — Aging / Overdue aggregator response DTOs.
 *
 * Wave: wave-staff-review-dashboard, Phase 2 (PHASE2-BE-01).
 * Drill-down enrichment: wave-staff-home-actionable (BE-01, 2026-06-07).
 * Contract: docs/tasks/wave-staff-home-actionable/DOCS-01-RESULT-composition-and-drilldown-contract.md
 * Base contract: docs/tasks/wave-staff-review-dashboard/PHASE2-DOCS-02-RESULT-aging-aggregator-contract.md
 *
 * CLAUDE.md §17.2 (advisory) + §18.13 (read-side aggregator allowance):
 * these are pure read projections. Nothing here gates a workflow transition.
 * Every enrichment field is derived from existing joined columns or a pure
 * in-memory string build — ZERO writes (§18.13).
 */

/** Lane = project sub-type grouping surfaced to the staff dashboard. */
export type StaffOverdueLane =
  | 'mainPlan'
  | 'revision'
  | 'supplement'
  | 'equipment';

/**
 * Fine-grained sub-type discriminator (DOCS-01 §7.2 DECISION-B). Finer than
 * `StaffOverdueLane` — disambiguates edit vs change (both fold into the
 * `revision` lane) and RPG vs RELPG, so the BE can resolve the precise
 * action / detail / history route per item.
 */
export type StaffOverdueBookKind =
  | 'mainPlan' // ProjectGroup (ผ.02 main plan)
  | 'edit' // RevisedProjectGroup, revisionType = แก้ไข
  | 'change' // RevisedProjectGroup, revisionType = เปลี่ยนแปลง
  | 'supplement' // SupplementProjectGroup
  | 'equipment' // EquipmentProjectGroup (ผ.03)
  | 'revised-equipment' // RevisedEquipmentProjectGroup (RELPG ผ.03)
  | 'supplement-equipment'; // SupplementEquipmentProjectGroup (SEPG ผ.03 เล่มเพิ่มเติม)

/** The three non-terminal review stages a staff member is responsible for. */
export type StaffOverdueStage = 'Pending' | 'Verified' | 'Pending_Approval';

/** Fixed bucket keys (see contract "Aging buckets"). */
export type StaffOverdueBucketKey = 'd0_3' | 'd4_7' | 'd8_14' | 'd15p';

export interface StaffOverdueBucketDef {
  key: StaffOverdueBucketKey;
  labelTh: string;
  /** inclusive low bound, in days */
  minDays: number;
  /** inclusive high bound, in days; null = open-ended (overdue bucket) */
  maxDays: number | null;
}

/**
 * A single stuck item, enriched with drill-down context (DOCS-01 §7.2).
 *
 * The leading block is the original Phase-2 shape (verbatim); the trailing
 * block is the BE-01 enrichment. All NEW fields are derivable from joins the
 * aggregator already performs plus one parent-book join per sub-type, or a
 * pure string build — no writes (§18.13).
 */
export interface StaffOverdueItem {
  // ── existing (verbatim) ──
  /** sub-type row id (PG/RPG/SPG/EPG/RELPG.id) */
  projectId: string;
  title: string | null;
  ageDays: number;
  /** ISO — latest TrackingStatus.createAt */
  enteredStatusAt: string;

  // ── NEW (BE-01 enrichment, DOCS-01 §7.2) ──
  /** precise sub-type (disambiguates RPG vs RELPG, edit vs change) */
  bookKind: StaffOverdueBookKind;
  /** human เล่ม label — see DOCS-01 §7.3 */
  bookLabel: string;
  /** 'Pending' | 'Verified' | 'Pending_Approval' (copied from parent stage) */
  stage: StaffOverdueStage;
  /** W67 review-stage Thai label (copied from parent stage) */
  stageLabelTh: string;
  /** status.th_name (W67 source of truth) */
  statusTh: string;
  /** sub-type row .isBooked */
  isBooked: boolean;
  /** sub-type row .pageNumber (null until booked; always null for EPG/RELPG) */
  pageNumber: number | null;
  /** canonical review-page deep-link — DOCS-01 §9 route table */
  actionRoute: string;
  /** read-only detail route — DOCS-01 §8.3 (null where none exists) */
  detailRoute: string | null;
  /** read-only progress/history route — DOCS-01 §8.3 (null where none exists) */
  historyRoute: string | null;
}

/**
 * @deprecated Renamed to `StaffOverdueItem` in BE-01 (wave-staff-home-actionable).
 * Aliased for back-compat with Phase-2 consumers.
 */
export type StaffOverdueOldestItem = StaffOverdueItem;

export interface StaffOverdueStageEntry {
  stage: StaffOverdueStage;
  stageLabelTh: string;
  buckets: Record<StaffOverdueBucketKey, number>;
  total: number;
  /** count in the d15p (overdue) bucket */
  overdue: number;
  /**
   * The single oldest stuck item in this lane×stage (`topItems[0] ?? null`).
   * RETAINED for Phase-2 back-compat (DOCS-01 §7.1 DECISION-A).
   */
  oldest: StaffOverdueItem | null;
  /**
   * Top-N (N=5) stuck items in this lane×stage, sorted by `ageDays` DESC
   * (DOCS-01 §7.1 DECISION-A = Option B). The FE flattens `topItems` across
   * lanes×stages, re-sorts, and slices to the page-level cap (~20).
   */
  topItems: StaffOverdueItem[];
}

export interface StaffOverdueLaneEntry {
  lane: StaffOverdueLane;
  labelTh: string;
  stages: StaffOverdueStageEntry[];
}

export interface StaffOverdueResponseDto {
  /** server time the snapshot was computed (ISO-8601) */
  asOf: string;
  /** lower bound of the overdue (d15p) bucket */
  overdueThresholdDays: number;
  /** bucket dictionary in fixed render order */
  buckets: StaffOverdueBucketDef[];
  /** sum of every d15p count across lanes × stages */
  totalOverdue: number;
  /** sum of every bucket across lanes × stages */
  totalAging: number;
  lanes: StaffOverdueLaneEntry[];
}
