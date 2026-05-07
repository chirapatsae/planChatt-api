/**
 * Wave 54 — BE-W54-04 — StatusAggregator (Tier B).
 *
 * Composes `TrackingStatus` reads across its three explicit FK columns
 *   (`project_group_id`, `revised_project_group_id`,
 *    `supplement_project_group_id`)
 * into a single logical `Map<ProjectKey, LatestStatus>`.
 *
 * Contract — design memo §3.3, task BE-W54-04:
 *   - READ-only. NEVER writes to `tracking_status` (§12 audit ownership;
 *     §17.2 advisory-only). No `.save` / `.update` / `.delete` /
 *     `.softRemove` / `.softDelete` / `.remove` / `.insert` / `.upsert`
 *     on the TrackingStatus repository or any other repository.
 *   - Three parallel queries (one per FK column), each filtering
 *     `ts.isLatest = true AND ts.deletedAt IS NULL`.
 *   - Chunked `IN (:...ids)` at 5000 per query to stay under the
 *     Postgres parameter limit (65535) — matches the strategy
 *     documented for BE-W54-03 (budget aggregator) for consistency.
 *   - Application-layer merge by `ProjectKey`; NO DB UNION, NO raw SQL
 *     table literals.
 *   - W67-FIX-01: `LatestStatus.statusName` carries the canonical
 *     ENGLISH name from `status.name` (so downstream English-keyed
 *     switches keep working). The Thai display label is sourced via
 *     `toThaiStatus` from `src/ai-executive-chat/tools/status-th.ts`
 *     and projected onto `LatestStatus.statusNameTh` (REUSE, do not
 *     duplicate). W68 will migrate `statusNameTh` to a runtime JOIN
 *     against `status.th_name` and retire the static map.
 *   - Empty input → empty `Map`.
 *   - Missing status row → key ABSENT from the result `Map` (see task
 *     §7 — "Projects without any isLatest=true row are absent").
 *   - Duplicate `isLatest=true` for the same project (should be
 *     impossible per §12, but defensive): keep the row with the newest
 *     `createAt`.
 *
 * CLAUDE.md references:
 *   - §12 Audit Rule — audit ownership stays with workflow transitions;
 *     this service MUST NOT flip `isLatest`, create, or delete any
 *     tracking row.
 *   - §14 / §15 — reads are allowed on locked rows and frozen books.
 *   - §17.2 / §17.11 — advisory-only, no role exemption.
 *   - §17   PII discipline — projects only `{ statusName, createdAt,
 *     isLatest }`. NEVER projects actor, createdBy, or any
 *     person-level field.
 */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { toThaiStatus } from '../../tools/status-th';

import type {
  IStatusAggregator,
  LatestStatus,
} from '../interfaces/status-aggregator.interface';
import type { ProjectKey, ProjectKind, UnifiedProject } from '../types';

// Postgres bind-parameter safety ceiling. Kept in lockstep with
// BE-W54-03 BudgetAggregator. Each chunk uses 1 parameter per id.
const IN_CLAUSE_CHUNK_SIZE = 5000;

/**
 * FK column metadata — keyed by the service-layer `ProjectKind`
 * discriminator.
 *
 * `column` is the DB column name used in the `WHERE … IN (…)` clause
 * — this matches the existing Wave 53 handler pattern
 * (`ts.project_group_id IS NOT NULL`, etc.). The `raw` alias is the
 * selector emitted by TypeORM when using raw SELECT projections.
 */
const FK_CONFIG: ReadonlyArray<{
  kind: ProjectKind;
  column:
    | 'project_group_id'
    | 'revised_project_group_id'
    | 'supplement_project_group_id';
  rawKey:
    | 'project_group_id'
    | 'revised_project_group_id'
    | 'supplement_project_group_id';
}> = [
  {
    kind: 'main',
    column: 'project_group_id',
    rawKey: 'project_group_id',
  },
  {
    kind: 'revised',
    column: 'revised_project_group_id',
    rawKey: 'revised_project_group_id',
  },
  {
    kind: 'supplement',
    column: 'supplement_project_group_id',
    rawKey: 'supplement_project_group_id',
  },
];

/** Internal raw-row projection from the TrackingStatus query builder. */
interface LatestRawRow {
  projectid: string;
  statusname: string | null;
  createat: Date | string | null;
}

/** Composite key helper — mirrors `ProjectKey = `${kind}:${id}``. */
function toKey(kind: ProjectKind, projectId: string): ProjectKey {
  return `${kind}:${projectId}`;
}

/** Chunk an array at the Postgres-parameter-safe boundary. */
function chunk<T>(input: readonly T[], size: number): T[][] {
  if (input.length === 0) return [];
  if (size <= 0) return [input.slice()];
  const out: T[][] = [];
  for (let i = 0; i < input.length; i += size) {
    out.push(input.slice(i, i + size));
  }
  return out;
}

/** Normalise raw createAt → ISO string; returns null for bad inputs. */
function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : value.toISOString();
  }
  // Postgres driver may return ISO strings directly.
  const parsed = new Date(value);
  const t = parsed.getTime();
  return Number.isNaN(t) ? null : parsed.toISOString();
}

