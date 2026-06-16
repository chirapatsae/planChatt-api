import {
  ArrayMaxSize,
  IsArray,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Wave wave-ai-knowledge-structure-mgmt — BE-04 (Phase 3, 2026-06-13).
 *
 * Request body for the Class-B tool↔domain binding override
 * (`PUT /v1/ai-knowledge-hub/structure/tool-bindings/:domainKey`, topic v
 * — report §3.6 / §4.1). SUPER-ADMIN ONLY (Q-04; enforced at the
 * controller via `@Roles(...SUPER_ADMIN_ONLY)` — stricter than the
 * Class-A `ADMIN_OR_ABOVE`).
 *
 * The body carries the FULL desired `toolName[]` for the named domain
 * (replace-set semantics — NOT a delta). The service folds it into the
 * complete override set and re-asserts the registry⇄domain BIJECTION at
 * RUNTIME before committing:
 *   1. every `toolName ∈ EXECUTIVE_TOOL_NAMES`
 *   2. no `toolName` already bound to a DIFFERENT domain (no double-map —
 *      also backed by the DB `UNIQUE(tool_name)` index, defense-in-depth)
 *   3. after applying the change, EVERY registry tool is mapped to
 *      EXACTLY one domain (no orphan)
 * A violation → `400 KNOWLEDGE_TOOL_BINDING_INVALID` and the whole
 * transaction rolls back (no partial binding). Super-admin canNOT persist
 * a violating binding — the guard is integrity, not permission (§17.11).
 *
 * The `@IsString` / per-element cap here is the first-line shape guard;
 * the AUTHORITATIVE membership check (`∈ EXECUTIVE_TOOL_NAMES`) is the
 * service-layer bijection guard with the structured error code. Caps
 * mirror `ai_knowledge_tool_binding.tool_name` (DB-01 §3.6 — varchar(128))
 * and the 30-tool registry ceiling (a small abuse cushion above it).
 */
export const TOOL_BINDING_NAME_MAX_LENGTH = 128;
export const TOOL_BINDING_BATCH_MAX = 200;

export class PutToolBindingDto {
  /**
   * The FULL desired tool set for this domain (replace-set). An empty
   * array unbinds every tool from the domain — a deliberate "this domain
   * backs no tool" action. The runtime bijection guard then re-checks
   * that no registry tool is left orphaned across the whole override set.
   */
  @IsArray()
  @ArrayMaxSize(TOOL_BINDING_BATCH_MAX)
  @IsString({ each: true })
  @MaxLength(TOOL_BINDING_NAME_MAX_LENGTH, { each: true })
  toolNames!: string[];
}
