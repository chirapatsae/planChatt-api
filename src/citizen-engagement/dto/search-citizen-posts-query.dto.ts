import { Type } from 'class-transformer';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Query of `GET /v1/citizen-engagement/search` (W-S5 discovery).
 *
 * Search reads the EXISTING `citizen_post` table only (§17.3 isolation — no new
 * table / FK). It combines an OPTIONAL Thai-substring TEXT filter (`q`) with an
 * OPTIONAL GEO filter (`lat` + `lng` + `radiusKm`, all-or-none), AND-combined.
 * At least one of `q` or the geo triple is required (else 400
 * `CITIZEN_SEARCH_EMPTY`) — the service enforces both rules.
 *
 * Pagination reuses the W-F2 ranked keyset cursor (rankScore, id) DESC, exactly
 * like the feed `list()`, so the FE consumes the same `ListCitizenPostsResponseDto`.
 */
export class SearchCitizenPostsQueryDto {
  /** Free-text query (trimmed in the service); Thai substring ILIKE over title/detail. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  /** Optional kind filter (idea|discussion|poll). */
  @IsOptional()
  @IsIn(['idea', 'discussion', 'poll'])
  kind?: 'idea' | 'discussion' | 'poll';

  /** Geo triple — all-or-none (validated in the service). */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  @Max(500)
  radiusKm?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number;

  /** W-F2 keyset cursor — echoes the previous page's `nextCursor`. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  beforeRankScore?: number;

  @IsOptional()
  @IsUUID()
  beforeId?: string;
}
