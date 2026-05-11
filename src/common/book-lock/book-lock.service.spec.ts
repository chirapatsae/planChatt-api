import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  BookLockService,
  BOOK_HAS_NEWER_REVISION,
} from './book-lock.service';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';

/**
 * W116-BE-01 — Revision-Type-Aware Book Lineage Lock.
 *
 * Verifies that `BookLockService.hasNewerRevision` partitions the
 * revision-vs-revision newer-sibling scan by `revisionType.id` so that
 * edit-vs-change rounds become parallel siblings that do NOT lock each
 * other (CLAUDE.md §15.2 partitioned-sibling refinement, W116).
 *
 * Same-type newer revisions, supplement-vs-revision (cross-type), and
 * plan-level "any child locks" semantics MUST continue to lock per §15.
 *
 * Approach: in-memory fixture set + a fake EntityManager whose
 * `getRepository().createQueryBuilder()` chain executes the WHERE-style
 * predicates against the fixture array. This isolates the
 * revision-type-aware predicate change without requiring a live
 * Postgres instance.
 */

const EDIT_TYPE_ID = 'rt-edit';
const CHANGE_TYPE_ID = 'rt-change';
const PLAN_ID = 'plan-1';

interface RevisionFixture {
  id: string;
  developmentPlanId: string;
  revisionTypeId: string | null;
  createdAt: Date;
  deletedAt: Date | null;
}

interface SupplementFixture {
  id: string;
  developmentPlanId: string;
  createdAt: Date;
  deletedAt: Date | null;
}

interface QueryFilters {
  planId?: string;
  ownCreatedAt?: Date;
  excludeId?: string;
  ownRevisionTypeId?: string;
  byId?: string;
}

/**
 * Build a minimal queryBuilder mock that records WHERE-style filters
 * and replays them against an in-memory fixture array. Only the
 * operations BookLockService actually invokes are implemented.
 */
function makeQueryBuilder<T extends Record<string, unknown>>(rows: T[]) {
  const filters: QueryFilters = {};

  const apply = (sql: string, params?: Record<string, unknown>) => {
    if (sql.includes('plan.id = :planId') && params) {
      filters.planId = params.planId as string;
    }
    if (sql.includes('createdAt > :ownCreatedAt') && params) {
      filters.ownCreatedAt = params.ownCreatedAt as Date;
    }
    if (sql.includes('<> :selfId') && params) {
      filters.excludeId = params.selfId as string;
    }
    if (sql.includes('rtype.id = :ownRevisionTypeId') && params) {
      filters.ownRevisionTypeId = params.ownRevisionTypeId as string;
    }
    if (sql.match(/\b\w+\.id = :id\b/) && params) {
      filters.byId = params.id as string;
    }
  };

  const qb: any = {
    select: () => qb,
    addSelect: () => qb,
    leftJoin: () => qb,
    where: (sql: string, params?: Record<string, unknown>) => {
      apply(sql, params);
      return qb;
    },
    andWhere: (sql: string, params?: Record<string, unknown>) => {
      apply(sql, params);
      return qb;
    },
    limit: () => qb,
    getRawOne: async () => {
      const matched = rows.filter((row) => {
        const r = row as unknown as RevisionFixture | SupplementFixture;
        if (r.deletedAt) return false;
        if (filters.byId !== undefined && r.id !== filters.byId) return false;
        if (
          filters.planId !== undefined &&
          r.developmentPlanId !== filters.planId
        ) {
          return false;
        }
        if (
          filters.ownCreatedAt !== undefined &&
          !(r.createdAt > filters.ownCreatedAt)
        ) {
          return false;
        }
        if (filters.excludeId !== undefined && r.id === filters.excludeId) {
          return false;
        }
        if (filters.ownRevisionTypeId !== undefined) {
          const rev = r as RevisionFixture;
          if (rev.revisionTypeId !== filters.ownRevisionTypeId) return false;
        }
        return true;
      });

      if (matched.length === 0) return undefined;
      const row = matched[0] as unknown as RevisionFixture;
      // Reproduce the raw shape BookLockService.loadLineageContext reads.
      return {
        r_id: row.id,
        r_created_at: row.createdAt,
        s_id: row.id,
        s_created_at: row.createdAt,
        planId: row.developmentPlanId,
        revisionTypeId: (row as RevisionFixture).revisionTypeId ?? null,
      };
    },
  };

  return qb;
}

function makeManager(
  revisions: RevisionFixture[],
  supplements: SupplementFixture[],
): EntityManager {
  return {
    getRepository: (entity: unknown) => {
      if (entity === DevelopmentPlanRevision) {
        return {
          createQueryBuilder: () => makeQueryBuilder(revisions),
        };
      }
      if (entity === DevelopmentPlanSupplement) {
        return {
          createQueryBuilder: () => makeQueryBuilder(supplements),
        };
      }
      throw new Error(`Unexpected repo: ${String(entity)}`);
    },
    exists: async (entity: unknown, opts: any) => {
      const planId = opts?.where?.developmentPlan?.id as string | undefined;
      if (entity === DevelopmentPlanRevision) {
        return revisions.some(
          (r) => !r.deletedAt && r.developmentPlanId === planId,
        );
      }
      if (entity === DevelopmentPlanSupplement) {
        return supplements.some(
          (s) => !s.deletedAt && s.developmentPlanId === planId,
        );
      }
      return false;
    },
  } as unknown as EntityManager;
}

