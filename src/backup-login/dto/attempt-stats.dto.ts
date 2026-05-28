import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Query parameters for `GET /v1/auth/backup-login-attempts/stats`.
 *
 * `days` selects the trailing-window size (1 → 365). Default 30. The
 * window upper bound is `now()`; the lower bound is `now() - days`.
 */
export class AttemptStatsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number;
}
