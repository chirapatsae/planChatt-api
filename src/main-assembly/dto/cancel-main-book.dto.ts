// ===================================================================
// CancelMainBookDto — Wave A1 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// Request payload for `POST /v1/main-assembly/:developmentPlanId/
// versions/:versionId/cancel`.
//
// ⚠ The endpoint that consumes this DTO ALWAYS rejects with
// `403 MAIN_BOOK_CANNOT_ROLLBACK` per §20.4 — main-plan published
// versions cannot be cancelled. The DTO exists for API surface
// consistency with the supplement equivalent (which DOES allow cancel)
// and to keep the request schema future-proofed; the service uses the
// payload only for log-line attribution before throwing.
//
// Q3=B — standalone main-assembly boundary; this DTO is a duplicate of
// `book-assembly/dto/cancel-book.dto.ts`. The main-assembly module
// MUST NOT import from `src/book-assembly/*`.
// ===================================================================

import {
  IsBoolean,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CancelMainBookDto {
  @IsBoolean()
  confirmed: boolean;

  @IsNotEmpty()
  @IsString()
  @Matches(/^[0-9]{6}$/, {
    message: 'citizenIdSuffix must be exactly 6 digits',
  })
  citizenIdSuffix: string;

  @IsNotEmpty()
  @IsString()
  @MinLength(10, { message: 'reason must be at least 10 characters' })
  @MaxLength(500, { message: 'reason must not exceed 500 characters' })
  reason: string;
}
