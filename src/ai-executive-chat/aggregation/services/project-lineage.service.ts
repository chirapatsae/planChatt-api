/**
 * Wave 61 — Mode 3 lineage tools (per-project HEAD lookup + full timeline).
 *
 * CLAUDE.md references:
 *   - §10  Project scope binding — every walk uses the row's own plan
 *     chain (no global lookup).
 *   - §11  Versioning Rule — RevisedProjectGroup is the only versioned
 *     surface; SPG is not part of the PG/RPG revision chain (§11.3).
 *   - §14.1 / §14.2 Lineage Definition + Immutability Invariant —
 *     HEAD-of-lineage is the row with NO non-deleted descendant. Forward
 *     traversal stops at the first row that has zero live RPG children
 *     referencing it via `(prev_project_id, prev_project_type)`.
 *   - §15.2 Global timeline — the per-step `bookLabel` resolution mirrors
 *     the timeline conventions used by `BookTimelineService`.
 *   - §17.2 Advisory-only — read-only; never gates a workflow transition.
 *   - §17.3 Read-only — no FK from ai_* into any project table; no writes.
 *   - §17.9 — every result field is server-authored; no user-controlled
 *     text reaches the LLM verbatim from this service.
 *
 * Wave 54 no-raw-SQL gate compatibility: every JOIN target is an entity
 * class; the lineage walk uses TypeORM `findOne` / `find` over entity
 * repositories. No raw table literals appear in the implementation.
 *
 * Implementation note — the lineage walk is iterative TypeORM N+1, NOT a
 * recursive CTE. CLAUDE.md §17.9 + the Wave 54 no-raw-SQL gate forbid
 * raw SQL inside this layer. Lineage depth is bounded in practice
 * (≤ ~10 chain steps for the foreseeable product surface), and a hard
 * `MAX_CHAIN_DEPTH` guard is wired in to defend against pathological
 * input (cycles or very long chains).
 */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';

import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { PrevProjectType } from 'src/revised-project-group/dto/create-revised-project-group.dto';

import {
  REVISION_ROUND_LABEL_MAIN,
  resolveRevisionRoundLabel,
  type RevisionRoundType,
} from '../constants/revision-round-label';

/**
 * Defensive ceiling for the lineage walk. Real-world chains are short
 * (<10 steps); a higher cap still costs < ~25 N+1 round trips and
 * protects against accidental cycles in legacy data.
 */
const MAX_CHAIN_DEPTH = 25;

export type LineageProjectKind = 'main' | 'revised' | 'supplement';
export type LineageBookType = 'main' | 'edit' | 'change' | 'supplement';

export interface ProjectHeadBookResult {
  projectId: string;
  headProjectId: string;
  headBookLabel: string;
  headBookType: LineageBookType;
  headRevisionNumber: number | null;
  headDprId: string | null;
  headDpsId: string | null;
  isInputHead: boolean;
  advisories: string[];
  asOf: string;
}

export interface ProjectLineageStep {
  projectId: string;
  projectKind: LineageProjectKind;
  bookLabel: string;
  bookType: LineageBookType;
  revisionNumber: number | null;
  dprId: string | null;
  dpsId: string | null;
  title: string;
  statusName: string | null;
  isHead: boolean;
  step: number;
}

export interface ProjectLineageResult {
  projectId: string;
  rootProjectId: string;
  headProjectId: string;
  chain: ProjectLineageStep[];
  asOf: string;
  advisories: string[];
}

interface ResolvedRow {
  kind: LineageProjectKind;
  pgRow?: ProjectGroup;
  rpgRow?: RevisedProjectGroup;
  spgRow?: SupplementProjectGroup;
}

