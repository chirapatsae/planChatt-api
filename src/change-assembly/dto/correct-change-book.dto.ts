// ===================================================================
// CorrectChangeBookDto — Wave A3 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// Request payload for `POST /v1/change-assembly/:developmentPlanRevisionId/
// versions/:versionId/correct`.
//
// Q3=B (OPTION-A-FULL-SPLIT) — standalone change-assembly boundary. This
// DTO is a duplicate of `edit-assembly/dto/correct-edit-book.dto.ts`;
// the change-assembly module MUST NOT import from `src/book-assembly/*`,
// `src/main-assembly/*`, `src/edit-assembly/*`, or
// `src/supplement-assembly/*`. Any future shape change in a sibling DTO
// MUST be propagated here in the same PR.
//
// CorrectionMode notes:
//   - `correction_part1` / `correction_part2` — surgical correction.
//     The opposite two parts are auto-REUSED; RPGs UNAFFECTED.
//   - `correction_part3` — FULL RESET. Every RPG in the deprecated
//     version's snapshot has its `isBooked` / `bookedAt` /
//     `pageNumber` cleared. The revision flips `isBooked = false` /
//     `bookedAt = null` (+ `isOpen = true` to re-open the round so
//     staff can rework) so the §15 chain releases. Part 3 stays
//     PENDING in the new draft (admin regenerates from the live
//     approval set on the revision).
//   - `cancellation` is intentionally absent from `correct` — CHANGE
//     cancel uses the dedicated `cancelPublishedVersion` endpoint
//     (per the supplement / edit / book-assembly precedent for non-MAIN
//     source types). Unlike MAIN (§20.4), CHANGE_REVISION ALLOWS
//     `cancelPublishedVersion`.
//
// CLAUDE.md compliance:
//   - §15 — correction is a write path on a `DevelopmentPlanRevision`
//     row and MUST go through `BookLockService.assertEditable(...,
//     'development_plan_revision', ...)` in the service layer; this DTO
//     carries no `force` / `override` flag.
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

import { ChangeAssemblyCorrectionMode } from '../enums/change-assembly.enums';

export class CorrectChangeBookDto {
  /**
   * Which correction mode to apply:
   *   - `correction_part1` — replace Part 1 only (no RPG / revision reset).
   *   - `correction_part2` — replace Part 2 only (no RPG / revision reset).
   *   - `correction_part3` — regenerate Part 3 (full reset: RPG booking
   *     cleared, revision unbooked + re-opened).
   */
  @IsEnum(ChangeAssemblyCorrectionMode, {
    message:
      'correctionMode must be one of: correction_part1, correction_part2, correction_part3',
  })
  correctionMode: ChangeAssemblyCorrectionMode;

  /**
   * Explicit confirmation flag. Mirrors the legacy deprecation auth
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
   * `change_assembly_versions.deprecation_reason` on the version being
   * retired AND to `change_assembly_drafts.correction_reason` on the
   * new draft. Minimum length 10 to discourage drive-by entries.
   */
  @IsNotEmpty()
  @IsString()
  @MinLength(10, { message: 'reason must be at least 10 characters' })
  reason: string;
}
