import { Transform } from 'class-transformer';
import { IsIn, IsISO8601, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Wave 22 B1 — Shared query DTOs for the super-admin email-stats endpoints.
 *
 * Wave 22 QA C-1 fix — align with the frontend contract in
 * `frontend/src/api/adminEmailStats.ts`:
 *   - Range endpoints accept ISO 8601 `from` / `to` (NOT `days`).
 *   - `by-day` additionally accepts `bucket` ∈ { 'day', 'hour' } (default 'day').
 *   - `top-senders` / `top-recipients` / `failures` also accept `limit`.
 *
 * `forbidNonWhitelisted: true` is globally enabled in `main.ts`, so every
 * accepted query param MUST be declared here. Any undeclared param triggers
 * a 400 response. Defaults for absent `from` / `to` are applied at the
 * service layer (server-side `now() - 30 days` … `now()`).
 *
 * Advisory-only (§4.1, §17.2) — these queries never gate any workflow
 * transition.
 */

/** Base shape: every range-based stats endpoint accepts `from` / `to`. */
export class EmailStatsRangeQueryDto {
  @IsOptional()
  @IsISO8601({}, { message: 'from ต้องเป็นรูปแบบ ISO 8601' })
  from?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'to ต้องเป็นรูปแบบ ISO 8601' })
  to?: string;
}

/** Overview accepts range only. */
export class EmailStatsOverviewQueryDto extends EmailStatsRangeQueryDto {}

/** by-day additionally accepts `bucket` ∈ { 'day', 'hour' }. */
export class EmailStatsByDayQueryDto extends EmailStatsRangeQueryDto {
  @IsOptional()
  @IsIn(['day', 'hour'], { message: "bucket ต้องเป็น 'day' หรือ 'hour'" })
  bucket?: 'day' | 'hour';
}

/** top-senders / top-recipients / failures accept `from` / `to` + `limit`. */
export class EmailStatsLimitRangeQueryDto extends EmailStatsRangeQueryDto {
  @IsOptional()
  @Transform(({ value }) => (value !== undefined && value !== null ? Number(value) : value))
  @IsInt({ message: 'limit ต้องเป็นจำนวนเต็ม' })
  @Min(1, { message: 'limit ต้องมากกว่าหรือเท่ากับ 1' })
  @Max(200, { message: 'limit ต้องไม่เกิน 200' })
  limit?: number;
}
