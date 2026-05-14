// ===================================================================
// Supplement PDF DTOs — SUPP_PRINT_BE_03
// ===================================================================
//
// Request bodies for the 11 supplement-PDF endpoints registered on
// `PdfController`. The DTOs are kept intentionally narrow:
//
//   - `createdById` is NEVER accepted from the request body. The
//     controller derives it from `req.user.userId` per task §9.
//   - `selectedColumns` is OPTIONAL and is validated against an
//     allowlist (`SUPPLEMENT_PDF_ALLOWED_COLUMNS`) defined at the
//     controller level. The DTO only enforces the array shape.
//   - All ids are UUID v4 strings.
//
// CLAUDE.md compliance:
//   - §17 PII — DTOs carry NO person-level PII. `createdById` is a
//     UserId scalar resolved server-side, so it never appears in
//     request payloads or logs.
//   - §1 / §4.1 scope — DTOs do NOT carry classification fields.
//     Agency-classification gating is performed by the controller
//     via `SupplementScopeService` for `user`-role callers.
// ===================================================================

import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

/**
 * Body for `POST /v1/pdf/supplement-draft/development-plan-supplement/generate`.
 *
 * Both ids are required so the service can defend against cross-plan
 * mismatches (the supplement is loaded and its parent plan id is
 * compared with the supplied `developmentPlanId`).
 */
export class GenerateSupplementDraftDto {
  @IsNotEmpty()
  @IsUUID()
  developmentPlanId!: string;

  @IsNotEmpty()
  @IsUUID()
  developmentPlanSupplementId!: string;

  /**
   * Optional column allowlist override. When omitted the service uses
   * its default column set. The controller validates each entry
   * against `SUPPLEMENT_PDF_ALLOWED_COLUMNS` before forwarding.
   */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(64)
  @IsString({ each: true })
  selectedColumns?: string[];
}

// SUPP_STANDALONE_CLEANUP_BE_01 (Wave 5, 2026-05-14) — the legacy
// `GenerateSupplementApprovedDto` was removed in this wave alongside
// the legacy `POST /v1/pdf/supplement-approved/development-plan-supplement/generate`
// endpoint. The §18.2.1 SUPPLEMENT finalize trigger surface now lives
// in `SupplementAssemblyController` under `/v1/supplement-assembly/...`,
// which owns its own DTOs.

/**
 * Body for `POST /v1/pdf/generate-supplement-custom`.
 *
 * Mirrors the existing `generate-revision-custom` endpoint
 * (`{ ids, selectedColumns }`). The controller validates
 * `selectedColumns` against `SUPPLEMENT_PDF_ALLOWED_COLUMNS` and
 * rejects requests carrying disallowed column names.
 *
 * `ids` are SPG (`SupplementProjectGroup.id`) UUIDs.
 */
export class GenerateSupplementCustomDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  ids!: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(64)
  @IsString({ each: true })
  selectedColumns?: string[];
}
