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
 *   is locked iff ANY strictly-newer (by created_at) non-soft-deleted
 *   sibling child of the same plan exists, across BOTH revisions and
 *   supplements. This is the OQ-2=(B) "LINEAR ACROSS TYPES" / "GLOBAL
 *   TIMELINE" choice — see CLAUDE.md §15.2.
 *
 * - 'development_plan_supplement' targets a DevelopmentPlanSupplement row.
 *   Same global-timeline semantics as 'development_plan_revision'.
 */
export type BookLockTarget =
  | 'development_plan'
  | 'development_plan_revision'
  | 'development_plan_supplement';

/**
 * Canonical error code prefix thrown when a book artifact has a
 * non-soft-deleted newer child and therefore cannot be mutated or deleted
 * (CLAUDE.md §15). Frontend (`frontend/src/api/axios.tsx`) and integration
 * tests rely on this exact string prefix.
 */
export const BOOK_HAS_NEWER_REVISION = 'BOOK_HAS_NEWER_REVISION';

/**
 * BookLockService
 *
 * Single source of truth for the Book Lineage Immutability invariant
 * defined in CLAUDE.md §15. A book artifact row A is locked
 * (non-editable, non-deletable) if and only if there exists any
 * non-soft-deleted strictly-newer sibling child of its containing plan,
 * across BOTH `development_plan_revision` and `development_plan_supplement`
 * tables.
 *
 * The service is stateless, transaction-aware (accepts an EntityManager so
 * it participates in the caller's transaction), and role-agnostic. There
 * is NO staff-lead exemption — per §15.5, all roles (including
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
   * non-soft-deleted newer sibling child (or any child, in the case of
   * DevelopmentPlan). Uses global-timeline detection across BOTH
   * `development_plan_revision` and `development_plan_supplement` for
   * revision/supplement targets — see CLAUDE.md §15.2.
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

    // Load the target row's plan id + created_at so we can compare against
    // its siblings in the global timeline. We deliberately ignore the
    // target's artifact kind when scanning siblings — OQ-2=(B) global
    // lineage means a revision can lock a supplement and vice versa.
    const ctx = await this.loadLineageContext(id, target, manager);
    if (!ctx) {
      // Row does not exist or is soft-deleted; treat as unlocked so the
      // caller's own NotFound handler runs. Do NOT throw here — the
      // service is a pure integrity check, not a validation gate.
      return false;
    }

    return this.hasStrictlyNewerSibling(
      ctx.developmentPlanId,
      ctx.createdAt,
      ctx.selfId,
      target,
      manager,
      ctx.ownRevisionTypeId ?? null,
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
   * exactly the same as booked children per §15.1.
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
   * Loads the (developmentPlanId, createdAt, selfId) tuple for a revision
   * or supplement target. Returns null if the row does not exist or is
   * soft-deleted.
   */
  private async loadLineageContext(
    id: string,
    target: Exclude<BookLockTarget, 'development_plan'>,
    manager: EntityManager,
  ): Promise<{
    developmentPlanId: string;
    createdAt: Date;
    selfId: string;
    /**
     * Only populated for `development_plan_revision` targets. Used by
     * `hasStrictlyNewerSibling` to partition the revision-vs-revision
     * scan by `revisionType.id` so that edit-vs-change rounds are
     * treated as parallel siblings that do NOT lock each other
     * (W116-BE-01 / CLAUDE.md §15.2 partitioned-sibling refinement).
     * Null for supplement targets — supplements remain unified
     * cross-type per §15.2 unchanged behavior.
     */
    ownRevisionTypeId?: string | null;
  } | null> {
    if (target === 'development_plan_revision') {
      // TypeORM auto-applies `deleted_at IS NULL` for @DeleteDateColumn
      // entities on the primary alias, so we do not need to add it
      // explicitly here. The join is only used to pull the plan id —
      // the plan row itself is never inspected for soft-delete state
      // because the invariant is "does this revision have a newer
      // sibling in the plan", not "is the plan alive".
      //
      // We also pull `revisionType.id` so that downstream sibling
      // detection can partition revision-vs-revision by type — edit
      // rounds and change rounds are PARALLEL siblings per W116-BE-01,
      // even though supplement-vs-revision remains cross-type.
      const row = await manager
        .getRepository(DevelopmentPlanRevision)
        .createQueryBuilder('r')
        .select(['r.id', 'r.createdAt'])
        .leftJoin('r.developmentPlan', 'plan')
        .addSelect('plan.id', 'planId')
        .leftJoin('r.revisionType', 'rtype')
        .addSelect('rtype.id', 'revisionTypeId')
        .where('r.id = :id', { id })
        .getRawOne<{
          r_id: string;
          r_created_at: Date;
          planId: string | null;
          revisionTypeId: string | null;
        }>();

      if (!row || !row.planId) return null;
      return {
        developmentPlanId: row.planId,
        createdAt: row.r_created_at,
        selfId: row.r_id,
        ownRevisionTypeId: row.revisionTypeId ?? null,
      };
    }

    // development_plan_supplement
    const row = await manager
      .getRepository(DevelopmentPlanSupplement)
      .createQueryBuilder('s')
      .select(['s.id', 's.createdAt'])
      .leftJoin('s.developmentPlan', 'plan')
      .addSelect('plan.id', 'planId')
      .where('s.id = :id', { id })
      .getRawOne<{
        s_id: string;
        s_created_at: Date;
        planId: string | null;
      }>();

    if (!row || !row.planId) return null;
    return {
      developmentPlanId: row.planId,
      createdAt: row.s_created_at,
      selfId: row.s_id,
    };
  }

  /**
   * Global-timeline "strictly newer sibling" predicate.
   *
   * Returns true when ANY non-soft-deleted row in either
   * `development_plan_revision` or `development_plan_supplement` belongs
   * to the same plan and has `created_at > ownCreatedAt` (excluding the
   * target row itself).
   *
   * Implementation note: TypeORM's `MoreThan` operator compares on the
   * same column mapping used by the entity metadata, so we can use the
   * plain `where` shape without raw SQL. Each predicate translates to an
   * indexed lookup on `(development_plan_id)` followed by an in-memory
   * timestamp comparison on the small per-plan subset (<20 rows in
   * practice — see §15.2 index consideration).
   */
  private async hasStrictlyNewerSibling(
    planId: string,
    ownCreatedAt: Date,
    selfId: string,
    target: Exclude<BookLockTarget, 'development_plan'>,
    manager: EntityManager,
    ownRevisionTypeId: string | null,
  ): Promise<boolean> {
    // Scan development_plan_revision first — most plans have more
    // revisions than supplements in practice, so this short-circuits
    // the common case faster. TypeORM auto-applies the soft-delete
    // filter (deleted_at IS NULL) on the primary alias of a
    // @DeleteDateColumn entity, so we do not add it explicitly here.
    //
    // W116-BE-02 (forward-compat for supplement module) — all child
    // categories under a plan are now PARALLEL SIBLINGS:
    //   - Revision-vs-revision: partitioned by `revisionType.id`
    //     (edit / change / future types are independent timelines)
    //   - Supplement-vs-supplement: same-category timeline
    //   - Revision-vs-supplement: NO cross-category lock either
    //     direction
    // Project-level deduplication is enforced by
    // `assertProjectsNotInSiblingBook` at the book-assembly layer
    // against COMPLETED sibling versions, NOT via book-lineage lock.
    //
    // Implementation: when target is a revision, scan only revisions
    // of the same revisionType; when target is a supplement, scan
    // only supplements. Cross-category scans are dropped entirely.
    if (target === 'development_plan_revision') {
      const revisionQb = manager
        .getRepository(DevelopmentPlanRevision)
        .createQueryBuilder('r')
        .select('r.id')
        .leftJoin('r.developmentPlan', 'plan')
        .leftJoin('r.revisionType', 'rtype')
        .where('plan.id = :planId', { planId })
        .andWhere('r.createdAt > :ownCreatedAt', { ownCreatedAt })
        .andWhere('r.id <> :selfId', { selfId });
      // Type partitioning is generic — filter by whatever
      // revisionType the target carries. A NULL FK (should never
      // happen — column is non-nullable) falls through to the
      // pre-partition cross-type scan so §15 still holds.
      if (ownRevisionTypeId) {
        revisionQb.andWhere('rtype.id = :ownRevisionTypeId', {
          ownRevisionTypeId,
        });
      }
      const newerRevision = await revisionQb.limit(1).getRawOne();
      return !!newerRevision;
    }

    // target === 'development_plan_supplement'
    const supplementQb = manager
      .getRepository(DevelopmentPlanSupplement)
      .createQueryBuilder('s')
      .select('s.id')
      .leftJoin('s.developmentPlan', 'plan')
      .where('plan.id = :planId', { planId })
      .andWhere('s.createdAt > :ownCreatedAt', { ownCreatedAt })
      .andWhere('s.id <> :selfId', { selfId });
    const newerSupplement = await supplementQb.limit(1).getRawOne();
    return !!newerSupplement;
  }
}
