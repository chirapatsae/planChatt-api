// ===================================================================
// CancelEditBookDto — Wave A2 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// Request payload for `POST /v1/edit-assembly/:developmentPlanRevisionId/
// versions/:versionId/cancel`.
//
// Unlike `CancelMainBookDto` (which feeds an endpoint that ALWAYS
// rejects with `403 MAIN_BOOK_CANNOT_ROLLBACK` per §20.4), the EDIT
// equivalent is fully functional. CLAUDE.md §20.4 lists ONE exempt cell
// only: `MAIN_PLAN.cancel`. `EDIT_REVISION.cancel` is LIVE per the
// parity table in CLAUDE.md §20.2 and is implemented in
// `EditAssemblyService.cancelPublishedVersion`.
//
// Q3=B — standalone edit-assembly boundary; this DTO is a duplicate of
// `main-assembly/dto/cancel-main-book.dto.ts`. The edit-assembly module
// MUST NOT import from `src/book-assembly/*`, `src/main-assembly/*`, or
// `src/supplement-assembly/*`.
// ===================================================================

import {
  IsBoolean,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CancelEditBookDto {
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
