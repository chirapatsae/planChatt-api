/**
 * Wave A3 / DB-01 — Change Assembly enums.
 *
 * Q3=B (OPTION-A-FULL-SPLIT) — duplicate enums (separate Postgres types
 * from BookAssembly / MainAssembly / EditAssembly / SupplementAssembly).
 * The standalone CHANGE subsystem MUST NOT import from
 * `src/book-assembly/`, `src/main-assembly/`, `src/edit-assembly/`, or
 * `src/supplement-assembly/`. Any future BookAssembly enum change MUST
 * be propagated here in the same PR.
 *
 * Postgres enum type names (declared by the matching migration
 * `1781900000000-CreateChangeAssemblyTables.ts`):
 *   - change_assembly_part_upload_status
 *   - change_assembly_draft_status
 *   - change_assembly_version_status
 *   - change_assembly_correction_mode
 *   - change_assembly_part_source
 *
 * Shape parity:
 *   - PartUploadStatus / PartSource / AssemblyDraftStatus / VersionStatus
 *     / CorrectionMode mirror `BookAssembly*` / `MainAssembly*` /
 *     `EditAssembly*` enums byte-for-byte (BE-01 shares semantics with
 *     the original `BookAssemblyService` branches that handled
 *     `sourceType === CHANGE_REVISION`).
 *   - `source_type` discriminator is intentionally dropped — table
 *     membership is the type discriminator for the change subsystem.
 *
 * Key behavioral difference vs MAIN (§20.4):
 *   - CHANGE_REVISION ALLOWS `cancelPublishedVersion`. The
 *     `CANCELLATION` correction mode IS reachable on this subsystem
 *     (via the dedicated `cancelPublishedVersion` endpoint). The enum
 *     value is preserved here for shape parity even though `correct`
 *     itself still rejects `cancellation` per the supplement / main /
 *     edit precedent (cancel uses its own endpoint).
 */

export enum ChangeAssemblyPartUploadStatus {
  PENDING = 'pending',
  UPLOADED = 'uploaded',
  GENERATED = 'generated',
  REUSED = 'reused',
}

export enum ChangeAssemblyDraftStatus {
  PREPARING = 'preparing',
  READY = 'ready',
  MERGED = 'merged',
  CANCELED = 'canceled',
}

export enum ChangeAssemblyVersionStatus {
  COMPLETED = 'completed',
  DEPRECATED = 'deprecated',
}

export enum ChangeAssemblyCorrectionMode {
  CANCELLATION = 'cancellation',
  CORRECTION_PART1 = 'correction_part1',
  CORRECTION_PART2 = 'correction_part2',
  CORRECTION_PART3 = 'correction_part3',
}

export enum ChangeAssemblyPartSource {
  UPLOADED = 'uploaded',
  GENERATED = 'generated',
  REUSED = 'reused',
}
