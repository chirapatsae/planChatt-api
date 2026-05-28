import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

/**
 * Wave Print ผ.03 — BE-01 (2026-05-28).
 *
 * DTO for `POST /v1/pdf/generate-por03` (Q4 locked: sibling endpoint —
 * `{ equipmentIds: string[] }`).
 *
 * Validation order:
 *   1. `IsArray` — body MUST carry an `equipmentIds` array.
 *   2. `ArrayNotEmpty` — empty array → `400 EQUIPMENT_PRINT_INVALID_BODY`
 *      (mapped at controller via global validation pipe message).
 *   3. `ArrayMaxSize(500)` — sanity cap per README §13 to prevent
 *      runaway transaction-lock contention on a malformed client call.
 *   4. `IsUUID('all', { each: true })` — each id is a UUID. Non-UUID
 *      shapes never reach the repository, eliminating an injection
 *      vector against the `IN (...)` clause.
 *
 * Per-row owner check, agency-only re-assertion, and Q2 STRATEGY_BASED
 * shape check are enforced inside `Por03PdfService.generate`, not at DTO
 * time, because they require the loaded equipment rows.
 */
export class GeneratePor03Dto {
  @IsArray({ message: 'EQUIPMENT_PRINT_INVALID_BODY' })
  @ArrayNotEmpty({ message: 'EQUIPMENT_PRINT_INVALID_BODY' })
  @ArrayMaxSize(500, { message: 'EQUIPMENT_IDS_TOO_MANY' })
  @IsUUID('all', { each: true, message: 'EQUIPMENT_PRINT_INVALID_BODY' })
  equipmentIds: string[];
}
