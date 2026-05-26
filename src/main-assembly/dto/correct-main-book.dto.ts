// ===================================================================
// CorrectMainBookDto — Wave A1 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// Request payload for `POST /v1/main-assembly/:developmentPlanId/
// versions/:versionId/correct`.
//
// Q3=B (OPTION-A-FULL-SPLIT) — standalone main-assembly boundary. This
// DTO is a duplicate of `book-assembly/dto/correct-book.dto.ts`; the
// main-assembly module MUST NOT import from `src/book-assembly/*`. Any
// future shape change in the main-plan DTO MUST be propagated here in
// the same PR.
//
// CorrectionMode notes:
//   - `correction_part1` / `correction_part2` — surgical correction.
//     The opposite two parts are auto-REUSED; PGs UNAFFECTED.
//   - `correction_part3` — FULL RESET. Every PG in the deprecated
//     version's snapshot has its `isBooked` / `bookedAt` /
//     `pageNumber` cleared. The plan flips `isBooked = false` /
//     `bookedAt = null` so the §15 chain releases. Every `PlanPhase`
//     row under the plan flips `isMerged = false`. Part 3 stays
//     PENDING in the new draft (admin regenerates from the live
//     approval set).
//   - `cancellation` is intentionally absent — main-plan cancel is
//     PERMANENTLY FORBIDDEN per §20.4. The dedicated
//     `cancelPublishedVersion` endpoint rejects every call with
//     `403 MAIN_BOOK_CANNOT_ROLLBACK`.
//
// CLAUDE.md compliance:
//   - §15 — correction is a write path on a `DevelopmentPlan` row and
//     MUST go through `BookLockService.assertEditable(...)` in the
//     service layer; this DTO carries no `force` / `override` flag.
//   - §17.2 — no AI side-effects.
//   - §18 — correction is NOT a §18 cancel/finalize cascade trigger.
// ===================================================================

import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';

import { MainAssemblyCorrectionMode } from '../enums/main-assembly.enums';

export class CorrectMainBookDto {
  /**
   * Which correction mode to apply:
   *   - `correction_part1` — replace Part 1 only (no PG / plan reset).
   *   - `correction_part2` — replace Part 2 only (no PG / plan reset).
   *   - `correction_part3` — regenerate Part 3 (full reset: PG booking
   *     cleared, plan unbooked, PlanPhase `isMerged` flipped back).
   */
  @IsEnum(MainAssemblyCorrectionMode, {
    message:
      'correctionMode must be one of: correction_part1, correction_part2, correction_part3',
  })
  correctionMode: MainAssemblyCorrectionMode;

  /**
   * Explicit confirmation flag. Mirrors the main-plan deprecation auth
   * (Spec Section 11.3 step 2). Must be `true` — false rejects with 400.
   */
  @IsBoolean()
  confirmed: boolean;

  /**
   * Last 6 digits of the operator's national ID card number. Validated
   * server-side against the decrypted `User.citizenId` suffix. Raw
   * value is NEVER stored; only the last 2 digits appear in the
   * in-memory log line as `****XX`.
   */
  @IsNotEmpty()
  @IsString()
  @Matches(/^[0-9]{6}$/, {
    message: 'citizenIdSuffix must be exactly 6 digits',
  })
  citizenIdSuffix: string;

  /**
   * Human-readable reason for correction. Persisted verbatim to
   * `main_assembly_versions.deprecation_reason` on the version being
   * retired AND to `main_assembly_drafts.correction_reason` on the
   * new draft. Minimum length 10 to discourage drive-by entries.
   */
  @IsNotEmpty()
  @IsString()
  @MinLength(10, { message: 'reason must be at least 10 characters' })
  reason: string;
}
