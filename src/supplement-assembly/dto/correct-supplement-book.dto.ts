// ===================================================================
// CorrectSupplementBookDto — wave-supplement-correction-workflow BE-01
// ===================================================================
//
// Request payload for `POST /v1/supplement-assembly/:supplementId/correct`.
//
// Q3=B (PLAN.md) — standalone-supplement boundary. This DTO is a
// duplicate of `book-assembly/dto/correct-book.dto.ts`; the supplement
// module MUST NOT import from `src/book-assembly/*`. Any future shape
// change in the main-plan DTO MUST be propagated here in the same PR.
//
// CorrectionMode notes:
//   - `correction_part1` / `correction_part2` — surgical correction.
//     The opposite two parts are auto-REUSED; SPGs UNAFFECTED.
//   - `correction_part3` — full reset (Q1=a, 2026-05-25). The
//     supplement is rolled back to its pre-finalize state: SPGs have
//     `pageNumber` cleared and the `DevelopmentPlanSupplement` row has
//     `isBooked = false`, `bookedAt = null`. Part 3 stays PENDING in
//     the new draft (must be regenerated from the live approval set).
//
// CLAUDE.md compliance:
//   - §15 — correction is a write path on a `DevelopmentPlanSupplement`
//     row and MUST go through `BookLockService.assertEditable(...)` in
//     the service layer; this DTO carries no `force` / `override` flag.
//   - §17.2 — no AI side-effects.
//   - §18 — correction is NOT a cancel/finalize cascade trigger.
// ===================================================================

import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';

import { SupplementAssemblyCorrectionMode } from '../enums/supplement-assembly.enums';

export class CorrectSupplementBookDto {
  /**
   * Which correction mode to apply:
   *   - `correction_part1` — replace Part 1 only (no SPG / supplement reset).
   *   - `correction_part2` — replace Part 2 only (no SPG / supplement reset).
   *   - `correction_part3` — regenerate Part 3 (Q1=a full reset:
   *     `SupplementProjectGroup.pageNumber` cleared on every SPG in the
   *     deprecated `part3ProjectSnapshot`; `DevelopmentPlanSupplement.
   *     isBooked` flipped to false and `bookedAt` cleared so the §15
   *     linear-chain predicate releases older siblings).
   *
   * `cancellation` is intentionally absent — supplement cancel uses the
   * existing `POST /:supplementId/cancel` endpoint.
   */
  @IsEnum(SupplementAssemblyCorrectionMode, {
    message:
      'correctionMode must be one of: correction_part1, correction_part2, correction_part3',
  })
  correctionMode: SupplementAssemblyCorrectionMode;

  /**
   * Explicit confirmation flag. Mirrors the main-plan deprecation auth
   * (Spec Section 11.3 step 2). Must be `true` — false rejects with 400.
   */
  @IsBoolean()
  confirmed: boolean;

  /**
   * Last 6 digits of the operator's national ID card number. Validated
   * server-side against `User.citizenId.slice(-6)`. Mirrors the main-
   * plan deprecation auth (Spec Section 11.3 step 3) byte-for-byte so
   * the FE shared input control behaves identically across surfaces.
   */
  @IsNotEmpty()
  @IsString()
  @Matches(/^[0-9]{6}$/, {
    message: 'citizenIdSuffix must be exactly 6 digits',
  })
  citizenIdSuffix: string;

  /**
   * Human-readable reason for correction. Persisted verbatim to
   * `supplement_assembly_versions.deprecation_reason` on the version
   * being retired AND to `supplement_assembly_drafts.correction_reason`
   * on the new draft. Minimum length 10 to discourage drive-by entries.
   */
  @IsNotEmpty()
  @IsString()
  @MinLength(10, {
    message: 'reason must be at least 10 characters',
  })
  reason: string;
}
