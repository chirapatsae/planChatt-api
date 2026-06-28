import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

/**
 * Query of `GET /v1/citizen-engagement/me/bookmarks` (keyset pagination).
 *
 * W-S3: the saved list is ordered newest-bookmark first, so the keyset cursor
 * is the BOOKMARK's (createdAt, id) DESC — NOT the post's rankScore (the feed's
 * `ListCitizenPostsQueryDto` cursor). The cursor pair (`beforeCreatedAt` +
 * `beforeId`) echoes back the previous page's `nextCursor`.
 */
export class ListCitizenBookmarksQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  beforeCreatedAt?: string;

  @IsOptional()
  @IsUUID()
  beforeId?: string;
}
