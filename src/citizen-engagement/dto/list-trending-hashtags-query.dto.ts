import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Query of `GET /v1/citizen-engagement/hashtags/trending` (W-S4).
 *
 * Both knobs are OPTIONAL and clamped server-side in `listTrending`:
 *   - `windowHours` — the recent window the grouped COUNT runs over (default 24,
 *     max 14 days).
 *   - `limit`       — how many trending tags to return (default 20, max 50).
 *
 * Trending is §17.2 advisory — a presentation-only ranking; it gates nothing.
 */
export class ListTrendingHashtagsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(336)
  windowHours?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
