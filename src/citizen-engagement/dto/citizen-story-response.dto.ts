/**
 * Response shapes for the EPHEMERAL story surface (W-GATE-3).
 *
 * PII guard (§17.3): the author block carries ONLY `id` + `displayAlias` from
 * the identity row — never `nationalIdHash` / `thaidSubHash` / `*_enc`. The
 * service builds these objects by hand (alias-only select), so the encrypted
 * identity columns can never leak.
 */

import { StoryReactionKey } from '../constants/citizen-story-reactions';

/**
 * A single active story as served to the public active feed.
 *
 * FB-6 personalization: `viewedByMe` / `myReaction` are added ONLY for a
 * LOGGED-IN caller (CitizenOptionalJwtGuard); `viewCount` is added ONLY on the
 * caller's OWN stories (view counts are owner-private, FB semantics). For an
 * ANONYMOUS caller NONE of the three fields are set, so the JSON is
 * byte-identical to the pre-FB-6 shape (backward compat).
 */
export interface StoryDto {
  id: string;
  imageUrl: string;
  caption: string | null;
  createdAt: string;
  expiresAt: string;
  /** FB-6 — present ONLY for a logged-in caller: has the caller viewed this story. */
  viewedByMe?: boolean;
  /** FB-6 — present ONLY for a logged-in caller: the caller's reaction key, or null. */
  myReaction?: StoryReactionKey | null;
  /** FB-6 — present ONLY on the caller's OWN stories: total distinct viewers (owner-private). */
  viewCount?: number;
}

/** The minimal, alias-only author block (no PII). */
export interface StoryAuthorDto {
  id: string;
  displayAlias: string;
}

/** One author's bundle of currently-active stories. */
export interface StoryGroupDto {
  author: StoryAuthorDto;
  stories: StoryDto[];
}

/** One viewer row in the owner-only "who viewed my story" audience list (FB-6). */
export interface StoryAudienceItemDto {
  /** Opaque citizen identity uuid (handle for profile link) — never PII. */
  viewerId: string;
  displayAlias: string;
  avatarUrl: string | null;
  viewedAt: string;
  /** The viewer's story reaction key, or null if they viewed without reacting. */
  reaction: StoryReactionKey | null;
}

/** The owner-only audience page for one story (FB-6). */
export interface StoryAudienceDto {
  items: StoryAudienceItemDto[];
  total: number;
  reactionBreakdown: Record<StoryReactionKey, number>;
}
