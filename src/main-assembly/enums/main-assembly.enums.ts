/**
 * Wave A1 / DB-01 — Main Assembly enums.
 *
 * Q3=B (OPTION-A-FULL-SPLIT) — duplicate enums (separate Postgres types
 * from BookAssembly). The standalone MAIN subsystem MUST NOT import from
 * `src/book-assembly/`. Any future BookAssembly enum change MUST be
 * propagated here in the same PR.
 *
 * Postgres enum type names (declared by the matching migration
 * `1781700000000-CreateMainAssemblyTables.ts`):
 *   - main_assembly_part_upload_status
 *   - main_assembly_draft_status
 *   - main_assembly_version_status
 *   - main_assembly_correction_mode
 *   - main_assembly_part_source
 *
 * Shape parity:
 *   - PartUploadStatus / PartSource / AssemblyDraftStatus / VersionStatus
 *     / CorrectionMode mirror `BookAssembly*` enums byte-for-byte (BE-01
 *     will share semantics with the original `BookAssemblyService`
 *     branches that handled `sourceType === MAIN_PLAN`).
 *   - `source_type` discriminator is intentionally dropped — table
 *     membership is the type discriminator for the main subsystem.
 */

export enum MainAssemblyPartUploadStatus {
  PENDING = 'pending',
  UPLOADED = 'uploaded',
  GENERATED = 'generated',
  REUSED = 'reused',
}

export enum MainAssemblyDraftStatus {
  PREPARING = 'preparing',
  READY = 'ready',
  MERGED = 'merged',
  CANCELED = 'canceled',
}

export enum MainAssemblyVersionStatus {
  COMPLETED = 'completed',
  DEPRECATED = 'deprecated',
}

export enum MainAssemblyCorrectionMode {
  CANCELLATION = 'cancellation',
  CORRECTION_PART1 = 'correction_part1',
  CORRECTION_PART2 = 'correction_part2',
  CORRECTION_PART3 = 'correction_part3',
}

export enum MainAssemblyPartSource {
  UPLOADED = 'uploaded',
  GENERATED = 'generated',
  REUSED = 'reused',
}
