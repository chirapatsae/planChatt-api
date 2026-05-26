import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';

/**
 * Book-lineage target discriminator used by BookLockService.
 *
 * - 'development_plan' targets a DevelopmentPlan (root book) row. Its
 *   children are any non-soft-deleted DevelopmentPlanRevision OR
 *   DevelopmentPlanSupplement rows referencing the plan. The plan is
 *   locked as soon as ANY child exists (draft or booked, any type).
 *
 * - 'development_plan_revision' targets a DevelopmentPlanRevision row. It
 *   is locked iff ANY strictly-newer (by `bookedAt`) non-soft-deleted,
 *   booked (`bookedAt IS NOT NULL`) sibling child of the same plan exists,
 *   across BOTH revisions and supplements. Drafts (`bookedAt IS NULL`) do
 *   NOT participate in the lock chain — they are governed by `isOpen` and
 *   plan-phase scope, not §15. See CLAUDE.md §15.2 / §15.3 / §15.7 /
 *   wave-lineage-linear-chain-by-bookedAt (LINEAR CHAIN ACROSS CATEGORIES,
 *   ordered by `bookedAt`).
 *
 * - 'development_plan_supplement' targets a DevelopmentPlanSupplement row.
 *   Same linear-chain-by-bookedAt semantics as 'development_plan_revision'.
 */
export type BookLockTarget =
  | 'development_plan'
  | 'development_plan_revision'
  | 'development_plan_supplement';

/**
 * Canonical error code prefix thrown when a book artifact has a
 * non-soft-deleted strictly-newer-booked sibling and therefore cannot be
 * mutated or deleted (CLAUDE.md §15). Frontend (`frontend/src/api/axios.tsx`)
 * and integration tests rely on this exact string prefix.
 */
export const BOOK_HAS_NEWER_REVISION = 'BOOK_HAS_NEWER_REVISION';

/**
 * BookLockService
 *
 * Single source of truth for the Book Lineage Immutability invariant
 * defined in CLAUDE.md §15. A book artifact row A is locked
 * (non-editable, non-deletable) if and only if there exists any
 * non-soft-deleted strictly-newer-booked sibling child of its containing
 * plan, across BOTH `development_plan_revision` and
 * `development_plan_supplement` tables. Ordering is by `booked_at` —
 * NOT `created_at` — so the lock chain reflects the actual published
 * book timeline, not draft creation order.
 *
 * Drafts (`booked_at IS NULL`) are excluded from the chain on both ends:
 *   - A draft self always returns `false` (drafts are not in the chain).
 *   - A draft sibling never locks a booked self (draft `booked_at` is NULL).
 *
 * The service is stateless, transaction-aware (accepts an EntityManager so
 * it participates in the caller's transaction), and role-agnostic. There
 * is NO staff-lead exemption — per §15.6, all roles (including
 * super-admin) obey the lock.
 *
 * Detection is LIVE — there is no cached `is_frozen` column. The column
 * was dropped by migration `1744588800000-DropDevelopmentPlanIsFrozen`
 * and MUST NOT be reintroduced.
 *
 * Transaction safety: every query is issued through the supplied
 * `EntityManager`, so when a caller runs the guard inside
 * `dataSource.transaction(...)`, the guard reads the same snapshot as
 * the subsequent write and the combined effect is atomic with respect
 * to the current transaction's isolation level. Cross-transaction race
 * conditions (two transactions simultaneously inserting a newer child)
 * are acknowledged as non-atomic — see §14 precedent.
 */
@Injectable()
export class BookLockService {
  private readonly logger = new Logger(BookLockService.name);

