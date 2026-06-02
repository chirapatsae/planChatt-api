/**
 * Wave Unified Equipment Tab — BE-01.
 *
 * `UnifiedEquipmentRow` is the logical row projected across the two
 * equipment-owning tables (`EquipmentProjectGroup` = EPG,
 * `RevisedEquipmentProjectGroup` = RELPG) with `kind` as the
 * discriminator. It is the equipment analog of the project-tab
 * `EnrichedUnifiedProject` shape, scoped to the ผ.03 sub-type.
 *
 * The endpoint that returns this shape (`GET /v1/unified-equipment/
 * owner-list`) applies the §14.2 HEAD-of-lineage anti-join so a revised
 * equipment REPLACES its locked parent EPG — mirroring the project tab's
 * `applyHeadFilterForProjectGroup/RevisedProjectGroup` semantic.
 *
 * CLAUDE.md references:
 *   - §5 / §5.3 — equipment sub-type; agency-only authoring (WRITE gate
 *     only — this READ projection is unrestricted).
 *   - §10 — plan-scope binding resolved per-row via the row's own chain
 *     (EPG → developmentPlan; RELPG → DPR → developmentPlan).
 *   - §11 / §14 — versioning + lineage; `hasDescendant` mirrors the
 *     canonical `LineageLockService` (`'equipment'` / `'revised_equipment'`).
 *   - §16.5 — classification dual shape; `indicator` relaxed (nullable) on
 *     equipment in BOTH shapes.
 *   - §17.2 / §17.3 / §17.11 — advisory, read-only, no role exemption.
 */

/** Discriminator — `equipment` (EPG, เล่มหลัก) | `revised-equipment`
 *  (RELPG, เล่มแก้ไข). Hyphenated to match the `ai_target_kind`
 *  convention used elsewhere for equipment snapshots. */
export type UnifiedEquipmentKind = 'equipment' | 'revised-equipment';

/** §12 structured status block — canonical English + Thai display + ISO. */
export interface UnifiedEquipmentStatus {
  /** Canonical English status name (e.g. 'Approved') — workflow logic. */
  name: string;
  /** `status.th_name` — W67 single source of truth for Thai display. */
  thName: string;
  /** ISO timestamp of the latest `TrackingStatus.createAt`. */
  statusAt: string | null;
}

/** Lightweight classification reference (§16.5 dual shape). */
export interface UnifiedEquipmentClassificationLite {
  id: string;
  name: string | null;
}

/** Equipment-defining category (ผ.03). */
export interface UnifiedEquipmentCategoryLite {
  id: string;
  code: number;
  name: string;
}

/** Parent DevelopmentPlan metadata — common across both kinds. */
export interface UnifiedEquipmentDevelopmentPlan {
  id: string;
  name: string;
  startYear: number | null;
  endYear: number | null;
  isLatest: boolean;
  isBooked: boolean;
  reportFormat: 'STRATEGY_BASED' | 'ISSUE_BASED';
}

/** Parent revision-round metadata — RELPG only (เล่มแก้ไข). */
export interface UnifiedEquipmentDevelopmentPlanRevision {
  id: string;
  revisionNumber: number | null;
  /** e.g. 'แก้ไข' | 'เปลี่ยนแปลง' — from `revision_type.name`. */
  revisionTypeName: string | null;
  description: string | null;
  isLatest: boolean;
  isBooked: boolean;
  isOpen: boolean;
}

/** Per-year budget row. */
export interface UnifiedEquipmentBudget {
  year: number | null;
  quantity: number;
}

/** Creator-side display metadata. PII (email/phone/citizenId) masked. */
export interface UnifiedEquipmentCreator {
  workHistoryId: string;
  firstName: string | null;
  lastName: string | null;
}

/**
 * Full unified equipment row returned by
 * `GET /v1/unified-equipment/owner-list`.
 *
 * Per-kind population:
 *   kind                | developmentPlanRevision
 *   --------------------|-------------------------
 *   'equipment'         | undefined
 *   'revised-equipment' | populated (เล่มแก้ไข metadata)
 */
export interface UnifiedEquipmentRow {
  /** Discriminator. */
  kind: UnifiedEquipmentKind;

  /** Physical row id (EPG.id | RELPG.id). */
  id: string;

  /** Item name projected from the owning entity (`equipment_name`). */
  equipmentName: string;

  /** เป้าหมาย / ผลผลิต. */
  targetOutput: string | null;

  /** ผลที่คาดว่าจะได้รับ. */
  expectedResults: string | null;

  /** KPI — nullable on equipment in BOTH shapes (§16.5 relaxation). */
  indicator: string | null;

  /** Equipment-defining category (ผ.03). */
  equipmentCategory: UnifiedEquipmentCategoryLite | null;

  // ---- Classification — exactly ONE shape per row per §16.5 ----
  strategy: UnifiedEquipmentClassificationLite | null;
  tactic: UnifiedEquipmentClassificationLite | null;
  /** STRATEGY_BASED `Plan` classification entity. */
  plan: UnifiedEquipmentClassificationLite | null;
  developmentIssue: UnifiedEquipmentClassificationLite | null;

  // ---- Scope / format binding (§10, §16) ----
  developmentPlan: UnifiedEquipmentDevelopmentPlan;
  /** RELPG only — undefined for EPG (เล่มหลัก). */
  developmentPlanRevision?: UnifiedEquipmentDevelopmentPlanRevision;

  // ---- §12 status + §14 lineage ----
  status: UnifiedEquipmentStatus;
  /**
   * §14.10 lineage lock. `true` ⇒ this row has a live descendant in its
   * own category. Under REPLACE semantics a locked EPG is dropped, so
   * this is primarily `true` on a RELPG-of-RELPG chain head. Drives the
   * FE "เวอร์ชันเก่า (ถูกล็อก)" treatment / disabled edit-delete.
   */
  hasDescendant: boolean;

  // ---- Booked-state (§20.3 Invariant 1) ----
  isBooked: boolean;
  bookedAt: string | null;
  pageNumber: number | null;

  // ---- Budgets + ownership + origin ----
  budgets: UnifiedEquipmentBudget[];
  createdBy: UnifiedEquipmentCreator | null;
  /** §4 ownership scalar (WorkHistory.id) — for FE row-ownership gating. */
  createdByWorkHistoryId: string | null;
  responsibleAgency: { id: string; name: string | null } | null;

  /** Row's own `createdAt` ISO — used for timeline sort (newest first). */
  createdAt: string;
}
