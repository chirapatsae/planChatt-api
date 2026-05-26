import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  BookLockService,
  BOOK_HAS_NEWER_REVISION,
} from './book-lock.service';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';

/**
 * wave-lineage-linear-chain-by-bookedAt / BE-01 — Linear-Chain Book
 * Lineage Lock (Model A revert).
 *
 * Verifies that `BookLockService.hasNewerRevision` orders the
 * revision/supplement sibling chain by `bookedAt` across BOTH categories
 * (cross-category linear chain). The previous W116 parallel-siblings
 * per-revisionType partition is reverted.
 *
 * Invariants verified:
 *   - Drafts (`bookedAt IS NULL`) are NOT in the §15 lock chain — a
 *     draft self always reports unlocked, and a draft sibling never
 *     locks a booked self.
 *   - Cross-category lock: a booked revision locks an older booked
 *     supplement and vice versa.
 *   - Strict `>` comparison — equal `bookedAt` peers do NOT lock each
 *     other.
 *   - Soft-deleted siblings (`deleted_at IS NOT NULL`) do NOT lock.
 *   - Plan-level predicate unchanged — any non-soft-deleted child
 *     (draft or booked, any category) locks the plan.
 *
 * Approach: in-memory fixture set + a fake EntityManager whose
 * `getRepository().createQueryBuilder()` chain executes the WHERE-style
 * predicates against the fixture array. This isolates the
 * linear-chain-by-bookedAt predicate change without requiring a live
 * Postgres instance.
 */

const PLAN_ID = 'plan-1';

interface RevisionFixture {
  id: string;
  developmentPlanId: string;
  bookedAt: Date | null;
  deletedAt: Date | null;
  [key: string]: unknown;
}

interface SupplementFixture {
  id: string;
  developmentPlanId: string;
  bookedAt: Date | null;
  deletedAt: Date | null;
  [key: string]: unknown;
}

