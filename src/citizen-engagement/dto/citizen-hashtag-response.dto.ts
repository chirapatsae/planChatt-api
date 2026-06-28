/**
 * Public response shapes for the citizen-engagement hashtag / trending surface
 * (W-S4). §17.2 ADVISORY — trending is a presentation-only ranking; it gates no
 * workflow. §17.3 — these mappers expose only the normalized tag + a public
 * count, never any PII.
 */

/**
 * One trending hashtag: the normalized `tag` + the number of posts that used it
 * inside the recent trending window. Ordered by `postCount` DESC.
 */
export interface TrendingHashtagDto {
  /** Normalized tag (NFC, no leading `#`, lowercased). */
  tag: string;
  /** Distinct visible posts that used the tag within the trending window. */
  postCount: number;
}

export interface TrendingHashtagsResponseDto {
  items: TrendingHashtagDto[];
  /** The window (hours) the trending counts were computed over. */
  windowHours: number;
}
