/**
 * citizen-feed-ranking — the SINGLE source of truth for the civic feed's
 * advisory rank score (W-F2, Phase 2 foundation).
 *
 * §17.2 ADVISORY: this score only SORTS the feed. It gates no workflow, writes
 * no `tracking_status` / `ai_*`, and changes no moderation/visibility decision.
 * The formula is fully transparent (NO opaque ML) — a deterministic, Reddit-
 * "hot"-style blend of engagement (log-damped) and recency.
 *
 * rankScore = log10(1 + heartCount + 2*commentCount)
 *           + (createdAtSec - BASE_EPOCH_SEC) / RECENCY_DECAY
 *
 * - `1 +` (NOT `max(1, …)`): with `max(1, …)` both 0 and 1 engagement map to
 *   log10(1)=0, so the FIRST heart/comment would count for nothing. `1 + x`
 *   makes every unit of engagement raise the score monotonically from zero
 *   (0 → 0, 1 heart → log10(2)≈0.301) while staying log-damped.
 * - Comments weigh 2× hearts (higher-effort engagement).
 * - Recency is taken from `createdAt`, NOT `last_activity_at`, so a late
 *   comment cannot necro-bump an old post up the feed.
 * - Official-response boost is DEFERRED to W-G2 (not added here).
 */

/** 2026-01-01T00:00:00Z in epoch seconds — keeps the recency term small. */
export const BASE_EPOCH_SEC = 1735689600;

/** ~12.5h ≈ 1.0 score point (Reddit recency constant). */
export const RECENCY_DECAY = 45000;

export interface RankScoreInput {
  heartCount: number;
  commentCount: number;
  createdAt: Date;
}

/**
 * Compute the advisory feed rank score for a post. Pure + deterministic — no
 * I/O, no clock read (recency is derived from the passed `createdAt`).
 */
export function computeRankScore({
  heartCount,
  commentCount,
  createdAt,
}: RankScoreInput): number {
  const engagement = Math.log10(1 + heartCount + 2 * commentCount);
  const createdAtSec = createdAt.getTime() / 1000;
  const recency = (createdAtSec - BASE_EPOCH_SEC) / RECENCY_DECAY;
  return engagement + recency;
}
