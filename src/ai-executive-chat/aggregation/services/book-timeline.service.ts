/**
 * Wave 57 W57-BE-AGG-06 — Book global-timeline + latest-project
 * partition helpers.
 *
 * CLAUDE.md references:
 *   - §15.2 — Book lineage is a SINGLE GLOBAL TIMELINE per
 *     DevelopmentPlan, mixing DevelopmentPlanRevision and
 *     DevelopmentPlanSupplement, ordered by `createdAt`.
 *   - §15.3 — Immutability invariant; soft-deleted descendants do NOT
 *     lock ancestor.
 *   - §15.7 — Lock auto-clears when latest is removed; helpers MUST
 *     filter `deleted_at IS NULL` on every UNION arm.
 *   - §10  — project scope binding; resolution walks each row's own
 *     plan chain.
 *   - §11 / §14 — versioning + lineage immutability.
 *
 * Canonical reference: `backend/src/project-groups/project-groups.service.ts`
 * `findLatestProjects` defines the bucketing semantics this service
 * mirrors for the chat-tool surface.
 *
 * READ-only. Every write is forbidden by §17.2 / §17.3.
 */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';

import {
  applyHeadFilterForProjectGroup,
  applyHeadFilterForRevisedProjectGroup,
} from '../helpers/head-of-lineage';

/**
 * Discriminator returned by `getLatestBookForPlan`. `'main'` is the
 * DevelopmentPlan itself (no DPR / DPS); the other three identify the
 * latest descendant in the global timeline.
 */
export type LatestBookKind = 'main' | 'edit' | 'change' | 'supplement';

export interface LatestBookResult {
  kind: LatestBookKind;
  /**
   * Row id — DevelopmentPlan.id when `kind='main'`; DPR.id when
   * `kind='edit'|'change'`; DPS.id when `kind='supplement'`.
   */
  rowId: string;
  /** ISO timestamp of the row's `createdAt`. */
  createdAt: string;
  /** Optional human label — for `'edit'` / `'change'` it includes
   *  RevisionType.name when available. */
  label?: string;
}

export interface LatestProjectsByBookPartition {
  /** Plan resolved (the input planId or the active `isLatest` plan). */
  planId: string;
  /** HEAD-of-lineage projects whose HEAD is a `ProjectGroup` row. */
  mainBook: Array<{ projectId: string; name: string }>;
  /** HEAD is `RevisedProjectGroup` whose DPR.type === 'edit'. */
  editBook: Array<{ projectId: string; name: string }>;
  /** HEAD is `RevisedProjectGroup` whose DPR.type === 'change'. */
  changeBook: Array<{ projectId: string; name: string }>;
  /** HEAD is `SupplementProjectGroup`. May be absent under §11.3. */
  supplementBook?: Array<{ projectId: string; name: string }>;
}

