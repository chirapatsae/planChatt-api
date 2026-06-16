/**
 * Wave wave-ai-knowledge-hub — DB-01 (enum born on
 * `ai_knowledge_entries.classification`) / DB-02 (hoisted here, 2026-06-12).
 *
 * Shared value set for the `ai_knowledge_classification` Postgres enum.
 *
 * Q4 LOCKED (2026-06-12): the set tops out at `internal` — PII is
 * categorically forbidden in external data, so no higher tier exists.
 *
 * Consumed by TWO columns that MUST declare the identical value list +
 * `enumName` (otherwise synchronize:true churns the enum type —
 * drop/recreate/cast, the `ai_target_kind` footgun):
 *
 *   - `ai_knowledge_entries.classification` (DB-01)
 *   - `ai_knowledge_sources.classification_ceiling` (DB-02)
 *
 * Lives in its own file (per the `report-format.enum.ts` precedent) so the
 * source entity does not value-import from the entry entity — the entry
 * already value-imports the source for its `source_id` FK relation, and a
 * two-way value cycle would leave this const in TDZ/undefined inside
 * whichever entity's column decorator evaluates first.
 */
export const AI_KNOWLEDGE_CLASSIFICATIONS = ['public', 'internal'] as const;

export type AiKnowledgeClassification =
  (typeof AI_KNOWLEDGE_CLASSIFICATIONS)[number];
