import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body of `POST /v1/citizen-engagement/posts/:id/repost` (W-S2).
 *
 * `quoteText` is the OPTIONAL quote-tweet text rendered above the embedded
 * original. Omitted / null → a pure share (the embed only). Stored verbatim on
 * the new repost row's `detail` column.
 */
export class RepostDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  quoteText?: string;
}
