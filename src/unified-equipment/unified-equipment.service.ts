import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { EquipmentProjectGroup } from 'src/equipment-project-group/entities/equipment-project-group.entity';
import { RevisedEquipmentProjectGroup } from 'src/revised-equipment-project-group/entities/revised-equipment-project-group.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import {
  EXECUTIVE_EXCLUDED_STATUS_NAMES,
  mapToExecutiveStatusGroup,
} from 'src/ai-executive-chat/aggregation/constants/executive-status-groups';

import { ListUnifiedEquipmentQueryDto } from './dto/list-unified-equipment-query.dto';
import type {
  UnifiedEquipmentBudget,
  UnifiedEquipmentClassificationLite,
  UnifiedEquipmentRow,
  UnifiedEquipmentStatus,
} from './types/unified-equipment-row';

/**
 * Wave Unified Equipment Tab — BE-01.
 *
 * The equipment analog of `UnifiedProjectsService`. Merges
 * `EquipmentProjectGroup` (EPG) + `RevisedEquipmentProjectGroup` (RELPG)
 * into ONE latest-version-aware list, applying the §14.2 HEAD-of-lineage
 * anti-join so a revised equipment REPLACES its locked parent EPG —
 * mirroring the project tab's `applyHeadFilterForProjectGroup /
 * applyHeadFilterForRevisedProjectGroup` semantics.
 *
 * Why a dedicated subsystem (NOT folded into `/unified-projects`):
 *   - Equipment carries ผ.03-specific columns (`equipmentCategory`) and
 *     an agency-only authoring scope (§5.3) that the PG/RPG/SPG aggregator
 *     does not model. Widening the AI-executive-chat-scoped
 *     `UnifiedProjectAggregator` (PII-bound, §17.3 FK-isolated) with
 *     equipment kinds would risk those callers and duplicate the §16.5
 *     equipment indicator-relaxation branch into a hot shared path.
 *   - The merge surface is small (two tables, two anti-joins) so a thin
 *     dedicated service is cleaner than the aggregator's tiered pipeline.
 *
 * CLAUDE.md references:
 *   - §5 / §5.3 — equipment sub-type; agency-only is a WRITE gate. This
 *     READ projection is unrestricted (LAO callers may view).
 *   - §10 — plan-scope binding per row's own chain (EPG → plan; RELPG →
 *     DPR → plan). Never a global latest lookup.
 *   - §11 / §14 — versioning + lineage. HEAD anti-join drops a locked
 *     parent; `hasDescendant` mirrors the canonical lineage discriminators
 *     (`'equipment'` / `'revised_equipment'`).
 *   - §16.5 — classification dual shape; `indicator` relaxed (nullable).
 *   - §17.2 / §17.3 / §17.11 — advisory, READ-ONLY (zero TrackingStatus /
 *     AI writes), no role exemption.
 *   - §4 — ownership scalar is `WorkHistory.id`, never `userId`.
 */
@Injectable()
export class UnifiedEquipmentService {
  constructor(
    @InjectRepository(EquipmentProjectGroup)
    private readonly epgRepo: Repository<EquipmentProjectGroup>,
    @InjectRepository(RevisedEquipmentProjectGroup)
    private readonly relpgRepo: Repository<RevisedEquipmentProjectGroup>,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,
  ) {}

  /**
   * Owner-facing unified equipment list. EPG head rows (no live RELPG
   * descendant) UNION RELPG head rows (no live revised_equipment
   * descendant), plan-scoped, newest-first.
   */
  async ownerList(
    userId: string,
    query: ListUnifiedEquipmentQueryDto,
  ): Promise<UnifiedEquipmentRow[]> {
    // Resolve caller WorkHistory only when an owner filter is requested.
    let ownerWorkHistoryId: string | null = null;
    if (query.mineOnly) {
      const wh = await this.loadCurrentWorkHistory(userId);
      ownerWorkHistoryId = wh.id;
    }

    return this.loadMergedHeadRows(query.developmentPlanId, ownerWorkHistoryId);
  }