interface QueryFilters {
  planId?: string;
  ownBookedAt?: Date;
  excludeId?: string;
  byId?: string;
  bookedAtNotNull?: boolean;
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
    if (sql.includes('bookedAt > :ownBookedAt') && params) {
      filters.ownBookedAt = params.ownBookedAt as Date;
    }
    if (sql.includes('bookedAt IS NOT NULL')) {
      filters.bookedAtNotNull = true;
    }
    if (sql.includes('<> :selfId') && params) {
      filters.excludeId = params.selfId as string;
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
        if (filters.bookedAtNotNull && r.bookedAt === null) {
          return false;
        }
        if (filters.ownBookedAt !== undefined) {
          if (r.bookedAt === null) return false;
          if (!(r.bookedAt > filters.ownBookedAt)) return false;
        }
        if (filters.excludeId !== undefined && r.id === filters.excludeId) {
          return false;
        }
        return true;
      });

      if (matched.length === 0) return undefined;
      const row = matched[0] as unknown as RevisionFixture;
      // Reproduce the raw shape BookLockService.loadLineageContext reads.
      return {
        r_id: row.id,
        r_booked_at: row.bookedAt,
        s_id: row.id,
        s_booked_at: row.bookedAt,
        planId: row.developmentPlanId,
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

describe('BookLockService — linear-chain-by-bookedAt (Model A)', () => {
  let service: BookLockService;

  beforeEach(() => {
    service = new BookLockService();
  });

  /**
   * Cross-category lock #1: a booked supplement strictly newer than an
   * older booked revision LOCKS the revision. Reverts the W116
   * parallel-siblings behavior — categories now share ONE timeline.
   */
  it('booked supplement (newer bookedAt) locks older booked revision', async () => {
    const T0 = new Date('2026-05-01T10:00:00Z');
    const T1 = new Date('2026-05-05T10:00:00Z');
    const revisions: RevisionFixture[] = [
      { id: 'rev-1', developmentPlanId: PLAN_ID, bookedAt: T0, deletedAt: null },
    ];
    const supplements: SupplementFixture[] = [
      { id: 'supp-1', developmentPlanId: PLAN_ID, bookedAt: T1, deletedAt: null },
    ];
    const manager = makeManager(revisions, supplements);

    await expect(
      service.hasNewerRevision('rev-1', 'development_plan_revision', manager),
    ).resolves.toBe(true);
    await expect(
      service.assertEditable('rev-1', 'development_plan_revision', manager),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.assertEditable('rev-1', 'development_plan_revision', manager),
    ).rejects.toMatchObject({
      message: expect.stringContaining(BOOK_HAS_NEWER_REVISION),
    });
  });

  /**
   * Cross-category lock #2 (mirror): a booked revision strictly newer
   * than an older booked supplement LOCKS the supplement.
   */
  it('booked revision (newer bookedAt) locks older booked supplement', async () => {
    const T0 = new Date('2026-05-01T10:00:00Z');
    const T1 = new Date('2026-05-05T10:00:00Z');
    const revisions: RevisionFixture[] = [
      { id: 'rev-1', developmentPlanId: PLAN_ID, bookedAt: T1, deletedAt: null },
    ];
    const supplements: SupplementFixture[] = [
      { id: 'supp-1', developmentPlanId: PLAN_ID, bookedAt: T0, deletedAt: null },
    ];
    const manager = makeManager(revisions, supplements);

    await expect(
      service.hasNewerRevision('supp-1', 'development_plan_supplement', manager),
    ).resolves.toBe(true);
  });

  /**
   * Same-category lock STILL works: newer booked revision locks older
   * booked revision (this case did not change in Model A, but it
   * remains a critical regression check).
   */
  it('newer booked revision locks older booked revision (same category)', async () => {
    const T0 = new Date('2026-05-01T10:00:00Z');
    const T1 = new Date('2026-05-10T10:00:00Z');
    const revisions: RevisionFixture[] = [
      { id: 'rev-1', developmentPlanId: PLAN_ID, bookedAt: T0, deletedAt: null },
      { id: 'rev-2', developmentPlanId: PLAN_ID, bookedAt: T1, deletedAt: null },
    ];
    const manager = makeManager(revisions, []);

    await expect(
      service.hasNewerRevision('rev-1', 'development_plan_revision', manager),
    ).resolves.toBe(true);
    // The strictly-newer one itself is not locked by anyone.
    await expect(
      service.hasNewerRevision('rev-2', 'development_plan_revision', manager),
    ).resolves.toBe(false);
  });

  /**
   * Draft self is NOT in the §15 lock chain — even if newer booked
   * siblings exist, a draft target reports unlocked. Drafts are
   * governed by other gates (`isOpen`, plan-phase scope).
   */
  it('draft self (bookedAt = null) is NOT in the lock chain', async () => {
    const T1 = new Date('2026-05-10T10:00:00Z');
    const revisions: RevisionFixture[] = [
      // Draft target — no bookedAt yet.
      { id: 'rev-draft', developmentPlanId: PLAN_ID, bookedAt: null, deletedAt: null },
      // Newer booked sibling that would normally lock.
      { id: 'rev-booked', developmentPlanId: PLAN_ID, bookedAt: T1, deletedAt: null },
    ];
    const manager = makeManager(revisions, []);

    await expect(
      service.hasNewerRevision('rev-draft', 'development_plan_revision', manager),
    ).resolves.toBe(false);
    await expect(
      service.assertEditable('rev-draft', 'development_plan_revision', manager),
    ).resolves.toBeUndefined();
  });

  /**
   * Draft sibling does NOT lock a booked self. A later-created but
   * still-unbooked sibling is not in the published lineage chain.
   */
  it('draft sibling (bookedAt = null) does NOT lock booked self', async () => {
    const T0 = new Date('2026-05-01T10:00:00Z');
    const revisions: RevisionFixture[] = [
      { id: 'rev-1', developmentPlanId: PLAN_ID, bookedAt: T0, deletedAt: null },
    ];
    const supplements: SupplementFixture[] = [
      // Draft supplement created later — must NOT lock the booked
      // revision because it is not in the chain.
      { id: 'supp-draft', developmentPlanId: PLAN_ID, bookedAt: null, deletedAt: null },
    ];
    const manager = makeManager(revisions, supplements);

    await expect(
      service.hasNewerRevision('rev-1', 'development_plan_revision', manager),
    ).resolves.toBe(false);
  });

  /**
   * Strict `>` comparison — equal `bookedAt` peers do NOT lock each
   * other. This handles the backfill edge case where pre-assembly
   * historical books may have equal timestamps.
   */
  it('equal-bookedAt peers do NOT lock each other (strict >)', async () => {
    const T = new Date('2026-05-05T10:00:00Z');
    const revisions: RevisionFixture[] = [
      { id: 'rev-a', developmentPlanId: PLAN_ID, bookedAt: T, deletedAt: null },
    ];
    const supplements: SupplementFixture[] = [
      { id: 'supp-a', developmentPlanId: PLAN_ID, bookedAt: T, deletedAt: null },
    ];
    const manager = makeManager(revisions, supplements);

    await expect(
      service.hasNewerRevision('rev-a', 'development_plan_revision', manager),
    ).resolves.toBe(false);
    await expect(
      service.hasNewerRevision('supp-a', 'development_plan_supplement', manager),
    ).resolves.toBe(false);
  });

  /**
   * Soft-deleted siblings do NOT contribute to the lock — per §15.7,
   * `deleted_at IS NOT NULL` rows are dead and the parent is
   * automatically unlocked when its last live descendant disappears.
   */
  it('soft-deleted newer sibling does NOT lock', async () => {
    const T0 = new Date('2026-05-01T10:00:00Z');
    const T2 = new Date('2026-05-10T10:00:00Z');
    const revisions: RevisionFixture[] = [
      { id: 'rev-1', developmentPlanId: PLAN_ID, bookedAt: T0, deletedAt: null },
      {
        id: 'rev-soft',
        developmentPlanId: PLAN_ID,
        bookedAt: T2,
        deletedAt: new Date('2026-05-11T10:00:00Z'),
      },
    ];
    const manager = makeManager(revisions, []);

    await expect(
      service.hasNewerRevision('rev-1', 'development_plan_revision', manager),
    ).resolves.toBe(false);
  });

  /**
   * §15.3 plan-level lock UNCHANGED: a plan with ANY non-soft-deleted
   * child (draft or booked, any category) is locked. This is broader
   * than the child predicate by design.
   */
  it('DevelopmentPlan with ANY child IS locked (plan-level §15.3)', async () => {
    const T = new Date('2026-05-05T10:00:00Z');
    // Even a DRAFT revision locks the plan.
    const revisions: RevisionFixture[] = [
      { id: 'rev-draft', developmentPlanId: PLAN_ID, bookedAt: null, deletedAt: null },
    ];
    const manager = makeManager(revisions, []);

    await expect(
      service.hasNewerRevision(PLAN_ID, 'development_plan', manager),
    ).resolves.toBe(true);

    // Booked supplement also locks the plan.
    const supplementsOnly = makeManager([], [
      { id: 'supp-1', developmentPlanId: PLAN_ID, bookedAt: T, deletedAt: null },
    ]);
    await expect(
      service.hasNewerRevision(PLAN_ID, 'development_plan', supplementsOnly),
    ).resolves.toBe(true);

    // No children → unlocked.
    const emptyManager = makeManager([], []);
    await expect(
      service.hasNewerRevision(PLAN_ID, 'development_plan', emptyManager),
    ).resolves.toBe(false);
  });

  /**
   * W116 partition behavior REVERTED: edit-revision and change-revision
   * are no longer parallel siblings. A booked change-revision strictly
   * newer than a booked edit-revision LOCKS the edit-revision.
   *
   * Note: with bookedAt-ordering and no revisionType partition, this
   * test is structurally identical to the "newer booked revision locks
   * older booked revision" case above — but kept explicit to document
   * the W116 reversion intent.
   */
  it('booked change-revision (newer bookedAt) locks booked edit-revision (W116 reverted)', async () => {
    const T_EDIT = new Date('2026-05-01T10:00:00Z');
    const T_CHANGE = new Date('2026-05-05T10:00:00Z');
    const revisions: RevisionFixture[] = [
      { id: 'edit-1', developmentPlanId: PLAN_ID, bookedAt: T_EDIT, deletedAt: null },
      { id: 'change-1', developmentPlanId: PLAN_ID, bookedAt: T_CHANGE, deletedAt: null },
    ];
    const manager = makeManager(revisions, []);

    await expect(
      service.hasNewerRevision('edit-1', 'development_plan_revision', manager),
    ).resolves.toBe(true);
    await expect(
      service.hasNewerRevision('change-1', 'development_plan_revision', manager),
    ).resolves.toBe(false);
  });
});