describe('BookLockService — W116-BE-01 revision-type-aware sibling detection', () => {
  let service: BookLockService;

  beforeEach(() => {
    service = new BookLockService();
  });

  /**
   * Scenario 1 (the bug): edit#1 created at T0; change#1 created at
   * T1 > T0. Different revisionType → NEITHER locks the other.
   */
  it('parallel edit + change siblings do NOT lock each other', async () => {
    const T0 = new Date('2026-05-01T10:00:00Z');
    const T1 = new Date('2026-05-05T10:00:00Z');
    const revisions: RevisionFixture[] = [
      {
        id: 'edit-1',
        developmentPlanId: PLAN_ID,
        revisionTypeId: EDIT_TYPE_ID,
        createdAt: T0,
        deletedAt: null,
      },
      {
        id: 'change-1',
        developmentPlanId: PLAN_ID,
        revisionTypeId: CHANGE_TYPE_ID,
        createdAt: T1,
        deletedAt: null,
      },
    ];
    const manager = makeManager(revisions, []);

    await expect(
      service.hasNewerRevision('edit-1', 'development_plan_revision', manager),
    ).resolves.toBe(false);
    await expect(
      service.hasNewerRevision(
        'change-1',
        'development_plan_revision',
        manager,
      ),
    ).resolves.toBe(false);
    await expect(
      service.assertEditable('edit-1', 'development_plan_revision', manager),
    ).resolves.toBeUndefined();
  });

  /**
   * Regression 1: same-type lock preserved. edit#2 strictly newer than
   * edit#1 → edit#1 IS locked.
   */
  it('same-type newer revision STILL locks (regression)', async () => {
    const T0 = new Date('2026-05-01T10:00:00Z');
    const T2 = new Date('2026-05-10T10:00:00Z');
    const revisions: RevisionFixture[] = [
      {
        id: 'edit-1',
        developmentPlanId: PLAN_ID,
        revisionTypeId: EDIT_TYPE_ID,
        createdAt: T0,
        deletedAt: null,
      },
      {
        id: 'edit-2',
        developmentPlanId: PLAN_ID,
        revisionTypeId: EDIT_TYPE_ID,
        createdAt: T2,
        deletedAt: null,
      },
    ];
    const manager = makeManager(revisions, []);

    await expect(
      service.hasNewerRevision('edit-1', 'development_plan_revision', manager),
    ).resolves.toBe(true);
    await expect(
      service.assertEditable('edit-1', 'development_plan_revision', manager),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.assertEditable('edit-1', 'development_plan_revision', manager),
    ).rejects.toMatchObject({
      message: expect.stringContaining(BOOK_HAS_NEWER_REVISION),
    });
  });

  /**
   * Regression 2 (W116-BE-02): supplement-vs-revision is NO LONGER
   * cross-type locked. Supplements and revisions are parallel siblings
   * — neither category locks the other in either direction.
   * Project-level dedup is enforced via `assertProjectsNotInSiblingBook`
   * at the book-assembly layer against COMPLETED versions, not via
   * book-lineage lock.
   */
  it('newer supplement does NOT lock older revision (parallel siblings)', async () => {
    const T0 = new Date('2026-05-01T10:00:00Z');
    const T1 = new Date('2026-05-05T10:00:00Z');
    const revisions: RevisionFixture[] = [
      {
        id: 'edit-1',
        developmentPlanId: PLAN_ID,
        revisionTypeId: EDIT_TYPE_ID,
        createdAt: T0,
        deletedAt: null,
      },
    ];
    const supplements: SupplementFixture[] = [
      {
        id: 'supp-1',
        developmentPlanId: PLAN_ID,
        createdAt: T1,
        deletedAt: null,
      },
    ];
    const manager = makeManager(revisions, supplements);

    // Revision NOT locked by newer supplement (cross-category parallel).
    await expect(
      service.hasNewerRevision('edit-1', 'development_plan_revision', manager),
    ).resolves.toBe(false);
    // Supplement itself has no newer supplement → unlocked.
    await expect(
      service.hasNewerRevision(
        'supp-1',
        'development_plan_supplement',
        manager,
      ),
    ).resolves.toBe(false);
  });

  /**
   * Regression 3: §15.4 plan-level lock untouched. A plan with ANY
   * non-soft-deleted child is locked, regardless of child type.
   */
  it('DevelopmentPlan with ANY child IS locked (plan-level §15.4)', async () => {
    const T1 = new Date('2026-05-05T10:00:00Z');
    const revisions: RevisionFixture[] = [
      {
        id: 'edit-1',
        developmentPlanId: PLAN_ID,
        revisionTypeId: EDIT_TYPE_ID,
        createdAt: T1,
        deletedAt: null,
      },
    ];
    const manager = makeManager(revisions, []);

    await expect(
      service.hasNewerRevision(PLAN_ID, 'development_plan', manager),
    ).resolves.toBe(true);

    // No children → unlocked.
    const emptyManager = makeManager([], []);
    await expect(
      service.hasNewerRevision(PLAN_ID, 'development_plan', emptyManager),
    ).resolves.toBe(false);
  });

  /**
   * Sanity: soft-deleted siblings are ignored.
   */
  it('soft-deleted siblings do NOT lock (unchanged)', async () => {
    const T0 = new Date('2026-05-01T10:00:00Z');
    const T2 = new Date('2026-05-10T10:00:00Z');
    const revisions: RevisionFixture[] = [
      {
        id: 'edit-1',
        developmentPlanId: PLAN_ID,
        revisionTypeId: EDIT_TYPE_ID,
        createdAt: T0,
        deletedAt: null,
      },
      {
        id: 'edit-2-soft-deleted',
        developmentPlanId: PLAN_ID,
        revisionTypeId: EDIT_TYPE_ID,
        createdAt: T2,
        deletedAt: new Date('2026-05-11T10:00:00Z'),
      },
    ];
    const manager = makeManager(revisions, []);

    await expect(
      service.hasNewerRevision('edit-1', 'development_plan_revision', manager),
    ).resolves.toBe(false);
  });
});
