import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body of `PATCH /v1/citizen-engagement/me/profile`.
 *
 * `displayAlias` is the ONLY editable, PII-safe field on a citizen identity
 * (§17.3 — the `*_enc` / `*_hash` columns are never accepted or returned).
 * The value is trimmed BEFORE validation so a whitespace-only alias is
 * rejected by `@MinLength(1)`.
 */
export class UpdateCitizenProfileDto {
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1)
  @MaxLength(64)
  displayAlias: string;
}
