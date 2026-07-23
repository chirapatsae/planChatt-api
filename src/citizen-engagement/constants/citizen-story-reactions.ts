/**
 * citizen-story-reactions — the SINGLE source of truth for the EPHEMERAL STORY
 * emoji reaction set (FB-6). SEPARATE from the FROZEN 4-key civic POST reaction
 * set (`citizen-reactions.ts`) — a story reaction is a lightweight one-tap emoji
 * on a 24h story, not a ranked engagement signal on a board post. The FE mirrors
 * this file.
 *
 * §17.2 advisory: a story reaction is a pure engagement signal — it gates no
 * workflow transition and writes nothing to `tracking_status` / `ai_*`. §17.3
 * isolation: `emoji` is a SCALAR key on `citizen_story_reactions` (one row per
 * `(story_id, identity_id)`), never a new FK.
 *
 * The stored value is the KEY (`love` | `haha` | …), NOT the rendered glyph, so
 * the glyph can be re-skinned client-side without a data migration. This
 * app-level allow-list is the PRIMARY validation (400 on an unknown key); the DB
 * CHECK on the same six keys is defense-in-depth.
 */

/** The 6 closed-set story reaction keys, in display order (FB-6). */
export const STORY_REACTION_KEYS = [
  'love',
  'haha',
  'wow',
  'sad',
  'angry',
  'like',
] as const;

export type StoryReactionKey = (typeof STORY_REACTION_KEYS)[number];

/** Glyph per story reaction key (the FE mirrors these). */
export const STORY_REACTION_LABELS: Record<StoryReactionKey, { emoji: string }> = {
  love: { emoji: '❤️' },
  haha: { emoji: '😆' },
  wow: { emoji: '😮' },
  sad: { emoji: '😢' },
  angry: { emoji: '😡' },
  like: { emoji: '👍' },
};

/** A zeroed `{ love, haha, wow, sad, angry, like }` breakdown (every key present). */
export function emptyStoryReactionBreakdown(): Record<StoryReactionKey, number> {
  return { love: 0, haha: 0, wow: 0, sad: 0, angry: 0, like: 0 };
}

/** Narrowing guard — `true` iff `value` is one of the 6 story reaction keys. */
export function isStoryReactionKey(value: unknown): value is StoryReactionKey {
  return (
    typeof value === 'string' &&
    (STORY_REACTION_KEYS as readonly string[]).includes(value)
  );
}