@Injectable()
export class ProjectLineageService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  // ────────────────────────────────────────────────────────────────
  // Public API — Mode 3 tool 1: head-of-lineage book lookup
  // ────────────────────────────────────────────────────────────────

  /**
   * Resolve the HEAD-of-lineage book for the given project UUID.
   *
   * The input MAY be any of:
   *   - `ProjectGroup.id`   — walk forward through RPG ('original'-rooted)
   *   - `RevisedProjectGroup.id` — walk forward through RPG ('revised'-rooted)
   *   - `SupplementProjectGroup.id` — SPG is its own HEAD (§11.3)
   *
   * Returns `null` when no row matches the input UUID.
   */
  async getProjectHeadBook(
    projectId: string,
  ): Promise<ProjectHeadBookResult | null> {
    if (!projectId) return null;
    const advisories: string[] = [];
    const resolved = await this.resolveRowByAnyKind(projectId);
    if (!resolved) return null;

    const headRow = await this.walkToHead(resolved, advisories);
    const meta = await this.describeRowAsBook(headRow);

    return {
      projectId,
      headProjectId: meta.projectId,
      headBookLabel: meta.bookLabel,
      headBookType: meta.bookType,
      headRevisionNumber: meta.revisionNumber,
      headDprId: meta.dprId,
      headDpsId: meta.dpsId,
      isInputHead: meta.projectId === projectId,
      advisories,
      asOf: new Date().toISOString(),
    };
  }

  // ────────────────────────────────────────────────────────────────
  // Public API — Mode 3 tool 2: full forward+backward chain
  // ────────────────────────────────────────────────────────────────

  /**
   * Resolve the full ordered lineage chain (root → HEAD) for the given
   * project UUID. SPG inputs return a single-step chain (SPG is not part
   * of the PG/RPG lineage).
   */
  async getProjectLineage(
    projectId: string,
  ): Promise<ProjectLineageResult | null> {
    if (!projectId) return null;
    const advisories: string[] = [];
    const resolved = await this.resolveRowByAnyKind(projectId);
    if (!resolved) return null;

    // SPG: standalone, no chain.
    if (resolved.kind === 'supplement') {
      const meta = await this.describeRowAsBook(resolved);
      const status = await this.loadLatestStatus(resolved);
      const step: ProjectLineageStep = {
        projectId: meta.projectId,
        projectKind: 'supplement',
        bookLabel: meta.bookLabel,
        bookType: meta.bookType,
        revisionNumber: meta.revisionNumber,
        dprId: meta.dprId,
        dpsId: meta.dpsId,
        title: meta.title,
        statusName: status,
        isHead: true,
        step: 0,
      };
      return {
        projectId,
        rootProjectId: meta.projectId,
        headProjectId: meta.projectId,
        chain: [step],
        asOf: new Date().toISOString(),
        advisories,
      };
    }

    // PG/RPG: walk both directions and stitch root → HEAD.
    const backward = await this.walkToRoot(resolved, advisories);
    const forward = await this.walkForwardChain(resolved, advisories);
    // backward[0] is root, last item is the input.
    // forward[0] is the input, last item is HEAD.
    // Combine without double-counting the input row.
    const fullChain: ResolvedRow[] = [...backward, ...forward.slice(1)];

    // Build steps with metadata + status.
    const chain: ProjectLineageStep[] = [];
    for (let i = 0; i < fullChain.length; i++) {
      const row = fullChain[i];
      const meta = await this.describeRowAsBook(row);
      const status = await this.loadLatestStatus(row);
      chain.push({
        projectId: meta.projectId,
        projectKind: row.kind,
        bookLabel: meta.bookLabel,
        bookType: meta.bookType,
        revisionNumber: meta.revisionNumber,
        dprId: meta.dprId,
        dpsId: meta.dpsId,
        title: meta.title,
        statusName: status,
        isHead: i === fullChain.length - 1,
        step: i,
      });
    }

    return {
      projectId,
      rootProjectId: chain[0]?.projectId ?? projectId,
      headProjectId: chain[chain.length - 1]?.projectId ?? projectId,
      chain,
      asOf: new Date().toISOString(),
      advisories,
    };
  }

  // ────────────────────────────────────────────────────────────────
  // Internal helpers
  // ────────────────────────────────────────────────────────────────

  private async resolveRowByAnyKind(
    projectId: string,
  ): Promise<ResolvedRow | null> {
    // PG first — historically the most common entry point.
    const pg = await this.dataSource
      .getRepository(ProjectGroup)
      .findOne({ where: { id: projectId, deletedAt: IsNull() } });
    if (pg) return { kind: 'main', pgRow: pg };

    const rpg = await this.dataSource
      .getRepository(RevisedProjectGroup)
      .findOne({
        where: { id: projectId, deletedAt: IsNull() },
        relations: [
          'developmentPlanRevision',
          'developmentPlanRevision.revisionType',
        ],
      });
    if (rpg) return { kind: 'revised', rpgRow: rpg };

    const spg = await this.dataSource
      .getRepository(SupplementProjectGroup)
      .findOne({
        where: { id: projectId, deletedAt: IsNull() },
        relations: ['developmentPlanSupplement'],
      });
    if (spg) return { kind: 'supplement', spgRow: spg };

    return null;
  }

  /**
   * Walk forward from `start` to the HEAD-of-lineage row. SPG short-circuits
   * (it is not part of the PG/RPG chain).
   */
  private async walkToHead(
    start: ResolvedRow,
    advisories: string[],
  ): Promise<ResolvedRow> {
    if (start.kind === 'supplement') return start;
    let cur = start;
    for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
      const child = await this.findLiveChild(cur);
      if (!child) return cur;
      cur = { kind: 'revised', rpgRow: child };
    }
    advisories.push('lineage-depth-cap-reached');
    return cur;
  }

  /**
   * Walk forward AND collect every visited row, including the start row.
   * Returned ordered chain is `[start, child, grandchild, ..., HEAD]`.
   */
  private async walkForwardChain(
    start: ResolvedRow,
    advisories: string[],
  ): Promise<ResolvedRow[]> {
    if (start.kind === 'supplement') return [start];
    const out: ResolvedRow[] = [start];
    let cur = start;
    for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
      const child = await this.findLiveChild(cur);
      if (!child) return out;
      cur = { kind: 'revised', rpgRow: child };
      out.push(cur);
    }
    advisories.push('lineage-depth-cap-reached');
    return out;
  }

  /**
   * Walk backward from `start` to the root PG. Returned ordered chain is
   * `[root, ..., start]`. SPG short-circuits.
   */
  private async walkToRoot(
    start: ResolvedRow,
    advisories: string[],
  ): Promise<ResolvedRow[]> {
    if (start.kind !== 'revised' || !start.rpgRow) {
      // PG → already root. SPG → handled by caller.
      return [start];
    }
    const reverseStack: ResolvedRow[] = [start];
    let cur = start;
    for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
      const rpg = cur.rpgRow!;
      const prevId = rpg.prevProjectId;
      const prevType = rpg.prevProjectType;
      if (!prevId || !prevType) break;

      if (prevType === PrevProjectType.ORIGINAL) {
        const pg = await this.dataSource
          .getRepository(ProjectGroup)
          .findOne({ where: { id: prevId, deletedAt: IsNull() } });
        if (!pg) break;
        reverseStack.push({ kind: 'main', pgRow: pg });
        break; // PG is always root
      }

      // prevType === 'revised'
      const parentRpg = await this.dataSource
        .getRepository(RevisedProjectGroup)
        .findOne({
          where: { id: prevId, deletedAt: IsNull() },
          relations: [
            'developmentPlanRevision',
            'developmentPlanRevision.revisionType',
          ],
        });
      if (!parentRpg) break;
      const parent: ResolvedRow = { kind: 'revised', rpgRow: parentRpg };
      reverseStack.push(parent);
      cur = parent;
    }
    if (reverseStack.length >= MAX_CHAIN_DEPTH) {
      advisories.push('lineage-depth-cap-reached');
    }
    return reverseStack.reverse();
  }

  /**
   * Find one live RPG child of `cur` keyed on `(prev_project_id,
   * prev_project_type)`. Soft-deleted children do NOT lock per §14.2.
   *
   * Note: lineage tolerates a DAG shape (§14.1) — multiple children can
   * theoretically reference the same parent. For the chat-tool surface we
   * treat the most-recently-created live child as the canonical successor.
   */
  private async findLiveChild(
    cur: ResolvedRow,
  ): Promise<RevisedProjectGroup | null> {
    if (cur.kind === 'supplement') return null;
    const parentId = cur.kind === 'main' ? cur.pgRow!.id : cur.rpgRow!.id;
    const parentType =
      cur.kind === 'main' ? PrevProjectType.ORIGINAL : PrevProjectType.REVISION;

    return await this.dataSource
      .getRepository(RevisedProjectGroup)
      .createQueryBuilder('rpg')
      .leftJoinAndSelect('rpg.developmentPlanRevision', 'dpr')
      .leftJoinAndSelect('dpr.revisionType', 'rt')
      .where('rpg.prevProjectId = :pid', { pid: parentId })
      .andWhere('rpg.prevProjectType = :ptype', { ptype: parentType })
      .andWhere('rpg.deletedAt IS NULL')
      .orderBy('rpg.createdAt', 'DESC')
      .limit(1)
      .getOne();
  }

  /**
   * Resolve the book-level metadata (label / type / round number / FKs) for
   * a given row. Pure read; no DB write.
   */
  private async describeRowAsBook(row: ResolvedRow): Promise<{
    projectId: string;
    title: string;
    bookLabel: string;
    bookType: LineageBookType;
    revisionNumber: number | null;
    dprId: string | null;
    dpsId: string | null;
  }> {
    if (row.kind === 'main') {
      const pg = row.pgRow!;
      return {
        projectId: pg.id,
        title: pg.title ?? '',
        bookLabel: REVISION_ROUND_LABEL_MAIN,
        bookType: 'main',
        revisionNumber: null,
        dprId: null,
        dpsId: null,
      };
    }
    if (row.kind === 'revised') {
      const rpg = row.rpgRow!;
      // Hydrate DPR if relations weren't eager-loaded.
      let dpr = rpg.developmentPlanRevision;
      if (!dpr) {
        const dprId = (rpg as unknown as { developmentPlanRevisionId?: string })
          .developmentPlanRevisionId;
        if (dprId) {
          const loaded = await this.dataSource
            .getRepository(DevelopmentPlanRevision)
            .findOne({
              where: { id: dprId },
              relations: ['revisionType'],
            });
          if (loaded) dpr = loaded;
        }
      }
      const rtName = (dpr?.revisionType?.name ?? '').toLowerCase();
      const bookType: LineageBookType =
        rtName === 'change' || rtName.includes('เปลี่ยนแปลง')
          ? 'change'
          : 'edit';
      const revisionNumber = dpr?.revisionNumber ?? null;
      const description = dpr?.description ?? null;
      const bookLabel = resolveRevisionRoundLabel({
        type: bookType as RevisionRoundType,
        number: revisionNumber,
        description,
      });
      return {
        projectId: rpg.id,
        title: rpg.title ?? '',
        bookLabel,
        bookType,
        revisionNumber,
        dprId: dpr?.id ?? null,
        dpsId: null,
      };
    }
    // supplement
    const spg = row.spgRow!;
    let dps = spg.developmentPlanSupplement;
    if (!dps) {
      const dpsId = (spg as unknown as { developmentPlanSupplementId?: string })
        .developmentPlanSupplementId;
      if (dpsId) {
        const loaded = await this.dataSource
          .getRepository(DevelopmentPlanSupplement)
          .findOne({ where: { id: dpsId } });
        if (loaded) dps = loaded;
      }
    }
    const supNum = dps?.supplementNumber ?? null;
    const bookLabel = resolveRevisionRoundLabel({
      type: 'supplement',
      number: supNum,
      description: dps?.description ?? null,
    });
    return {
      projectId: spg.id,
      title: spg.title ?? '',
      bookLabel,
      bookType: 'supplement',
      revisionNumber: supNum,
      dprId: null,
      dpsId: dps?.id ?? null,
    };
  }

  /**
   * Load the canonical English status name for a row's latest tracking
   * record (§12). Returns `null` when no tracking row exists.
   */
  private async loadLatestStatus(row: ResolvedRow): Promise<string | null> {
    const qb = this.dataSource
      .getRepository(TrackingStatus)
      .createQueryBuilder('ts')
      .leftJoinAndSelect('ts.statusId', 's')
      .where('ts.isLatest = :isLatest', { isLatest: true });

    if (row.kind === 'main') {
      qb.andWhere('ts.project_group_id = :pid', { pid: row.pgRow!.id });
    } else if (row.kind === 'revised') {
      qb.andWhere('ts.revised_project_group_id = :pid', {
        pid: row.rpgRow!.id,
      });
    } else {
      qb.andWhere('ts.supplement_project_group_id = :pid', {
        pid: row.spgRow!.id,
      });
    }

    const ts = await qb.limit(1).getOne();
    return ts?.statusId?.name ?? null;
  }
}
