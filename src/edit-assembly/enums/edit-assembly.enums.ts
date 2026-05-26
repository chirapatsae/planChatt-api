/**
 * Wave A2 / DB-01 — Edit Assembly enums.
 *
 * Q3=B (OPTION-A-FULL-SPLIT) — duplicate enums (separate Postgres types
 * from BookAssembly / MainAssembly / SupplementAssembly). The standalone
 * EDIT subsystem MUST NOT import from `src/book-assembly/`,
 * `src/main-assembly/`, or `src/supplement-assembly/`. Any future
 * BookAssembly enum change MUST be propagated here in the same PR.
 *
 * Postgres enum type names (declared by the matching migration
 * `1781800000000-CreateEditAssemblyTables.ts`):
 *   - edit_assembly_part_upload_status
 *   - edit_assembly_draft_status
 *   - edit_assembly_version_status
 *   - edit_assembly_correction_mode
 *   - edit_assembly_part_source
 *
 * Shape parity:
 *   - PartUploadStatus / PartSource / AssemblyDraftStatus / VersionStatus
 *     / CorrectionMode mirror `BookAssembly*` and `MainAssembly*` enums
 *     byte-for-byte (BE-01 shares semantics with the original
 *     `BookAssemblyService` branches that handled
 *     `sourceType === EDIT_REVISION`).
 *   - `source_type` discriminator is intentionally dropped — table
 *     membership is the type discriminator for the edit subsystem.
 *
 * Key behavioral difference vs MAIN (§20.4):
 *   - EDIT_REVISION ALLOWS `cancelPublishedVersion`. The
 *     `CANCELLATION` correction mode IS reachable on this subsystem
 *     (via the dedicated `cancelPublishedVersion` endpoint). The enum
 *     value is preserved here for shape parity even though `correct`
 *     itself still rejects `cancellation` per the supplement / main
 *     precedent (cancel uses its own endpoint).
 */

export enum EditAssemblyPartUploadStatus {
  PENDING = 'pending',
  UPLOADED = 'uploaded',
  GENERATED = 'generated',
  REUSED = 'reused',
}

export enum EditAssemblyDraftStatus {
  PREPARING = 'preparing',
  READY = 'ready',
  MERGED = 'merged',
  CANCELED = 'canceled',
}

export enum EditAssemblyVersionStatus {
  COMPLETED = 'completed',
  DEPRECATED = 'deprecated',
}

export enum EditAssemblyCorrectionMode {
  CANCELLATION = 'cancellation',
  CORRECTION_PART1 = 'correction_part1',
  CORRECTION_PART2 = 'correction_part2',
  CORRECTION_PART3 = 'correction_part3',
}

export enum EditAssemblyPartSource {
  UPLOADED = 'uploaded',
  GENERATED = 'generated',
  REUSED = 'reused',
}