  /**
   * Executive-facing unified equipment list. The executive analog of
   * `UnifiedProjectsService.executiveList`. System-wide (NO owner filter),
   * plan-scoped by `developmentPlanId` (§10), with the W67 executive
   * post-processing applied on top of the SAME EPG+RELPG HEAD-of-lineage
   * merge used by `ownerList`:
   *
   *   1. EXCLUDE rows whose latest canonical status is in
   *      `EXECUTIVE_EXCLUDED_STATUS_NAMES` (Ready / Pull_Back /
   *      Returned_For_Revision) — parity with the project executive-list.
   *   2. TAG each surviving row with `executiveStatusGroup =
   *      mapToExecutiveStatusGroup(row.status.name)` (W67 4-group rollup).
   *      A residual `null` group (would imply an excluded status slipped
   *      through) is dropped defensively.
   *
   * §17.2 advisory / READ-ONLY — zero writes. §W67 — the exclusion set and
   * group mapping are consumed from the canonical constants module; never
   * re-derived here. §14.2 HEAD anti-join is inherited from the loaders.
   *
   * Authority: enforced at the controller via `@Roles(...EXEC_READ)` —
   * the SAME gate as `unified-projects/executive-list`, NOT the owner gate
   * and NOT the §5.3 equipment agency-only write gate.
   */
  async executiveList(
    query: { developmentPlanId?: string },
  ): Promise<UnifiedEquipmentRow[]> {
    // System-wide: NO ownerWorkHistoryId filter.
    const merged = await this.loadMergedHeadRows(
      query.developmentPlanId,
      null,
    );

    const excluded = new Set<string>(EXECUTIVE_EXCLUDED_STATUS_NAMES);

    const result: UnifiedEquipmentRow[] = [];
    for (const row of merged) {
      // §3 W67 — strip in-flight authoring states server-side.
      if (excluded.has(row.status.name)) continue;
      const group = mapToExecutiveStatusGroup(row.status.name);
      // Defensive: a row that maps to null had an excluded status and
      // should already be filtered; drop any residual null-group row so
      // the executive path never emits an untagged row.
      if (!group) continue;
      result.push({ ...row, executiveStatusGroup: group });
    }

    return result;
  }

  /**
   * Shared EPG+RELPG HEAD-of-lineage merge + newest-first sort, reused by
   * BOTH `ownerList` and `executiveList`. Pass `ownerWorkHistoryId = null`
   * for the system-wide (executive) read; pass a resolved WH id for the
   * owner-scoped read.
   */
  private async loadMergedHeadRows(
    developmentPlanId: string | undefined,
    ownerWorkHistoryId: string | null,
  ): Promise<UnifiedEquipmentRow[]> {
    const [epgRows, relpgRows] = await Promise.all([
      this.loadEpgHeadRows(developmentPlanId, ownerWorkHistoryId),
      this.loadRelpgHeadRows(developmentPlanId, ownerWorkHistoryId),
    ]);

    const merged = [...epgRows, ...relpgRows];
    // §17.3 PII — the projected wire shape (`UnifiedEquipmentCreator`)
    // surfaces ONLY firstName/lastName. No email / phone / citizenId is
    // ever projected, so there is no contact PII on the response and no
    // decrypt-then-mask step is required (unlike the EPG/RELPG detail
    // read paths, which DO surface masked email for the staff table).

    // Newest-first by the row's own createdAt (mirrors EPG/RELPG findAll
    // `ORDER BY createdAt DESC`).
    merged.sort((a, b) => {
      const at = new Date(a.createdAt || 0).getTime();
      const bt = new Date(b.createdAt || 0).getTime();
      return bt - at;
    });

    return merged;
  }

  // ──────────────────────────────────────────────────────────────────
  //  EPG head rows — §14.2 anti-join with revised_equipment_project_groups
  //  (prev_project_type='equipment'). An EPG with a live RELPG descendant
  //  is DROPPED (REPLACE semantic).
  // ──────────────────────────────────────────────────────────────────

