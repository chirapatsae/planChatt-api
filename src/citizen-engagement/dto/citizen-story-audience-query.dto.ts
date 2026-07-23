import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Query of `GET citizen-engagement/stories/:id/audience` (FB-6, owner-only).
 *
 * Offset pagination, newest-viewer-first. `limit` defaults to 30 (a reasonable
 * page for the "who viewed my story" sheet); `offset` defaults to 0.
 */
export class CitizenStoryAudienceQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