  /**
   * Returns true when the target book artifact has at least one
   * non-soft-deleted strictly-newer-booked sibling child (or any child,
   * in the case of DevelopmentPlan). Uses linear-chain-by-bookedAt
   * detection across BOTH `development_plan_revision` and
   * `development_plan_supplement` for revision/supplement targets — see
   * CLAUDE.md §15.2 (post-wave-lineage-linear-chain-by-bookedAt rewrite).
   */
  async hasNewerRevision(
    id: string,
    target: BookLockTarget,
    manager: EntityManager,
  ): Promise<boolean> {
    if (!id) return false;

    if (target === 'development_plan') {
      return this.hasAnyChildForPlan(id, manager);
    }

    const ctx = await this.loadLineageContext(id, target, manager);
    if (!ctx) {
      // Row does not exist or is soft-deleted; treat as unlocked so the
      // caller's own NotFound handler runs. Do NOT throw here — the
      // service is a pure integrity check, not a validation gate.
      return false;
    }

    // Drafts are NOT in the §15 lock chain — they are governed by other
    // gates (`isOpen`, plan-phase scope). A draft self always reports
    // unlocked even if newer booked siblings exist.
    if (ctx.bookedAt === null) return false;

    return this.hasStrictlyNewerBookedSibling(
      ctx.developmentPlanId,
      ctx.bookedAt,
      ctx.selfId,
      manager,
    );
  }

  /**
   * Throws ConflictException with the canonical BOOK_HAS_NEWER_REVISION
   * error code when the target row is locked. Must be called BEFORE any
   * repository mutation (CLAUDE.md §15.3, §15.7).
   */
  async assertEditable(
    id: string,
    target: BookLockTarget,
    manager: EntityManager,
  ): Promise<void> {
    const locked = await this.hasNewerRevision(id, target, manager);
    if (locked) {
      throw new ConflictException(
        `${BOOK_HAS_NEWER_REVISION}: ไม่สามารถแก้ไขเล่มนี้ได้ เนื่องจากมีเล่มเวอร์ชันใหม่กว่าแล้ว (CLAUDE.md §15)`,
      );
    }
  }

  /**
   * Throws ConflictException with the canonical BOOK_HAS_NEWER_REVISION
   * error code when the target row is locked. Must be called BEFORE any
   * repository delete / softDelete / restore (CLAUDE.md §15.3, §15.7).
   *
   * Kept as a distinct method from assertEditable so either can be relaxed
   * independently in the future without a refactor — mirrors the
   * LineageLockService (§14) shape.
   */
  async assertDeletable(
    id: string,
    target: BookLockTarget,
    manager: EntityManager,
  ): Promise<void> {
    const locked = await this.hasNewerRevision(id, target, manager);
    if (locked) {
      throw new ConflictException(
        `${BOOK_HAS_NEWER_REVISION}: ไม่สามารถลบเล่มนี้ได้ เนื่องจากมีเล่มเวอร์ชันใหม่กว่าแล้ว (CLAUDE.md §15)`,
      );
    }
  }

  // -------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------

  /**
   * DevelopmentPlan lock predicate — returns true if the plan has ANY
   * non-soft-deleted child (revision OR supplement). Draft children count
   * exactly the same as booked children per §15.1 — the plan-level
   * predicate is intentionally broader than the revision/supplement-level
   * predicate, because §15.3 plan-blocked-operation semantics require
   * locking the plan the moment ANY descendant exists.
   */
  private async hasAnyChildForPlan(
    planId: string,
    manager: EntityManager,
  ): Promise<boolean> {
    const [revisionExists, supplementExists] = await Promise.all([
      manager.exists(DevelopmentPlanRevision, {
        where: { developmentPlan: { id: planId } },
      }),
      manager.exists(DevelopmentPlanSupplement, {
        where: { developmentPlan: { id: planId } },
      }),
    ]);
    return revisionExists || supplementExists;
  }

