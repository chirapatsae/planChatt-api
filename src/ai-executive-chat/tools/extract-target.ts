/**
 * BE-W45-01 — tool-aware `target_id` extractor for executive chat.
 *
 * Replaces the Wave 44 HOTFIX-W44-01 sentinel writes
 * (`target_id = '00000000-0000-0000-0000-000000000000'`, every row) with
 * a declarative, tool-aware capture: the chat service asks this module
 * "given this tool name and its raw result, does the result resolve to a
 * single concrete project?" and only then persists a real UUID.
 *
 * CLAUDE.md references:
 *   - §17.2 Advisory-only. `target_id` is metadata, NEVER a workflow
 *     gate. The extractor MUST NEVER throw — a missing field, an array
 *     with != 1 element, or a malformed payload all silently degrade to
 *     `null`. Degrading is the correct behavior for an advisory column.
 *   - §17.3 Audit separation. `target_id` stays a plain uuid with NO
 *     foreign key. The extractor only resolves the column value; it
 *     does NOT look up or validate the UUID against any project table.
 *   - §17.4 Staleness unchanged. This module has nothing to say about
 *     staleness — persisted rows remain `snapshot-only`, `isStale:false`.
 *   - §17.11 No role exemption. The extractor is purely structural —
 *     no role (including super-admin) can coerce a different target.
 *
 * Design notes:
 *   - The registry is **closed by this file**. Adding a new extractable
 *     tool requires an explicit entry in `TARGET_EXTRACTION_REGISTRY`.
 *     A non-registered tool name returns `null` — safe by default.
 *   - The zero-UUID (`00000000-0000-0000-0000-000000000000`) is
 *     syntactically valid RFC 4122 but is rejected here as a historical
 *     sentinel. This protects against legacy sentinel values leaking
 *     back in through a hypothetical future tool that echoed them.
 *   - Shape `single-items-array` requires `items.length === 1`. Zero
 *     hits and two-or-more hits BOTH return `null` — the LLM has not
 *     narrowed to one concrete project in either case.
 */

import type { AiResultTargetKind } from '../../ai/utils/ai-score-envelope';

/**
 * Shape of the raw result this extractor knows how to walk.
 *   - `single-items-array`: result has an `items` array; capture from
 *     `items[0][idField]` only when `items.length === 1`.
 *   - `single-scalar`: result has `result[idField]` as a top-level
 *     scalar (reserved for future use; no Wave 45 tool uses this).
 *   - `none`: tool never resolves to a single project; always `null`.
 */
export type TargetExtractionShape =
  | 'single-items-array'
  | 'single-scalar'
  | 'none';

export interface TargetExtractionMeta {
  kind: AiResultTargetKind;
  shape: TargetExtractionShape;
  /** Field name on the single row (or top-level) that carries the UUID. */
  idField: string;
}

/**
 * Result of an extraction attempt.
 *   - `{ targetId, targetKind }` when the tool resolved to exactly one
 *     project AND the captured value is a syntactically valid,
 *     non-sentinel UUID.
 *   - `null` in every other case (non-registered tool, wrong item
 *     count, non-UUID value, zero-UUID value, malformed payload).
 */
export type ExtractedTarget = {
  targetId: string;
  targetKind: AiResultTargetKind;
} | null;

/**
 * Closed registry of tools whose results this extractor will capture.
 *
 * Wave 45 scope: exactly 3 single-project-resolving tools. All other
 * currently-shipped tools return aggregates / buckets / plan IDs and
 * are explicitly NOT registered here.
 *
 * The registry key type is `string` (not `ExecutiveToolName`) so the
 * extractor can accept any tool name defensively without a cyclic
 * dependency on the tool whitelist; non-registered names return `null`.
 */
export const TARGET_EXTRACTION_REGISTRY: Readonly<
  Record<string, TargetExtractionMeta>
> = Object.freeze({
  searchProjectsByKeyword: {
    kind: 'project-group',
    shape: 'single-items-array',
    idField: 'projectId',
  },
  detectWorkflowAgingProjects: {
    kind: 'project-group',
    shape: 'single-items-array',
    idField: 'projectId',
  },
  highlightBudgetOutliers: {
    kind: 'project-group',
    shape: 'single-items-array',
    idField: 'projectId',
  },
  // Wave AI-Exec-Chat-Equipment-ผ.03 (2026-07-18) — the only equipment
  // tool that can resolve to a single concrete row. The static kind is
  // the generic `equipment-project-group` (the extractor is per-tool
  // static metadata; RELPG/SEPG rows degrade to the same advisory kind
  // — target_id is §17.3 audit-by-UUID-no-FK metadata, never a gate).
  searchEquipmentByKeyword: {
    kind: 'equipment-project-group',
    shape: 'single-items-array',
    idField: 'equipmentId',
  },
});

/**
 * Strict RFC 4122 UUID shape (lowercase or uppercase hex).
 * Matches the canonical 8-4-4-4-12 grouping. Variant/version bits are
 * NOT enforced — a future v7 UUID or any well-formed v4 UUID must pass.
 */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Legacy sentinel UUID written by Wave 44 HOTFIX-W44-01. Explicitly
 * rejected so that a hypothetical tool that surfaces the sentinel (e.g.
 * if it echoes a legacy DB row) cannot resurrect it into new writes.
 */
const LEGACY_SENTINEL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Returns `true` iff `value` is a syntactically valid, non-sentinel UUID.
 * Fail-closed: anything that is not a `string` returns `false`.
 */
function isAcceptableUuid(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.toLowerCase() === LEGACY_SENTINEL_UUID) return false;
  return UUID_REGEX.test(value);
}

/**
 * Extract a `target_id` / `target_kind` pair from a tool result.
 *
 * Contract:
 *   - MUST NEVER throw. All failure modes return `null`.
 *   - MUST return `null` for any tool name not present in the registry.
 *   - MUST return `null` if the shape walk fails (missing field,
 *     wrong type, array with length != 1, non-UUID scalar, zero-UUID).
 *   - MUST return `{ targetId, targetKind }` only when the captured
 *     value passes `isAcceptableUuid`.
 *
 * The input `result` is the raw, pre-redaction tool output (the same
 * payload that hits `persistToolRound`). Redaction happens on the wire
 * payload only; the extractor reads the structurally-intact version
 * so UUIDs are preserved.
 */
export function extractTargetFromToolResult(
  toolName: string,
  result: unknown,
): ExtractedTarget {
  try {
    const meta = TARGET_EXTRACTION_REGISTRY[toolName];
    if (!meta) return null;
    if (meta.shape === 'none') return null;

    // Defensive: result MUST be a plain object to walk.
    if (result === null || typeof result !== 'object') return null;
    const obj = result as Record<string, unknown>;

    if (meta.shape === 'single-items-array') {
      const items = obj.items;
      if (!Array.isArray(items)) return null;
      if (items.length !== 1) return null;
      const first = items[0];
      if (first === null || typeof first !== 'object') return null;
      const raw = (first as Record<string, unknown>)[meta.idField];
      if (!isAcceptableUuid(raw)) return null;
      return { targetId: raw, targetKind: meta.kind };
    }

    if (meta.shape === 'single-scalar') {
      const raw = obj[meta.idField];
      if (!isAcceptableUuid(raw)) return null;
      return { targetId: raw, targetKind: meta.kind };
    }

    return null;
  } catch {
    // §17.2 — advisory column; NEVER propagate an extractor failure.
    return null;
  }
}
