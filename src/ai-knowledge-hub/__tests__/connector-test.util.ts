/**
 * Wave wave-ai-knowledge-hub — BE-03 (2026-06-12).
 *
 * Shared in-memory harness for the connector specs. Mirrors the
 * BE-02 `knowledge-crud.spec.ts` philosophy: REAL services over fake
 * repositories; the audit service's BASE repository THROWS so every
 * spec proves the audit row joined the caller's transaction.
 */
import { HttpException } from '@nestjs/common';

import { AiKnowledgeAuditLog } from '../entities/ai-knowledge-audit-log.entity';
import { AiKnowledgeEntry } from '../entities/ai-knowledge-entry.entity';
import { AiKnowledgeEntryRevision } from '../entities/ai-knowledge-entry-revision.entity';
import { AiKnowledgeIngestion } from '../entities/ai-knowledge-ingestion.entity';
import { AiKnowledgeSource } from '../entities/ai-knowledge-source.entity';

export async function expectHttpError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(HttpException);
  const exception = caught as HttpException;
  expect(exception.getStatus()).toBe(status);
  const response = exception.getResponse();
  if (typeof response === 'string') {
    expect(response).toBe(code);
  } else {
    const body = response as Record<string, unknown>;
    expect(body.code ?? body.message).toBe(code);
  }
}

type Row = Record<string, any>;

/** Shallow `where` matcher (single object — OR-arrays handled by caller). */
function rowMatches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

/**
 * Minimal TypeORM-repository fake covering exactly the surface the
 * BE-03 services exercise: find / findOne / create / save / update /
 * createQueryBuilder (grouped-count stub) / manager.transaction.
 */
export class FakeRepo<T extends Row = Row> {
  rows: T[] = [];
  private sequence = 0;

  constructor(
    private readonly idPrefix: string,
    /** Resolves manager.getRepository(Entity) inside transactions. */
    private readonly repoMap: Map<unknown, unknown>,
  ) {}

  create(data: Row): T {
    return { ...data } as T;
  }

  async find(options?: { where?: Row; order?: Row }): Promise<T[]> {
    const where = options?.where;
    if (!where) return [...this.rows];
    return this.rows.filter((row) => rowMatches(row, where));
  }

  async findOne(options: {
    where: Row | Row[];
    withDeleted?: boolean;
    relations?: string[];
  }): Promise<T | null> {
    const clauses = Array.isArray(options.where)
      ? options.where
      : [options.where];
    for (const clause of clauses) {
      const hit = this.rows.find(
        (row) =>
          rowMatches(row, clause) &&
          (options.withDeleted || !row.deletedAt),
      );
      if (hit) return hit;
    }
    return null;
  }

  async save(row: Row): Promise<T> {
    if (!row.id) {
      this.sequence += 1;
      row.id = `${this.idPrefix}-${this.sequence}`;
    }
    if (!row.createdAt) row.createdAt = new Date();
    if (!('deletedAt' in row)) row.deletedAt = null;
    const existing = this.rows.find((r) => r.id === row.id);
    if (existing) {
      Object.assign(existing, row);
      return existing as T;
    }
    this.rows.push(row as T);
    return row as T;
  }

  async insert(row: Row): Promise<{ identifiers: Row[] }> {
    await this.save(row);
    return { identifiers: [{ id: row.id }] };
  }

  async update(
    criteria: Row,
    patch: Row,
  ): Promise<{ affected: number }> {
    let affected = 0;
    for (const row of this.rows) {
      if (rowMatches(row, criteria)) {
        Object.assign(row, patch);
        affected += 1;
      }
    }
    return { affected };
  }

  /** Chainable QB stub — grouped aggregations answer empty (health=0). */
  createQueryBuilder(): any {
    const qb: any = {
      select: () => qb,
      addSelect: () => qb,
      where: () => qb,
      andWhere: () => qb,
      groupBy: () => qb,
      addGroupBy: () => qb,
      orderBy: () => qb,
      skip: () => qb,
      take: () => qb,
      getRawMany: async () => [],
      getManyAndCount: async () => [[], 0],
    };
    return qb;
  }

  get manager() {
    const repoMap = this.repoMap;
    return {
      transaction: async <R>(
        cb: (manager: {
          getRepository: (entity: unknown) => unknown;
        }) => Promise<R>,
      ): Promise<R> =>
        cb({
          getRepository: (entity: unknown) => {
            const repo = repoMap.get(entity);
            if (!repo) {
              throw new Error(
                `FakeRepo manager: no repository registered for ${String(
                  (entity as { name?: string })?.name ?? entity,
                )}`,
              );
            }
            return repo;
          },
        }),
      getRepository: (entity: unknown) => {
        const repo = repoMap.get(entity);
        if (!repo) throw new Error('FakeRepo manager: missing repo');
        return repo;
      },
    };
  }
}

export interface HarnessRepos {
  repoMap: Map<unknown, unknown>;
  sourceRepo: FakeRepo;
  ingestionRepo: FakeRepo;
  entryRepo: FakeRepo;
  revisionRepo: FakeRepo;
  auditRepo: FakeRepo;
  auditRows: Row[];
  workHistoryRepo: {
    findOne: (options: { where: Row }) => Promise<Row | null>;
  };
  /**
   * Base repository handed to `KnowledgeAuditService` — THROWS on
   * insert so specs prove every audit row was written through the
   * caller's transactional manager (BE-02 precedent).
   */
  throwingAuditRepo: { insert: () => never };
}

/**
 * Build the full fake-repo set. The WorkHistory fake resolves any
 * `userId` to WorkHistory `wh-<userId>` with role `admin` — distinct
 * user ids therefore yield distinct WorkHistory ids (4-eyes testing).
 */
export function makeHarnessRepos(): HarnessRepos {
  const repoMap = new Map<unknown, unknown>();
  const sourceRepo = new FakeRepo('src', repoMap);
  const ingestionRepo = new FakeRepo('ing', repoMap);
  const entryRepo = new FakeRepo('entry', repoMap);
  const revisionRepo = new FakeRepo('rev', repoMap);
  const auditRepo = new FakeRepo('audit', repoMap);

  repoMap.set(AiKnowledgeSource, sourceRepo);
  repoMap.set(AiKnowledgeIngestion, ingestionRepo);
  repoMap.set(AiKnowledgeEntry, entryRepo);
  repoMap.set(AiKnowledgeEntryRevision, revisionRepo);
  repoMap.set(AiKnowledgeAuditLog, auditRepo);

  const workHistoryRepo = {
    findOne: async (options: { where: Row }): Promise<Row | null> => {
      const userId = options.where?.user?.id as string | undefined;
      if (!userId) return null;
      return { id: `wh-${userId}`, role: { name: 'admin' } };
    },
  };

  const throwingAuditRepo = {
    insert: (): never => {
      throw new Error(
        'audit row written OUTSIDE the caller transaction (must use manager)',
      );
    },
  };

  return {
    repoMap,
    sourceRepo,
    ingestionRepo,
    entryRepo,
    revisionRepo,
    auditRepo,
    auditRows: auditRepo.rows,
    workHistoryRepo,
    throwingAuditRepo,
  };
}
