import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/**
 * Query of `GET /v1/citizen-engagement/posts` (keyset pagination).
 *
 * W-F2: the feed is ranked, so the keyset cursor is (rankScore, id) DESC — not
 * (createdAt, id). The cursor pair (`beforeRankScore` + `beforeId`) echoes back
 * the previous page's `nextCursor`.
 */
export class ListCitizenPostsQueryDto {
  @IsOptional()
  @IsIn(['idea', 'discussion'])
  kind?: 'idea' | 'discussion';

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsUUID()
  amphoeId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  beforeRankScore?: number;

  @IsOptional()
  @IsUUID()
  beforeId?: string;
}
