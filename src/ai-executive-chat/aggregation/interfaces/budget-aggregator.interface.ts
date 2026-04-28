/**
 * Wave 54 — Aggregation Layer Foundation (BE-W54-01).
 *
 * `IBudgetAggregator` fans reads over the three FK columns on
 * `Budget`:
 *   - `project_group_id`
 *   - `revised_project_group_id`
 *   - `supplement_project_group_id`
 *
 * Implementation (BE-W54-03) MUST:
 *   - Issue three parallel `IN (:...ids)` queries via entity-metadata.
 *     NO raw SQL table literals. NO SQL UNION (application-layer merge).
 *   - Chunk `IN` parameter lists at 5000 ids per batch (design §3.2,
 *     risk W54-R2 — Postgres 65535 parameter limit).
 *   - Apply `COALESCE(SUM(quantity), 0)` so projects with no budget
 *     rows are absent from the result Map (callers default to 0).
 *   - Return `Map<ProjectKey, number>` keyed by
 *     `` `${projectKind}:${projectId}` ``.
 *
 * CLAUDE.md references:
 *   - §17.2 Advisory-only.
 *   - §17.9 Schema defense — values are non-negative numbers.
 *   - NO PII — numeric SUM only.
 */
import type { ProjectKey, UnifiedProject } from '../types';

export interface IBudgetAggregator {
  /**
   * SUM of `Budget.quantity` per `UnifiedProject`.
   *
   * @param projects the logical projection batch (ordered / deduped by
   * the caller)
   */
  totalsForUnifiedProjects(
    projects: UnifiedProject[],
  ): Promise<Map<ProjectKey, number>>;
}