  /**
   * Loads the (developmentPlanId, bookedAt, selfId) tuple for a revision
   * or supplement target. Returns null if the row does not exist or is
   * soft-deleted.
   *
   * Post-wave-lineage-linear-chain-by-bookedAt: reads `bookedAt` instead of
   * `createdAt`, and drops the previous `revisionType` join entirely —
   * the revised predicate scans ALL siblings under the same plan
   * regardless of category, so per-type partitioning is no longer
   * needed.
   */
  private async loadLineageContext(
    id: string,
    target: Exclude<BookLockTarget, 'development_plan'>,
    manager: EntityManager,
  ): Promise<{
    developmentPlanId: string;
    bookedAt: Date | null;
    selfId: string;
  } | null> {
    if (target === 'development_plan_revision') {
      // TypeORM auto-applies `deleted_at IS NULL` for @DeleteDateColumn
      // entities on the primary alias, so we do not need to add it
      // explicitly here. The join is only used to pull the plan id —
      // the plan row itself is never inspected for soft-delete state
      // because the invariant is "does this revision have a newer
      // sibling in the plan", not "is the plan alive".
      const row = await manager
        .getRepository(DevelopmentPlanRevision)
        .createQueryBuilder('r')
        .select(['r.id', 'r.bookedAt'])
        .leftJoin('r.developmentPlan', 'plan')
        .addSelect('plan.id', 'planId')
        .where('r.id = :id', { id })
        .getRawOne<{
          r_id: string;
          r_booked_at: Date | null;
          planId: string | null;
        }>();

      if (!row || !row.planId) return null;
      return {
        developmentPlanId: row.planId,
        bookedAt: row.r_booked_at ?? null,
        selfId: row.r_id,
      };
    }

    // development_plan_supplement
    const row = await manager
      .getRepository(DevelopmentPlanSupplement)
      .createQueryBuilder('s')
      .select(['s.id', 's.bookedAt'])
      .leftJoin('s.developmentPlan', 'plan')
      .addSelect('plan.id', 'planId')
      .where('s.id = :id', { id })
      .getRawOne<{
        s_id: string;
        s_booked_at: Date | null;
        planId: string | null;
      }>();

    if (!row || !row.planId) return null;
    return {
      developmentPlanId: row.planId,
      bookedAt: row.s_booked_at ?? null,
      selfId: row.s_id,
    };
  }

  /**
   * Linear-chain-by-bookedAt "strictly newer booked sibling" predicate.
   *
   * Returns true when ANY non-soft-deleted, booked (`bookedAt IS NOT NULL`)
   * row in either `development_plan_revision` or
   * `development_plan_supplement` belongs to the same plan and has
   * `bookedAt > ownBookedAt` (excluding the target row itself).
   *
   * Cross-category by design — a booked supplement locks an older booked
   * revision and vice versa. Equal-bookedAt peers are treated as
   * concurrent peers (strict `>` comparison ensures ties are NOT locks).
   *
   * Implementation note: TypeORM auto-applies the soft-delete filter
   * (`deleted_at IS NULL`) on the primary alias of a `@DeleteDateColumn`
   * entity, so we do not add it explicitly here. The `bookedAt IS NOT
   * NULL` filter excludes draft siblings from the chain — drafts are
   * not in the published lineage.
   */
  private async hasStrictlyNewerBookedSibling(
    planId: string,
    ownBookedAt: Date,
    selfId: string,
    manager: EntityManager,
  ): Promise<boolean> {
    // Probe both child categories in parallel. Either match short-
    // circuits the lock decision. Each predicate translates to an
    // indexed lookup on `(development_plan_id, booked_at)` followed by
    // an in-memory timestamp comparison on the small per-plan subset
    // (<20 rows in practice — see DB-01 partial-index addition).
    const [newerRevision, newerSupplement] = await Promise.all([
      manager
        .getRepository(DevelopmentPlanRevision)
        .createQueryBuilder('r')
        .select('r.id')
        .leftJoin('r.developmentPlan', 'plan')
        .where('plan.id = :planId', { planId })
        .andWhere('r.bookedAt IS NOT NULL')
        .andWhere('r.bookedAt > :ownBookedAt', { ownBookedAt })
        .andWhere('r.id <> :selfId', { selfId })
        .limit(1)
        .getRawOne(),
      manager
        .getRepository(DevelopmentPlanSupplement)
        .createQueryBuilder('s')
        .select('s.id')
        .leftJoin('s.developmentPlan', 'plan')
        .where('plan.id = :planId', { planId })
        .andWhere('s.bookedAt IS NOT NULL')
        .andWhere('s.bookedAt > :ownBookedAt', { ownBookedAt })
        .andWhere('s.id <> :selfId', { selfId })
        .limit(1)
        .getRawOne(),
    ]);

    return !!newerRevision || !!newerSupplement;
  }
}
