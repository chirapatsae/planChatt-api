/**
 * Per-route rate limits for the citizen-engagement (civic-community) module.
 *
 * W-SEC-2 — single source of truth for the anti-abuse throttles on the
 * citizen write/auth surfaces. This app has NO global APP_GUARD ThrottlerGuard,
 * so enforcement is OPT-IN per the users.module.ts / line.module.ts pattern:
 *   1. `ThrottlerModule.forRoot([{ name: 'default', ttl, limit: 100 }])` in
 *      citizen-engagement.module.ts (module-scoped fallback bucket), AND
 *   2. `ThrottlerGuard` listed in each throttled route's `@UseGuards(...)`, AND
 *   3. `@Throttle({ default: { limit, ttl: CITIZEN_THROTTLE_TTL_MS } })` for the
 *      tighter per-route cap below.
 * All three are required — `@Throttle` alone is inert without (1) + (2). Staff/
 * admin surfaces (moderation queue/moderate, grants, official-response) carry
 * no `@Throttle`/`ThrottlerGuard` and stay unthrottled — they are not
 * anonymous-abuse surfaces.
 *
 * §17.2 advisory: throttling is an anti-abuse guard only; it writes nothing to
 * tracking_status / ai_* and gates no workflow transition.
 */

/** Shared 60-second window for every citizen per-route throttle. */
export const CITIZEN_THROTTLE_TTL_MS = 60_000;

export const CITIZEN_RATE_LIMITS = {
  /** Anti-brute-force on the ThaID id_token exchange (public, unauthenticated). */
  THAID_LOGIN: 10,
  /** Post creation is a heavier write — keep it low to blunt spam floods. */
  CREATE_POST: 15,
  /** Comments are more frequent than posts but still throttled against spam. */
  CREATE_COMMENT: 30,
  /** Hearts/reactions are the most frequent legit action — highest ceiling. */
  TOGGLE_REACTION: 60,
  /** Reports must be possible but bounded to prevent mass false-flagging. */
  REPORT_POST: 20,
  /** W-S2 reposts/quotes — a write that fans into the feed; bound against share spam. */
  REPOST: 20,
  /** Media upload is the most resource-intensive write — tightest non-login cap. */
  UPLOAD_MEDIA: 12,
  /** Follow toggles are frequent (browsing) but capped against churn abuse. */
  TOGGLE_FOLLOW: 40,
  /** Bookmark toggles are frequent (browsing the feed) but capped against churn abuse. */
  TOGGLE_BOOKMARK: 40,
  /** W-S7 poll votes — one tap per poll + change-vote; capped against vote spam. */
  POLL_VOTE: 30,
  /** W-S5 search — PUBLIC + unauthenticated; an ILIKE %q% scan is the most
   *  expensive public read, so cap per-IP against scraping/flood. */
  SEARCH: 30,
  /** W-GATE-3 ephemeral stories — an image write (strip + store), tight cap. */
  CREATE_STORY: 10,
  /** W-T1 block/mute set — a low-frequency moderation action; capped against churn. */
  SET_BLOCK: 20,
  /** W-G1 PDPA data export — a heavy full-account read; very low cap. */
  DSAR_EXPORT: 5,
  /** W-G1 PDPA account erasure — irreversible self-service; tightest cap. */
  DSAR_ERASE: 3,
  /** W-T3 appeal submission — a low-frequency owner action; tight cap against spam. */
  SUBMIT_APPEAL: 5,
  /** Community Chat — 1:1 DM send; frequent like comments, bounded against flood. */
  SEND_MESSAGE: 40,
} as const;
