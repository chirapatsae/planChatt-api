/**
 * Public response shapes for the citizen FOLLOW surface (C3 / W-GATE-1).
 *
 * D16: these shapes expose the caller's OWN follow targets (amphoes /
 * categories / people) ONLY — never a follower-of-me roster / inbound social
 * graph. Person follows added in W-GATE-1 (§10 APPROVED).
 */

/** Result of `POST /v1/citizen-engagement/follows/toggle`. */
export interface ToggleFollowResponseDto {
  following: boolean;
}

/**
 * The caller's live follow targets, split by kind.
 * `amphoes` = amphoe codes (short string ids like "3001", NOT uuids);
 * `categories` = category strings; `people` = followed
 * citizens' identity ids (W-GATE-1). The `me/follows` endpoint exposes the
 * area/topic split; `people` drives the followed-feed person UNION + the FE
 * follow-button marking (the caller's OWN following list — D16-safe).
 */
export interface FollowSetsDto {
  amphoes: string[];
  categories: string[];
  people: string[];
}