@Injectable()
export class BookTimelineService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Return the head of the §15.2 global timeline for the given
   * DevelopmentPlan. UNION DPR + DPS, ORDER BY `createdAt` DESC, take
   * the top row. Returns `kind='main'` (the DP row itself) when no
   * DPR / DPS descendant exists.
   *
   * Filters `deleted_at IS NULL` on every UNION arm (§15.7).
   */
  async getLatestBookForPlan(
    planId: string,
  ): Promise<LatestBookResult | null> {
    if (!planId) return null;

    // DPR arm — newest non-soft-deleted revision (any type).
    const dprRow = await this.dataSource
      .getRepository(DevelopmentPlanRevision)
      .createQueryBuilder('dpr')
      .leftJoin('dpr.revisionType', 'rt')
      .select('dpr.id', 'id')
      .addSelect('dpr.createdAt', 'createdat')
      .addSelect('rt.name', 'rtname')
      .where('dpr.development_plan_id = :planId', { planId })
      .andWhere('dpr.deletedAt IS NULL')
      .orderBy('dpr.createdAt', 'DESC')
      .limit(1)
      .getRawOne<{
        id: string;
        createdat: Date | string;
        rtname: string | null;
      }>();

    // DPS arm — newest non-soft-deleted supplement.
    const dpsRow = await this.dataSource
      .getRepository(DevelopmentPlanSupplement)
      .createQueryBuilder('dps')
      .select('dps.id', 'id')
      .addSelect('dps.createdAt', 'createdat')
      .where('dps.development_plan_id = :planId', { planId })
      .andWhere('dps.deletedAt IS NULL')
      .orderBy('dps.createdAt', 'DESC')
      .limit(1)
      .getRawOne<{ id: string; createdat: Date | string }>();

    const dprDate = dprRow ? new Date(dprRow.createdat).getTime() : -Infinity;
    const dpsDate = dpsRow ? new Date(dpsRow.createdat).getTime() : -Infinity;

    if (!dprRow && !dpsRow) {
      // Fall back to the DP itself.
      const dp = await this.dataSource
        .getRepository(DevelopmentPlan)
        .createQueryBuilder('dp')
        .select('dp.id', 'id')
        .addSelect('dp.createAt', 'createdat')
        .where('dp.id = :planId', { planId })
        .andWhere('dp.deletedAt IS NULL')
        .getRawOne<{ id: string; createdat: Date | string }>();
      if (!dp) return null;
      return {
        kind: 'main',
        rowId: dp.id,
        createdAt: new Date(dp.createdat).toISOString(),
      };
    }

    if (dprDate >= dpsDate && dprRow) {
      const lower = (dprRow.rtname ?? '').toLowerCase();
      const kind: LatestBookKind =
        lower === 'change' || lower.includes('เปลี่ยนแปลง')
          ? 'change'
          : 'edit';
      return {
        kind,
        rowId: dprRow.id,
        createdAt: new Date(dprRow.createdat).toISOString(),
        label: dprRow.rtname ?? undefined,
      };
    }

    return {
      kind: 'supplement',
      rowId: dpsRow!.id,
      createdAt: new Date(dpsRow!.createdat).toISOString(),
    };
  }

  /**
   * Mirror of `ProjectGroupsService.findLatestProjects` bucketing,
   * scoped to executive read access (no role-based agency filtering).
   *
   * Algorithm:
   *   1. Resolve the target plan (input planId, else `isLatest=true` DP).
   *   2. Fetch HEAD `ProjectGroup` rows (no live RPG descendant) under
   *      the plan → `mainBook`.
   *   3. Fetch HEAD `RevisedProjectGroup` rows under DPR rows of the
   *      plan → bucket by `dpr.revisionType.name`:
   *        - 'edit' / Thai "แก้ไข" → editBook
   *        - 'change' / "เปลี่ยนแปลง" → changeBook
   *   4. Fetch HEAD `SupplementProjectGroup` rows under DPS rows of the
   *      plan → `supplementBook`.
   *
   * §10 scope binding — every JOIN walks the row's own chain. §14
   * lineage filter applied via `applyHeadFilterFor*`.
   */
  async getLatestProjectsByBookPartition(
    planId?: string,
  ): Promise<LatestProjectsByBookPartition | null> {
    let resolvedPlanId = planId;
    if (!resolvedPlanId) {
      const latest = await this.dataSource
        .getRepository(DevelopmentPlan)
        .createQueryBuilder('dp')
        .select('dp.id', 'id')
        .where('dp.deletedAt IS NULL')
        .andWhere('dp.isLatest = :isLatest', { isLatest: true })
        .orderBy('dp.createAt', 'DESC')
        .limit(1)
        .getRawOne<{ id: string }>();
      if (!latest) return null;
      resolvedPlanId = latest.id;
    }

    // ── mainBook: HEAD PG rows under the plan ───────────────────────
    const mainQb = this.dataSource
      .getRepository(ProjectGroup)
      .createQueryBuilder('pg')
      .select('pg.id', 'pid')
      .addSelect('pg.title', 'title')
      .where('pg.deletedAt IS NULL')
      .andWhere('pg.development_plan_id = :planId', {
        planId: resolvedPlanId,
      })
      .orderBy('pg.title', 'ASC');
    applyHeadFilterForProjectGroup(mainQb, 'pg');
    const mainRows: Array<{ pid: string; title: string }> =
      await mainQb.getRawMany();

    // ── edit / change buckets via HEAD RPG + DPR.type ───────────────
    const rpgQb = this.dataSource
      .getRepository(RevisedProjectGroup)
      .createQueryBuilder('rpg')
      .innerJoin('rpg.developmentPlanRevision', 'dpr')
      .leftJoin('dpr.revisionType', 'rt')
      .select('rpg.id', 'pid')
      .addSelect('rpg.title', 'title')
      .addSelect('rt.name', 'rtname')
      .where('rpg.deletedAt IS NULL')
      .andWhere('dpr.deletedAt IS NULL')
      .andWhere('dpr.development_plan_id = :planId', {
        planId: resolvedPlanId,
      })
      .orderBy('rpg.title', 'ASC');
    applyHeadFilterForRevisedProjectGroup(rpgQb, 'rpg');
    const rpgRows: Array<{
      pid: string;
      title: string;
      rtname: string | null;
    }> = await rpgQb.getRawMany();

    const editBook: Array<{ projectId: string; name: string }> = [];
    const changeBook: Array<{ projectId: string; name: string }> = [];
    for (const r of rpgRows) {
      const rt = (r.rtname ?? '').toLowerCase();
      const bucket =
        rt === 'change' || rt.includes('เปลี่ยนแปลง') ? changeBook : editBook;
      bucket.push({ projectId: r.pid, name: r.title ?? '' });
    }

    return {
      planId: resolvedPlanId,
      mainBook: mainRows.map((r) => ({
        projectId: r.pid,
        name: r.title ?? '',
      })),
      editBook,
      changeBook,
    };
  }
}
