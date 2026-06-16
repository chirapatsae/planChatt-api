/**
 * Wave wave-ai-knowledge-structure-mgmt — BE-02 (2026-06-13).
 *
 * Server-side allow-lists for the Class-A display tokens an admin may
 * attach to a knowledge-domain / coverage-gap overlay row
 * (`color_token` / `icon_key` on `ai_knowledge_domain_meta`).
 *
 * Why an allow-list (task §3 — `400 KNOWLEDGE_TOKEN_INVALID`):
 *   - The mind-map node renderer (`frontend/.../knowledgeMap/nodes.tsx`)
 *     resolves these tokens to concrete Tailwind / lucide symbols. An
 *     unknown token would silently render no colour / no icon, so the BE
 *     rejects it loudly at write time instead — UI display tokens are a
 *     CLOSED set, not free text.
 *   - These are advisory DISPLAY tokens (§17.2) — they gate nothing. The
 *     allow-list is an integrity / data-hygiene guard, not a permission
 *     (§17.11): no role, super-admin included, may persist a token
 *     outside this set.
 *
 * COLOUR tokens mirror the restrained `docs/design-system.md` §4 palette
 * (violet = primary/brand, emerald = success, amber = warning, sky =
 * info, red = destructive) plus the neutral + a few adjacent hues the FE
 * node renderer already understands (indigo / teal / rose / slate). They
 * are stored as the bare Tailwind hue NAME (e.g. `violet`) — the FE maps
 * the name to the paired `bg-…/text-…` + `dark:` token set, never the
 * reverse, so the design-system dark-pair rule (§4) stays FE-owned.
 *
 * ICON keys are a curated subset of lucide-react (a FE dependency,
 * `lucide-react@^0.484`) chosen to cover the seven derived domains + the
 * curated / gap nodes. Stored as the lucide kebab-case key (e.g.
 * `banknote`); the FE resolves the key to the React component.
 *
 * Both lists are exported `as const` (readonly tuple) so they can drive
 * both the runtime guard here AND a `class-validator` `@IsIn` on the DTO
 * with no drift.
 */

/** Allowed `color_token` values — bare Tailwind hue names (design-system §4). */
export const KNOWLEDGE_COLOR_TOKENS = [
  'violet',
  'indigo',
  'sky',
  'emerald',
  'teal',
  'amber',
  'rose',
  'red',
  'slate',
  'gray',
] as const;

export type KnowledgeColorToken = (typeof KNOWLEDGE_COLOR_TOKENS)[number];

/** Allowed `icon_key` values — curated lucide-react kebab-case keys. */
export const KNOWLEDGE_ICON_KEYS = [
  'book-open',
  'folder',
  'workflow',
  'banknote',
  'building-2',
  'map-pin',
  'target',
  'layers',
  'database',
  'sparkles',
  'lightbulb',
  'file-text',
  'help-circle',
  'package',
  'shield',
  'network',
] as const;

export type KnowledgeIconKey = (typeof KNOWLEDGE_ICON_KEYS)[number];

/** O(1) membership check for the runtime BE guard (case-sensitive). */
export function isAllowedColorToken(token: string): token is KnowledgeColorToken {
  return (KNOWLEDGE_COLOR_TOKENS as readonly string[]).includes(token);
}

export function isAllowedIconKey(key: string): key is KnowledgeIconKey {
  return (KNOWLEDGE_ICON_KEYS as readonly string[]).includes(key);
}
