/**
 * Wave 54 — BE-W54-03 — BudgetAggregator concrete implementation.
 *
 * Fans `Budget` reads across the three FK columns
 *   - `project_group_id`
 *   - `revised_project_group_id`
 *   - `supplement_project_group_id`
 *
 * via entity-metadata only. The physical table name is resolved from
 * `@Entity('budget')` (see `backend/src/budget/entities/budget.entity.ts`)
 * NEVER via a raw string literal — this closes the Wave 53 P0 RCA
 * (`docs/reports/wave53/BE-W53-01.md`) at the Tier B layer.
 *
 * Implementation rules (design memo §3.2 + task §3):
 *   - Three independent aggregation passes (Promise.all), NOT a SQL UNION.
 *     A JOIN onto the project tables would fan-out rows by
 *     budgets-per-project (see BE-W53-02 mitigation); three separate
 *     GROUP BY <fk> queries give one SUM per project row with no fan-out.
 *   - Chunk `IN (:...ids)` at 5000 ids per batch for Postgres parameter
 *     safety (design risk W54-R2 — Postgres limit is 65535 parameters).
 *   - Merge chunk results in application layer into a single
 *     `Map<ProjectKey, number>`.
 *   - `COALESCE(SUM(b.quantity), 0)` semantics — missing keys (no budget
 *     row in any FK column) are absent from the Map so callers default
 *     to `0` per task §7 (consumer contract).
 *   - Fail-fast: on any DB error the aggregator PROPAGATES upstream —
 *     `ResilienceEnvelope` (BE-W54-07) catches at the dimension boundary.
 *
 * §-compliance (CLAUDE.md):
 *   - §12 Audit Rule — read-only, NO `tracking_status` writes.
 *   - §14 / §15 lineage locks — READS allowed on locked/frozen rows.
 *   - §17.2 Advisory-only — the SUM does not gate any workflow.
 *   - §17.3 FK isolation — no FK from ai_* to project tables (not
 *     applicable at this layer, but the service does no persistence).
 *   - §17.11 No role exemption — service accepts already-asserted
 *     context from Tier C; no role check baked in here.
 */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Budget } from 'src/budget/entities/budget.entity';
import type { IBudgetAggregator } from '../interfaces/budget-aggregator.interface';
import type { ProjectKey, UnifiedProject } from '../types';

/**
 * Postgres parameter-array safety chunk size. Postgres caps parameters
 * at 65535; 5000 leaves generous headroom for the query planner and
 * any additional parameterised predicates the planner may inject.
 */
export const BUDGET_AGGREGATOR_IN_CHUNK_SIZE = 5000;

/**
 * Narrow row shape returned by the GROUP BY <fk> SUM query.
 * `id` is nullable in the raw-query projection only if the FK itself is
 * NULL; we filter `WHERE fk IN (:...ids)` so nullables are structurally
 * impossible, but we guard regardless.
 */
type SumRow = { id: string | null; sum: string | number | null };

@Injectable()
export class BudgetAggregatorService implements IBudgetAggregator {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async totalsForUnifiedProjects(
    projects: UnifiedProject[],
  ): Promise<Map<ProjectKey, number>> {
    const result = new Map<ProjectKey, number>();
    if (!Array.isArray(projects) || projects.length === 0) {
      return result;
    }

    // Split the batch by projectKind — each kind targets a different
    // FK column on Budget.
    const mainIds: string[] = [];
    const revisedIds: string[] = [];
    const supplementIds: string[] = [];

    for (const p of projects) {
      if (!p || typeof p.projectId !== 'string' || p.projectId.length === 0) {
        continue;
      }
      if (p.projectKind === 'main') mainIds.push(p.projectId);
      else if (p.projectKind === 'revised') revisedIds.push(p.projectId);
      else if (p.projectKind === 'supplement')
        supplementIds.push(p.projectId);
    }

    // Three independent fan-out passes, parallel.
    const [mainRows, revisedRows, supplementRows] = await Promise.all([
      this.sumByFk('project_group_id', mainIds),
      this.sumByFk('revised_project_group_id', revisedIds),
      this.sumByFk('supplement_project_group_id', supplementIds),
    ]);

    // Merge per-kind into the unified ProjectKey map.
    for (const row of mainRows) {
      if (!row.id) continue;
      const key: ProjectKey = `main:${row.id}`;
      result.set(key, toNumber(row.sum));
    }
    for (const row of revisedRows) {
      if (!row.id) continue;
      const key: ProjectKey = `revised:${row.id}`;
      result.set(key, toNumber(row.sum));
    }
    for (const row of supplementRows) {
      if (!row.id) continue;
      const key: ProjectKey = `supplement:${row.id}`;
      result.set(key, toNumber(row.sum));
    }

    return result;
  }

  /**
   * Group `Budget.quantity` SUMs by the named FK column for the given id
   * list. Chunks the IN clause at `BUDGET_AGGREGATOR_IN_CHUNK_SIZE` and
   * unions chunk results in the application layer.
   *
   * Entity-metadata resolution only — the physical table name is
   * resolved from `Budget`'s `@Entity('budget')` metadata; NO raw table
   * literal appears in this method.
   */
  private async sumByFk(
    fkColumn:
      | 'project_group_id'
      | 'revised_project_group_id'
      | 'supplement_project_group_id',
    ids: string[],
  ): Promise<SumRow[]> {
    if (ids.length === 0) return [];

    const repo = this.dataSource.getRepository(Budget);
    const chunks = chunk(ids, BUDGET_AGGREGATOR_IN_CHUNK_SIZE);
    const out: SumRow[] = [];

    for (const chunkIds of chunks) {
      // Physical `"budget"` table name is emitted by TypeORM from the
      // `@Entity('budget')` metadata on `Budget` — no raw literal.
      const qb = repo
        .createQueryBuilder('b')
        .select(`b.${fkColumn}`, 'id')
        .addSelect('COALESCE(SUM(b.quantity), 0)', 'sum')
        .where(`b.${fkColumn} IN (:...ids)`, { ids: chunkIds })
        .groupBy(`b.${fkColumn}`);
      const rows = await qb.getRawMany<SumRow>();
      out.push(...rows);
    }

    return out;
  }
}

/**
 * Split an array into fixed-size chunks. Preserves order; empty input
 * returns `[]` (NOT `[[]]`).
 */
function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be > 0');
  if (arr.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * Coerce a raw-SQL SUM column (Postgres decimal → string | number | null)
 * into a finite JS number. Returns `0` on null / non-finite so the
 * aggregator never emits `NaN` or `null` values (task §7 — Map values
 * are `number`, never nullable).
 */
function toNumber(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
