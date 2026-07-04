import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body of `PATCH /v1/citizen-engagement/me/profile`.
 *
 * `displayAlias` + `bio` are the ONLY editable, PII-safe fields on a citizen
 * identity (§17.3 — the `*_enc` / `*_hash` columns are never accepted or
 * returned). Values are trimmed BEFORE validation so a whitespace-only alias is
 * rejected by `@MinLength(1)`, and a whitespace-only bio normalises to empty
 * (the service stores it as `null`).
 */
export class UpdateCitizenProfileDto {
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1)
  @MaxLength(64)
  displayAlias: string;

  /**
   * Optional public bio (2026-07-03). Absent = leave unchanged; empty string =
   * clear it. Max 300 chars after trim.
   */
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(300)
  bio?: string;
}
