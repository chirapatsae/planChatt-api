/**
 * citizen-reactions — the SINGLE source of truth for the civic reaction set
 * (W-S1, Phase 3). FROZEN at 4 keys; the FE mirrors this file.
 *
 * §17.2 advisory: a reaction is a pure engagement signal. It gates no workflow
 * transition and writes nothing to `tracking_status` / `ai_*`. §17.3 isolation:
 * `reaction_type` is a SCALAR on `citizen_post_reaction` — no new FK, no new
 * table. The reaction set only colours the engagement count; ranking still uses
 * the TOTAL live reaction count (any type), so feed ordering is unchanged in
 * spirit.
 *
 * Back-compat: pre-W-S1 heart rows become `reaction_type = 'like'` (the column
 * default + migration backfill); the FE heart icon maps to `like`.
 */

/** The 4 FROZEN reaction keys, in display order. */
export const CITIZEN_REACTION_TYPES = [
  'like',
  'love',
  'support',
  'insightful',
] as const;

export type CitizenReactionType = (typeof CITIZEN_REACTION_TYPES)[number];

/** Default reaction when the caller does not specify one. */
export const DEFAULT_CITIZEN_REACTION: CitizenReactionType = 'like';

/** Thai label + emoji per reaction key (the FE mirrors these). */
export const CITIZEN_REACTION_LABELS: Record<
  CitizenReactionType,
  { emoji: string; labelTh: string }
> = {
  like: { emoji: '👍', labelTh: 'เห็นด้วย' },
  love: { emoji: '❤️', labelTh: 'ชอบ' },
  support: { emoji: '💪', labelTh: 'เป็นกำลังใจ' },
  insightful: { emoji: '💡', labelTh: 'น่าสนใจ' },
};

/** A zeroed `{ like, love, support, insightful }` breakdown (every key present). */
export function emptyReactionBreakdown(): Record<CitizenReactionType, number> {
  return { like: 0, love: 0, support: 0, insightful: 0 };
}

/** Narrowing guard — `true` iff `value` is one of the 4 FROZEN keys. */
export function isCitizenReactionType(
  value: unknown,
): value is CitizenReactionType {
  return (
    typeof value === 'string' &&
    (CITIZEN_REACTION_TYPES as readonly string[]).includes(value)
  );
}
