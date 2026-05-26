// ===================================================================
// CancelSupplementBookDto — wave-supplement-convergence-milestone-1-
// parity-contract / BE-01
// ===================================================================
//
// Request payload for `POST /v1/supplement-assembly/:supplementId/
// versions/:versionId/cancel`.
//
// Mirrors `BookAssemblyService.cancel()`'s `CancelBookDto` shape so the
// FE shared deprecation modal behaves identically across surfaces.
//
// Q3=B (standalone-supplement boundary, PLAN.md): this DTO is a
// duplicate of `book-assembly/dto/cancel-book.dto.ts`; the supplement
// module MUST NOT import from `src/book-assembly/*`. Any future shape
// change in the main-plan DTO MUST be propagated here in the same PR.
//
// CLAUDE.md compliance:
//   - §15 — the host endpoint is a write path on
//     `DevelopmentPlanSupplement` and MUST go through
//     `BookLockService.assertEditable(...)`; this DTO carries no
//     `force` / `override` flag.
//   - §17.2 — no AI side-effects.
//   - §18 — cancel of a PUBLISHED VERSION is NOT a §18.2.1 cascade
//     trigger (only the supplement book row's `softRemove` and
//     finalize `merge()` are — neither happens here; we only
//     deprecate the version + clear `supplement.isBooked` /
//     `bookedAt`).
// ===================================================================

import {
  IsBoolean,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CancelSupplementBookDto {
  /**
   * Explicit confirmation flag — operator must send `true` to proceed.
   * Mirrors the main-plan deprecation auth (Spec Section 11.3 step 2).
   */
  @IsBoolean()
  confirmed: boolean;

  /**
   * Last 6 digits of the operator's national ID card number. Validated
   * server-side against `User.citizenId.slice(-6)`. Raw value is NEVER
   * stored — only the last 2 digits appear in the in-memory log line
   * as `****XX`. Mirrors the main-plan deprecation auth (Spec Section
   * 11.3 step 3).
   */
  @IsNotEmpty()
  @IsString()
  @Matches(/^[0-9]{6}$/, {
    message: 'citizenIdSuffix must be exactly 6 digits',
  })
  citizenIdSuffix: string;

  /**
   * Human-readable reason for cancellation. Persisted verbatim to
   * `supplement_assembly_versions.deprecation_reason`. Length-floored
   * to discourage drive-by entries (mirrors the main-plan precedent
   * in `CorrectBookDto` / `CorrectSupplementBookDto`).
   */
  @IsNotEmpty()
  @IsString()
  @MinLength(10, { message: 'reason must be at least 10 characters' })
  @MaxLength(500, { message: 'reason must not exceed 500 characters' })
  reason: string;
}