@Injectable()
export class StatusAggregator implements IStatusAggregator {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Returns the latest status per `UnifiedProject`. Projects without any
   * `isLatest = true` row are ABSENT from the result `Map` (not
   * populated with a sentinel).
   *
   * Implementation:
   *   1. Bucket project ids by `projectKind`.
   *   2. Emit three parallel queries via `Promise.all`, one per FK
   *      column, each filtering `ts.isLatest = true`.
   *   3. Merge the raw rows into a single `Map<ProjectKey, LatestStatus>`
   *      keyed by `${kind}:${projectId}`. On duplicate, keep the newest
   *      `createAt` (defensive — §12 invariant says this should be
   *      impossible).
   */
  async latestStatusFor(
    projects: UnifiedProject[],
  ): Promise<Map<ProjectKey, LatestStatus>> {
    const result = new Map<ProjectKey, LatestStatus>();
    if (!projects || projects.length === 0) {
      return result;
    }

    // Bucket unique ids per kind. A Set guards against duplicate inputs
    // so one kind's chunk query does not balloon beyond necessity.
    const idsByKind: Record<ProjectKind, string[]> = {
      main: [],
      revised: [],
      supplement: [],
    };
    const seen: Record<ProjectKind, Set<string>> = {
      main: new Set<string>(),
      revised: new Set<string>(),
      supplement: new Set<string>(),
    };
    for (const p of projects) {
      if (!p || typeof p.projectId !== 'string' || p.projectId.length === 0) {
        continue;
      }
      const kind = p.projectKind;
      if (kind !== 'main' && kind !== 'revised' && kind !== 'supplement') {
        continue;
      }
      if (seen[kind].has(p.projectId)) continue;
      seen[kind].add(p.projectId);
      idsByKind[kind].push(p.projectId);
    }

    // Build one Promise per (kind, chunk) pair. Promise.all fans them
    // out in parallel; rejections bubble up to the Tier C dimension
    // boundary — per task §11.R1 and design §5.2 the caller catches.
    const tasks: Array<Promise<{ kind: ProjectKind; rows: LatestRawRow[] }>> =
      [];
    for (const cfg of FK_CONFIG) {
      const ids = idsByKind[cfg.kind];
      if (ids.length === 0) continue;
      for (const ch of chunk(ids, IN_CLAUSE_CHUNK_SIZE)) {
        tasks.push(this.queryChunk(cfg, ch));
      }
    }

    const settled = await Promise.all(tasks);

    for (const { kind, rows } of settled) {
      for (const row of rows) {
        if (!row || typeof row.projectid !== 'string' || !row.projectid) {
          continue;
        }
        const key = toKey(kind, row.projectid);
        const iso = toIso(row.createat);
        if (!iso) {
          // Without a valid timestamp we cannot tie-break duplicates
          // reliably; skip the row rather than invent data.
          continue;
        }
        // W67-FIX-01 — restore the canonical-English contract.
        //
        // Pre-fix this branch wrote the Thai-translated label into
        // `statusName`, which silently broke every downstream consumer
        // that switches on canonical English (notably the executive
        // 4-group rollup via `mapToExecutiveStatusGroup`). The fix is
        // additive: keep the Thai label sibling on `statusNameTh` for
        // display sites, while `statusName` carries the canonical
        // English value as documented on `LatestStatus`.
        //
        // `toThaiStatus()` remains the runtime Thai source while W68
        // migrates Thai labels to a runtime JOIN on `status.th_name`.
        const canonicalEnglish = row.statusname ?? '';
        const next: LatestStatus = {
          statusName: canonicalEnglish,
          statusNameTh: toThaiStatus(canonicalEnglish),
          createdAt: iso,
          isLatest: true,
        };
        const prior = result.get(key);
        if (!prior) {
          result.set(key, next);
          continue;
        }
        // Defensive tie-break: keep the newest row if the DB
        // momentarily shows two `isLatest=true` rows (§12 says this
        // should be impossible; see task R1).
        if (next.createdAt > prior.createdAt) {
          result.set(key, next);
        }
      }
    }

    return result;
  }

  /**
   * Issues a single chunked query against TrackingStatus for one FK
   * column. Entity-metadata only — NO raw table literals.
   *
   * §12 reminder: this method is READ-ONLY. It never writes, flips
   * `isLatest`, or deletes a tracking row.
   */
  private async queryChunk(
    cfg: (typeof FK_CONFIG)[number],
    ids: readonly string[],
  ): Promise<{ kind: ProjectKind; rows: LatestRawRow[] }> {
    if (ids.length === 0) {
      return { kind: cfg.kind, rows: [] };
    }
    const rawRows: Array<Record<string, unknown>> = await this.dataSource
      .getRepository(TrackingStatus)
      .createQueryBuilder('ts')
      .select(`ts.${cfg.column}`, 'projectid')
      .addSelect('status.name', 'statusname')
      .addSelect('ts.createAt', 'createat')
      .innerJoin('ts.statusId', 'status')
      .where('ts.isLatest = :latest', { latest: true })
      .andWhere('ts.deletedAt IS NULL')
      .andWhere(`ts.${cfg.column} IN (:...ids)`, { ids: [...ids] })
      .getRawMany();

    const rows: LatestRawRow[] = rawRows.map((r) => ({
      projectid: String(r.projectid ?? ''),
      statusname:
        typeof r.statusname === 'string' && r.statusname.length > 0
          ? r.statusname
          : null,
      createat:
        r.createat instanceof Date
          ? r.createat
          : typeof r.createat === 'string'
            ? r.createat
            : null,
    }));

    return { kind: cfg.kind, rows };
  }
}
