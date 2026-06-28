import { Type } from 'class-transformer';
import { IsISO8601, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/**
 * Chronological keyset query for the citizen-engagement read paths that are NOT
 * ranked — today the notification inbox (`GET
 * /v1/citizen-engagement/me/notifications`).
 *
 * W-F2 split: the POST FEED moved to a (rankScore, id) cursor
 * (`ListCitizenPostsQueryDto`). This DTO preserves the original (createdAt, id)
 * cursor for the chronological reads that the wave deliberately leaves
 * time-ordered (notifications, and the profile/map reads which already carry
 * their own params).
 */
export class ListCitizenChronoQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsISO8601()
  beforeCreatedAt?: string;

  @IsOptional()
  @IsUUID()
  beforeId?: string;
}
