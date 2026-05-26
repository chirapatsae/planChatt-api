/**
 * SUPP_STANDALONE_DB_01 — Supplement Assembly enums.
 *
 * Q3=B (PLAN.md) — duplicate enums (separate Postgres types from
 * BookAssembly). Any future BookAssembly enum change MUST be propagated
 * here in the same PR. Do NOT import from `src/book-assembly/enums`.
 *
 * Wave-supplement-correction-workflow / DB-01 (2026-05-25):
 *   - `SupplementAssemblyVersionStatus.DEPRECATED` added (Q4=C Wave A
 *     deferral resolved). Pg enum updated via the matching migration's
 *     `ALTER TYPE ... ADD VALUE IF NOT EXISTS` block.
 *   - `SupplementAssemblyCorrectionMode` added (mirror of main-plan
 *     `CorrectionMode`, intentionally excludes `cancellation` — supplement
 *     cancel uses the existing `/cancel` endpoint, per DB-01 task §3
 *     correction scope).
 *
 * Postgres enum type names (declared by the matching migrations):
 *   - supplement_assembly_part_upload_status
 *   - supplement_assembly_draft_status
 *   - supplement_assembly_version_status
 *   - supplement_assembly_part_source
 *   - supplement_assembly_correction_mode  (NEW — Wave B DB-01)
 */

export enum SupplementAssemblyPartUploadStatus {
  PENDING = 'pending',
  UPLOADED = 'uploaded',
  GENERATED = 'generated',
  REUSED = 'reused',
}

export enum SupplementAssemblyDraftStatus {
  PREPARING = 'preparing',
  READY = 'ready',
  MERGED = 'merged',
  CANCELED = 'canceled',
}

/**
 * Wave-supplement-correction-workflow DB-01 — `DEPRECATED` added. The
 * matching migration uses `ALTER TYPE ... ADD VALUE IF NOT EXISTS` so the
 * pg enum carries both `completed` and `deprecated`. Older code paths
 * that only branch on `COMPLETED` continue to work — adding an enum
 * variant is non-breaking.
 */
export enum SupplementAssemblyVersionStatus {
  COMPLETED = 'completed',
  DEPRECATED = 'deprecated',
}

export enum SupplementAssemblyPartSource {
  UPLOADED = 'uploaded',
  GENERATED = 'generated',
  REUSED = 'reused',
}

/**
 * Wave-supplement-correction-workflow DB-01 — supplement correction
 * mode. Mirrors `book-assembly` `CorrectionMode` (Q3=B duplicate) but
 * with a dedicated pg type `supplement_assembly_correction_mode`. The
 * `CANCELLATION` variant is intentionally absent — supplement cancel is
 * handled by the existing `/cancel` endpoint that lives outside the
 * correction workflow.
 */
export enum SupplementAssemblyCorrectionMode {
  CORRECTION_PART1 = 'correction_part1',
  CORRECTION_PART2 = 'correction_part2',
  CORRECTION_PART3 = 'correction_part3',
}
