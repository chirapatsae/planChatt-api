// ===================================================================
// MainAssemblyDraftDto — Wave A1 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// Response shape for active / canceled draft reads. Mirrors
// `SupplementAssemblyDraftDto` and `BookAssemblyDraft` precedents but
// uses main-assembly enum types per Q3=B isolation.
// ===================================================================

import {
  MainAssemblyDraftStatus,
  MainAssemblyPartUploadStatus,
} from '../enums/main-assembly.enums';

export interface MainAssemblyDraftDto {
  id: string;
  developmentPlanId: string;
  assemblyStatus: MainAssemblyDraftStatus;

  part1Status: MainAssemblyPartUploadStatus;
  part1OriginalFileName: string | null;
  part1UploadedAt: string | null;

  part2Status: MainAssemblyPartUploadStatus;
  part2OriginalFileName: string | null;
  part2UploadedAt: string | null;

  part3Status: MainAssemblyPartUploadStatus;
  part3GeneratedAt: string | null;

  /**
   * 2026-05-31 — Snapshot of Approved PG UUIDs captured at the moment
   * Part 3 was generated/reused. The FE compares
   * `.length` against the live `readiness.approvedCount` to detect
   * Part 3 staleness (e.g. an admin rolled back an Approved project
   * after Part 3 was already prepared). `null` when Part 3 has not
   * yet been generated. Mirror of the same column on the version DTO.
   */
  part3ProjectSnapshot: string[] | null;

  /**
   * 2026-05-31 (Part 3 SET-staleness, draft-side) — Snapshot of
   * Approved equipment (ผ.03) UUIDs captured at the moment Part 3 was
   * generated. Mirrors the version-side `part3EquipmentSnapshot`.
   * `null` when Part 3 has not yet been generated, OR when the row
   * predates the equipment-snapshot column. The enrich path treats
   * `null` as the empty set (no drift expected for legacy rows).
   */
  part3EquipmentSnapshot: string[] | null;

  // §21.4 (draft-side) — Part 3 staleness signal (advisory; §17.2).
  // Computed READ-SIDE only inside `enrichDraftWithStaleness`; never
  // persisted. The FE uses these to (a) decide whether to show the
  // "สร้างใหม่" affordance and (b) block "รวมเล่ม" until the operator
  // regenerates. All four count fields are non-negative integers;
  // `isPart3Stale` is the boolean OR over the four counts.
  //
  // Skipped (all zero + isStale=false) when Part 3 has not yet been
  // generated/reused for the active draft (status NOT IN {generated,
  // reused}). See `enrichDraftWithStaleness` for the predicate.

  /** Boolean OR over the 4 count fields below. True iff Part 3 is stale. */
  isPart3Stale: boolean;
  /** Currently-Approved PGs under the same plan NOT in `part3ProjectSnapshot`. */
  part3StalePgCount: number;
  /** Snapshot PGs that are no longer Approved (rolled back / deleted / demoted). */
  part3RemovedPgCount: number;
  /** Currently-Approved equipment under the same plan NOT in `part3EquipmentSnapshot`. */
  part3StaleEquipmentCount: number;
  /** Snapshot equipment no longer Approved. */
  part3RemovedEquipmentCount: number;

  createdById: string;
  createdAt: string;

  /**
   * Nested creator projection — populated when the read path eager-
   * loads `['createdBy', 'createdBy.user']`. Mirrors the supplement
   * precedent.
   */
  createdBy?: {
    id: string;
    user?: {
      prefix?: string;
      firstName?: string;
      lastName?: string;
    };
  };
}
