import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

/**
 * Wave Supplement Equipment ผ.03 Standalone Print — BE-01 (2026-06-09).
 *
 * DTO for `POST /v1/pdf/generate-supplement-por03` — the SEPG (supplement
 * equipment, ครุภัณฑ์ ผ.03 under DevelopmentPlanSupplement) sibling of the
 * EPG `POST /v1/pdf/generate-por03`. Body shape `{ supplementEquipmentIds:
 * string[] }`.
 *
 * Validation order (clone of `generate-por03.dto.ts`):
 *   1. `IsArray` — body MUST carry a `supplementEquipmentIds` array.
 *   2. `ArrayNotEmpty` — empty array → `400 EQUIPMENT_PRINT_INVALID_BODY`.
 *   3. `ArrayMaxSize(500)` — sanity cap to prevent runaway transaction-lock
 *      contention on a malformed client call.
 *   4. `IsUUID('all', { each: true })` — each id is a UUID. Non-UUID shapes
 *      never reach the repository, eliminating an injection vector against
 *      the `IN (...)` clause.
 *
 * Per-row owner check, agency-only re-assertion, STRATEGY_BASED shape check,
 * and mixed-supplement reject are enforced inside
 * `Por03PdfService.generateSupplementPor03`, not at DTO time, because they
 * require the loaded SEPG rows.
 */
export class GenerateSupplementPor03Dto {
  @IsArray({ message: 'EQUIPMENT_PRINT_INVALID_BODY' })
  @ArrayNotEmpty({ message: 'EQUIPMENT_PRINT_INVALID_BODY' })
  @ArrayMaxSize(500, { message: 'EQUIPMENT_IDS_TOO_MANY' })
  @IsUUID('all', { each: true, message: 'EQUIPMENT_PRINT_INVALID_BODY' })
  supplementEquipmentIds: string[];
}
