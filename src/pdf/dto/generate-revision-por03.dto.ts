import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

/**
 * Wave Revision/Change Equipment ผ.03 Print (OLD vs NEW) — BE-01
 * (2026-06-03).
 *
 * DTO for `POST /v1/pdf/generate-revision-por03`. Mirrors
 * `GeneratePor03Dto` shape, but the body key is
 * `revisedEquipmentProjectGroupIds` — the selection is a set of RELPG
 * (`RevisedEquipmentProjectGroup`) ids, NOT EPG ids. FE-01 sends this
 * key verbatim.
 *
 * Validation order:
 *   1. `IsArray` — body MUST carry a `revisedEquipmentProjectGroupIds`
 *      array.
 *   2. `ArrayNotEmpty` — empty array → `400 EQUIPMENT_PRINT_INVALID_BODY`
 *      (mapped at the global validation pipe via the message).
 *   3. `ArrayMaxSize(500)` — sanity cap mirroring the Phase 2.5 print
 *      cap (BE-01 §3.1) to prevent runaway transaction-lock contention
 *      on a malformed client call.
 *   4. `IsUUID('all', { each: true })` — each id is a UUID. Non-UUID
 *      shapes never reach the repository, eliminating an injection
 *      vector against the `IN (...)` clause.
 *
 * Per-row owner check, agency-only re-assertion, STRATEGY_BASED shape
 * check, single-plan check, and plan-window check are enforced inside
 * `Por03PdfService.generateRevisionPor03`, not at DTO time, because they
 * require the loaded RELPG rows.
 */
export class GenerateRevisionPor03Dto {
  @IsArray({ message: 'EQUIPMENT_PRINT_INVALID_BODY' })
  @ArrayNotEmpty({ message: 'EQUIPMENT_PRINT_INVALID_BODY' })
  @ArrayMaxSize(500, { message: 'EQUIPMENT_IDS_TOO_MANY' })
  @IsUUID('all', { each: true, message: 'EQUIPMENT_PRINT_INVALID_BODY' })
  revisedEquipmentProjectGroupIds: string[];
}
