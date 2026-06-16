import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

import {
  KNOWLEDGE_COLOR_TOKENS,
  KNOWLEDGE_ICON_KEYS,
} from '../constants/structure-tokens';

/**
 * Wave wave-ai-knowledge-structure-mgmt — BE-02 (2026-06-13).
 *
 * Request bodies for the Class-A domain DISPLAY overlay (topic i — report
 * §2(i)). Admin + super-admin only (Q-03; enforced at the controller via
 * `@Roles(...ADMIN_OR_ABOVE)`).
 *
 * Q-05 enforcement-by-omission: the editable surface is DISPLAY-only —
 * `key`, `layer`, and `toolNames` are DELIBERATELY ABSENT from this DTO,
 * so the structural / functional identity of a code-declared domain
 * cannot be sent over the wire at all (defense-in-depth on top of the
 * service-layer guard). A derived domain may be reordered / hidden /
 * relabelled / recoloured but NEVER added or deleted.
 *
 * Column-width caps mirror `ai_knowledge_domain_meta` (DB-01 §3.2):
 *   - label overrides ≤ 200   (varchar(200))
 *   - description_th  ≤ 4,000  (text — a generous UI cap, belt-and-braces)
 *   - color_token / icon_key validated against the closed allow-list
 *     (`structure-tokens.ts`) → `400 KNOWLEDGE_TOKEN_INVALID` is raised
 *     at the SERVICE layer with a structured code; the `@IsIn` here is the
 *     first-line DTO guard that fails fast on an obviously bad token.
 */
export const KNOWLEDGE_LABEL_OVERRIDE_MAX_LENGTH = 200;
export const KNOWLEDGE_DESCRIPTION_MAX_LENGTH = 4_000;

export class PatchKnowledgeDomainDto {
  /** Override Thai label; omit to leave unchanged, `null` to clear → code label. */
  @IsOptional()
  @IsString()
  @MaxLength(KNOWLEDGE_LABEL_OVERRIDE_MAX_LENGTH)
  labelThOverride?: string | null;

  /** Override English label; omit to leave unchanged, `null` to clear. */
  @IsOptional()
  @IsString()
  @MaxLength(KNOWLEDGE_LABEL_OVERRIDE_MAX_LENGTH)
  labelEnOverride?: string | null;

  /** Domain description (no code equivalent); omit to keep, `null` to clear. */
  @IsOptional()
  @IsString()
  @MaxLength(KNOWLEDGE_DESCRIPTION_MAX_LENGTH)
  descriptionTh?: string | null;

  /** Position on the mind-map ring (≥ 0). */
  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;

  /**
   * Colour hue token (design-system §4 palette). `null` clears it → the
   * FE falls back to the layer default. The `@IsIn` rejects a non-allowed
   * non-null token at the DTO layer; the service re-asserts with the
   * structured `KNOWLEDGE_TOKEN_INVALID` code.
   */
  @IsOptional()
  @IsIn([...KNOWLEDGE_COLOR_TOKENS])
  colorToken?: string | null;

  /** Lucide icon key (closed allow-list). `null` clears it. */
  @IsOptional()
  @IsIn([...KNOWLEDGE_ICON_KEYS])
  iconKey?: string | null;

  /** Hide the node from the mind-map render (display-only — gates nothing). */
  @IsOptional()
  @IsBoolean()
  isHidden?: boolean;
}

/**
 * `PATCH /structure/domains/order` — bulk drag-reorder convenience (task
 * §3 "Bulk reorder convenience"). Accepts an ordered `domainKey[]`; the
 * service stamps each key's `display_order` to its array index in ONE
 * transaction and writes a SINGLE batch `domain_meta_update` audit row
 * carrying the full applied order (task §3 chose the batch row to keep
 * audit volume sane). Unknown keys are ignored, not rejected (task §8
 * stale-list edge case); the response echoes the applied order.
 */
export class ReorderKnowledgeDomainsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  domainKeys!: string[];
}