  private async loadEpgHeadRows(
    developmentPlanId: string | undefined,
    ownerWorkHistoryId: string | null,
  ): Promise<UnifiedEquipmentRow[]> {
    const qb = this.epgRepo
      .createQueryBuilder('epg')
      .leftJoinAndSelect('epg.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('epg.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('epg.strategy', 'strategy')
      .leftJoinAndSelect('epg.tactic', 'tactic')
      .leftJoinAndSelect('epg.plan', 'plan')
      .leftJoinAndSelect('epg.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('epg.equipmentCategory', 'equipmentCategory')
      .leftJoinAndSelect('epg.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('epg.budgets', 'budgets')
      .leftJoinAndSelect('epg.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      // §14.2 HEAD anti-join — drop EPGs that already have a live RELPG.
      .leftJoin(
        RevisedEquipmentProjectGroup,
        'epg_desc',
        `epg_desc.prev_project_id = epg.id ` +
          `AND epg_desc.prev_project_type = 'equipment' ` +
          `AND epg_desc.deleted_at IS NULL`,
      )
      .where('epg.deletedAt IS NULL')
      .andWhere('epg_desc.id IS NULL');

    if (developmentPlanId) {
      qb.andWhere('developmentPlan.id = :planId', {
        planId: developmentPlanId,
      });
    }
    if (ownerWorkHistoryId) {
      qb.andWhere('createdBy.id = :ownerId', { ownerId: ownerWorkHistoryId });
    }

    const rows = await qb.getMany();
    return rows.map((epg) => this.projectEpg(epg));
  }

  // ──────────────────────────────────────────────────────────────────
  //  RELPG head rows — §14.2 anti-join with revised_equipment_project_groups
  //  (prev_project_type='revised_equipment'). A RELPG with a live
  //  revised_equipment descendant is DROPPED (only the chain head shows).
  // ──────────────────────────────────────────────────────────────────

  private async loadRelpgHeadRows(
    developmentPlanId: string | undefined,
    ownerWorkHistoryId: string | null,
  ): Promise<UnifiedEquipmentRow[]> {
    const qb = this.relpgRepo
      .createQueryBuilder('relpg')
      .leftJoinAndSelect('relpg.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      // RELPG carries a denormalized developmentPlan FK AND a DPR whose
      // own developmentPlan is the canonical §10 chain. Load both; prefer
      // the DPR chain in projection, fall back to the denormalized FK.
      .leftJoinAndSelect('relpg.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect(
        'relpg.developmentPlanRevision',
        'developmentPlanRevision',
      )
      .leftJoinAndSelect(
        'developmentPlanRevision.developmentPlan',
        'dprPlan',
      )
      .leftJoinAndSelect(
        'developmentPlanRevision.revisionType',
        'revisionType',
      )
      .leftJoinAndSelect('relpg.strategy', 'strategy')
      .leftJoinAndSelect('relpg.tactic', 'tactic')
      .leftJoinAndSelect('relpg.plan', 'plan')
      .leftJoinAndSelect('relpg.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('relpg.equipmentCategory', 'equipmentCategory')
      .leftJoinAndSelect('relpg.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('relpg.budgets', 'budgets')
      .leftJoinAndSelect('relpg.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      // §14.2 HEAD anti-join — keep only RELPG chain heads.
      .leftJoin(
        RevisedEquipmentProjectGroup,
        'relpg_desc',
        `relpg_desc.prev_project_id = relpg.id ` +
          `AND relpg_desc.prev_project_type = 'revised_equipment' ` +
          `AND relpg_desc.deleted_at IS NULL`,
      )
      .where('relpg.deletedAt IS NULL')
      .andWhere('relpg_desc.id IS NULL');

    if (developmentPlanId) {
      // §10 plan-scope binding — match either the DPR's parent plan OR
      // the denormalized FK (both should agree; OR is defensive).
      qb.andWhere(
        '(dprPlan.id = :planId OR developmentPlan.id = :planId)',
        { planId: developmentPlanId },
      );
    }
    if (ownerWorkHistoryId) {
      qb.andWhere('createdBy.id = :ownerId', { ownerId: ownerWorkHistoryId });
    }

    const rows = await qb.getMany();
    return rows.map((relpg) => this.projectRelpg(relpg));
  }

  // ──────────────────────────────────────────────────────────────────
  //  Projection helpers
  // ──────────────────────────────────────────────────────────────────

  private projectEpg(epg: EquipmentProjectGroup): UnifiedEquipmentRow {
    const plan = epg.developmentPlan;
    return {
      kind: 'equipment',
      id: epg.id,
      equipmentName: epg.equipmentName ?? '',
      targetOutput: epg.targetOutput ?? null,
      expectedResults: epg.expectedResults ?? null,
      indicator: epg.indicator ?? null,
      equipmentCategory: epg.equipmentCategory
        ? {
            id: epg.equipmentCategory.id,
            code: epg.equipmentCategory.code,
            name: epg.equipmentCategory.name,
          }
        : null,
      strategy: this.classificationLite(epg.strategy),
      tactic: this.classificationLite(epg.tactic),
      plan: this.classificationLite(epg.plan),
      developmentIssue: this.classificationLite(epg.developmentIssue),
      developmentPlan: {
        id: plan?.id ?? '',
        name: plan?.name ?? '',
        startYear: plan?.startYear ?? null,
        endYear: plan?.endYear ?? null,
        isLatest: plan?.isLatest ?? false,
        isBooked: plan?.isBooked ?? false,
        reportFormat: (plan?.reportFormat as 'STRATEGY_BASED' | 'ISSUE_BASED') ??
          'STRATEGY_BASED',
      },
      // EPG = เล่มหลัก, no revision metadata.
      developmentPlanRevision: undefined,
      status: this.latestStatus(epg.trackingStatus),
      // Under REPLACE semantics a HEAD EPG (the only ones returned here)
      // has no live RELPG descendant by construction of the anti-join.
      hasDescendant: false,
      isBooked: epg.isBooked ?? false,
      bookedAt: this.toIso(epg.bookedAt),
      pageNumber: epg.pageNumber ?? null,
      budgets: this.projectBudgets(epg.budgets),
      createdBy: epg.createdBy
        ? {
            workHistoryId: epg.createdBy.id,
            firstName: this.creatorFirstName(epg.createdBy),
            lastName: this.creatorLastName(epg.createdBy),
          }
        : null,
      createdByWorkHistoryId: epg.createdBy?.id ?? null,
      responsibleAgency: epg.responsibleAgency
        ? {
            id: epg.responsibleAgency.id,
            name: epg.responsibleAgency.name ?? null,
          }
        : null,
      createdAt: this.toIso(epg.createdAt) ?? new Date(0).toISOString(),
    };
  }

  private projectRelpg(
    relpg: RevisedEquipmentProjectGroup,
  ): UnifiedEquipmentRow {
    const dpr = relpg.developmentPlanRevision;
    // §10 — prefer the DPR's parent plan; fall back to the denormalized FK.
    const plan = dpr?.developmentPlan ?? relpg.developmentPlan;
    return {
      kind: 'revised-equipment',
      id: relpg.id,
      equipmentName: relpg.equipmentName ?? '',
      targetOutput: relpg.targetOutput ?? null,
      expectedResults: relpg.expectedResults ?? null,
      indicator: relpg.indicator ?? null,
      equipmentCategory: relpg.equipmentCategory
        ? {
            id: relpg.equipmentCategory.id,
            code: relpg.equipmentCategory.code,
            name: relpg.equipmentCategory.name,
          }
        : null,
      strategy: this.classificationLite(relpg.strategy),
      tactic: this.classificationLite(relpg.tactic),
      plan: this.classificationLite(relpg.plan),
      developmentIssue: this.classificationLite(relpg.developmentIssue),
      developmentPlan: {
        id: plan?.id ?? '',
        name: plan?.name ?? '',
        startYear: plan?.startYear ?? null,
        endYear: plan?.endYear ?? null,
        isLatest: plan?.isLatest ?? false,
        isBooked: plan?.isBooked ?? false,
        reportFormat: (plan?.reportFormat as 'STRATEGY_BASED' | 'ISSUE_BASED') ??
          'STRATEGY_BASED',
      },
      developmentPlanRevision: dpr
        ? {
            id: dpr.id,
            revisionNumber: dpr.revisionNumber ?? null,
            revisionTypeName: dpr.revisionType?.name ?? null,
            description: dpr.description ?? null,
            isLatest: dpr.isLatest ?? false,
            isBooked: dpr.isBooked ?? false,
            isOpen: dpr.isOpen ?? false,
          }
        : undefined,
      status: this.latestStatus(relpg.trackingStatus),
      // HEAD RELPG rows have no live revised_equipment descendant by the
      // anti-join — so head rows surface as `false`. (A non-head RELPG is
      // dropped, never projected.)
      hasDescendant: false,
      isBooked: relpg.isBooked ?? false,
      bookedAt: this.toIso(relpg.bookedAt),
      pageNumber: relpg.pageNumber ?? null,
      budgets: this.projectBudgets(relpg.budgets),
      createdBy: relpg.createdBy
        ? {
            workHistoryId: relpg.createdBy.id,
            firstName: this.creatorFirstName(relpg.createdBy),
            lastName: this.creatorLastName(relpg.createdBy),
          }
        : null,
      createdByWorkHistoryId: relpg.createdBy?.id ?? null,
      responsibleAgency: relpg.responsibleAgency
        ? {
            id: relpg.responsibleAgency.id,
            name: relpg.responsibleAgency.name ?? null,
          }
        : null,
      createdAt: this.toIso(relpg.createdAt) ?? new Date(0).toISOString(),
    };
  }

  // ──────────────────────────────────────────────────────────────────
  //  Small helpers
  // ──────────────────────────────────────────────────────────────────

  private classificationLite(
    rel: { id: string; name?: string | null } | null | undefined,
  ): UnifiedEquipmentClassificationLite | null {
    if (!rel) return null;
    return { id: rel.id, name: rel.name ?? null };
  }

  private projectBudgets(
    budgets: Array<{ year?: number | null; quantity?: number | string | null }>
      | undefined,
  ): UnifiedEquipmentBudget[] {
    if (!Array.isArray(budgets)) return [];
    return budgets.map((b) => ({
      year: typeof b.year === 'number' ? b.year : null,
      quantity: Number(b.quantity ?? 0) || 0,
    }));
  }

  private latestStatus(
    tracking:
      | Array<{
          isLatest?: boolean;
          createAt?: Date | string | null;
          statusId?: { name?: string; th_name?: string } | null;
        }>
      | undefined,
  ): UnifiedEquipmentStatus {
    const empty: UnifiedEquipmentStatus = { name: '', thName: '-', statusAt: null };
    if (!Array.isArray(tracking) || tracking.length === 0) return empty;
    const explicit = tracking.find((t) => t.isLatest === true);
    const latest =
      explicit ??
      [...tracking].sort((a, b) => {
        const at = new Date((a.createAt as any) ?? 0).getTime();
        const bt = new Date((b.createAt as any) ?? 0).getTime();
        return bt - at;
      })[0];
    if (!latest) return empty;
    const name = latest.statusId?.name ?? '';
    return {
      name,
      thName: latest.statusId?.th_name ?? (name.length > 0 ? name : '-'),
      statusAt: this.toIso(latest.createAt ?? null),
    };
  }

  private creatorFirstName(wh: WorkHistory): string | null {
    const u = (wh as unknown as { user?: { firstname?: string; firstName?: string } })
      .user;
    return u?.firstname ?? u?.firstName ?? null;
  }

  private creatorLastName(wh: WorkHistory): string | null {
    const u = (wh as unknown as { user?: { lastname?: string; lastName?: string } })
      .user;
    return u?.lastname ?? u?.lastName ?? null;
  }

  private toIso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  private async loadCurrentWorkHistory(userId: string): Promise<WorkHistory> {
    if (!userId) {
      throw new UnauthorizedException('UNAUTHENTICATED');
    }
    const wh = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
    });
    if (!wh) {
      throw new UnauthorizedException('NO_CURRENT_WORK_HISTORY');
    }
    return wh;
  }
}
