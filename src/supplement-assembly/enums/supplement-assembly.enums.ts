/**
 * SUPP_STANDALONE_DB_01 — Supplement Assembly enums.
 *
 * Q3=B (PLAN.md) — duplicate enums (separate Postgres types from
 * BookAssembly). Any future BookAssembly enum change MUST be propagated
 * here in the same PR. Do NOT import from `src/book-assembly/enums`.
 *
 * Q4=C (PLAN.md) — Wave A scope is Part1/2/3 + finalize + cancel ONLY.
 * The `SupplementAssemblyVersionStatus` enum carries `COMPLETED` only;
 * a future `DEPRECATED` value is intentionally absent until Wave B
 * introduces corrections + deprecation audit.
 *
 * Postgres enum type names (declared by the matching migration):
 *   - supplement_assembly_part_upload_status
 *   - supplement_assembly_draft_status
 *   - supplement_assembly_version_status
 *   - supplement_assembly_part_source
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
 * Wave A only ships `COMPLETED`. Adding `DEPRECATED` is reserved for
 * Wave B (Q4=C deferral); the migration uses CREATE TYPE without a
 * `deprecated` value so the schema does NOT pre-commit to the future
 * shape.
 */
export enum SupplementAssemblyVersionStatus {
  COMPLETED = 'completed',
}

export enum SupplementAssemblyPartSource {
  UPLOADED = 'uploaded',
  GENERATED = 'generated',
  REUSED = 'reused',
}
