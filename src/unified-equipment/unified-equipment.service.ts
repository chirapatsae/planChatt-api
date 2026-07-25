import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { EquipmentProjectGroup } from 'src/equipment-project-group/entities/equipment-project-group.entity';
import { RevisedEquipmentProjectGroup } from 'src/revised-equipment-project-group/entities/revised-equipment-project-group.entity';
import { SupplementEquipmentProjectGroup } from 'src/supplement-equipment-project-group/entities/supplement-equipment-project-group.entity';
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
    @InjectRepository(SupplementEquipmentProjectGroup)
    private readonly sepgRepo: Repository<SupplementEquipmentProjectGroup>,
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
    // System-wide: NO area scope (null).
    return this.executiveListWithScope(query, null);
  }

  /**
   * DOCUMENT-level executive equipment list. Same wire shape + W67 in-flight
   * strip + `executiveStatusGroup` tag as `executiveList`, but WITHOUT the
   * §14.2 HEAD-of-lineage anti-join: a main-book equipment that was later
   * revised still surfaces in the main book (and the revision surfaces in
   * its own book). This mirrors the ผ.02 project catalog's document-level
   * listing (`listProjectsInPlan` byBookCompleteness) and keeps the
   * per-book listing consistent with `documentCountsByBook` so
   * "เล่มหลักมี N ครุภัณฑ์" (count) equals the enumerated names (listing).
   *
   * Used by the executive AI chat book-scoped equipment listing
   * (`listEquipmentInPlan`). Analytical tools (budget / status / category)
   * intentionally stay on the HEAD `executiveList` path.
   *
   * §17.2 advisory / READ-only. Authority: SAME executive read gate as
   * `executiveList` (enforced at the controller / tool handler).
   */
  async documentList(
    query: { developmentPlanId?: string },
  ): Promise<UnifiedEquipmentRow[]> {
    return this.executiveListWithScope(query, null, true);
  }

  /**
   * Wave AI-EXEC-CHAT-EQUIPMENT-HEAD-ROSTER — classify the ORIGIN book of a
   * revised-equipment (RELPG) HEAD row by walking its lineage backward via
   * `(prev_project_id, prev_project_type)` until it reaches the root:
   *   - `prev_project_type = 'equipment'`        → root is an EPG → 'main'
   *   - `prev_project_type = 'revised_equipment'` → walk up to the parent RELPG
   *   - null / missing parent                     → born in a revision → 'revised'
   *
   * EPG heads ('main') and SEPG heads ('supplement') are classified by the
   * caller via `kind` and never call this. Bounded backward walk (cycles /
   * long chains capped). READ-only.
   */
  async resolveEquipmentOriginBookType(
    revisedEquipmentId: string,
  ): Promise<'main' | 'revised'> {
    let curId: string | null = revisedEquipmentId;
    for (let depth = 0; depth < 25 && curId; depth++) {
      const cur: { prevProjectId?: string | null; prevProjectType?: string | null } | undefined =
        await this.relpgRepo
          .createQueryBuilder('r')
          .select(['r.id', 'r.prevProjectId', 'r.prevProjectType'])
          .where('r.id = :id', { id: curId })
          .andWhere('r.deletedAt IS NULL')
          .getOne()
          .then((row) => row ?? undefined);
      if (!cur) return 'revised';
      if (cur.prevProjectType === 'equipment') return 'main';
      if (cur.prevProjectType !== 'revised_equipment' || !cur.prevProjectId) {
        return 'revised';
      }
      curId = cur.prevProjectId;
    }
    return 'revised';
  }

  /**
   * Staff-workspace, AREA-SCOPED analog of `executiveList`. Response
   * shape is BYTE-IDENTICAL to `executiveList` (`UnifiedEquipmentRow[]`
   * with the same W67 exclusion + `executiveStatusGroup` tag) so the FE
   * shared list component renders both via one mapping; the ONLY
   * difference is the AREA SCOPE.
   *
   * Area scope (§1 / §3 / §4.1) is resolved EXACTLY as
   * `StaffHomeService.getOverdue` does:
   *   - EPG (เล่มหลัก, agency-origin by §5.3) → scoped by the caller's
   *     responsible amphoe ids (`WorkHistoryAmphoeResponsibility`,
   *     `epg.amphoe_id`).
   *   - RELPG (เล่มแก้ไข) → scoped by the caller's responsible agency ids
   *     (`WorkHistoryGovernmentAgencyResponsibility`,
   *     `relpg.responsible_agency_id`).
   *   - `admin` / `super-admin` → BYPASS the area filter (system-wide).
   *   - plain `staff` with ZERO responsibilities → FAIL-CLOSED `[]`.
   *     Never a global scan.
   *
   * Authority gate: STAFF_LEAD (staff / admin / super-admin) +
   * `workStatus = approved` is enforced at the controller. The §5.3
   * equipment agency-only rule is a WRITE gate and does NOT apply to
   * this READ surface.
   *
   * §17.2 / §18.13 — strictly advisory, read-side aggregator: ZERO
   * TrackingStatus / AI / notification writes. SELECT only.
   */
  async staffList(
    userId: string,
    query: { developmentPlanId?: string },
  ): Promise<UnifiedEquipmentRow[]> {
    const wh = await this.loadStaffWorkHistory(userId);
    // No current WorkHistory → graceful empty (mirrors StaffHomeService).
    if (!wh) return [];

    const role = wh.role?.name;
    const bypassAreaFilter = role === 'admin' || role === 'super-admin';

    // admin / super-admin → system-wide (null scope, identical to
    // `executiveList`).
    if (bypassAreaFilter) {
      return this.executiveListWithScope(query, null);
    }

    const amphoeIds = (wh.workHistoryResponsibleAmphoe ?? [])
      .map((r) => r.amphoe?.id)
      .filter((id): id is string => !!id);
    const agencyIds = (wh.workHistoryResponsibleGovernmentAgency ?? [])
      .map((r) => r.governmentAgency?.id)
      .filter((id): id is string => !!id);

    // Fail-closed: plain staff with zero responsibilities sees nothing.
    if (amphoeIds.length === 0 && agencyIds.length === 0) {
      return [];
    }

    return this.executiveListWithScope(query, { amphoeIds, agencyIds });
  }

  /**
   * DOCUMENT-level equipment counts per book (ผ.03 as printed).
   *
   * Unlike `ownerList`/`executiveList`/`staffList` — which all apply the
   * §14.2 HEAD-of-lineage anti-join (a revised EPG REPLACES its parent) —
   * this counts EVERY non-deleted EPG/RELPG/SEPG row in each book, exactly
   * as the physical ผ.03 document of that book lists them. A main-book
   * equipment that was later revised still counts in the main book here
   * (the revision also counts in its own revision book). No status filter
   * (mirrors how the ผ.02 project catalog counts every ProjectGroup row) so
   * "เล่มหลักมี N ครุภัณฑ์" matches the issued document.
   *
   * READ-only aggregate (COUNT + GROUP BY, no row hydration). Used by the
   * executive AI chat book-catalog answer (per-child-book breakdown).
   */
  async documentCountsByBook(developmentPlanId: string): Promise<{
    main: number;
    byRevision: Array<{
      revisionId: string;
      revisionNumber: number;
      revisionTypeName: string;
      itemCount: number;
    }>;
    bySupplement: Array<{
      supplementId: string;
      supplementNumber: number;
      itemCount: number;
    }>;
  }> {
    const manager = this.epgRepo.manager;

    const mainRows: Array<{ n: string }> = await manager.query(
      `SELECT count(*) AS n
         FROM equipment_project_groups
        WHERE development_plan_id = $1
          AND deleted_at IS NULL`,
      [developmentPlanId],
    );

    const revRows: Array<{
      revision_id: string;
      revision_number: number | null;
      revision_type_name: string | null;
      n: string;
    }> = await manager.query(
      `SELECT dpr.id                AS revision_id,
              dpr.revision_number   AS revision_number,
              rt.name               AS revision_type_name,
              count(r.id)           AS n
         FROM revised_equipment_project_groups r
         JOIN development_plan_revision dpr
           ON dpr.id = r.development_plan_revision_id
         LEFT JOIN revision_type rt
           ON rt.id = dpr.revision_type_id
        WHERE dpr.development_plan_id = $1
          AND r.deleted_at IS NULL
        GROUP BY dpr.id, dpr.revision_number, rt.name`,
      [developmentPlanId],
    );

    const supRows: Array<{
      supplement_id: string;
      supplement_number: number | null;
      n: string;
    }> = await manager.query(
      `SELECT dps.id                AS supplement_id,
              dps.supplement_number AS supplement_number,
              count(s.id)           AS n
         FROM supplement_equipment_project_groups s
         JOIN development_plan_supplement dps
           ON dps.id = s.development_plan_supplement_id
        WHERE dps.development_plan_id = $1
          AND s.deleted_at IS NULL
        GROUP BY dps.id, dps.supplement_number`,
      [developmentPlanId],
    );

    return {
      main: Number(mainRows[0]?.n ?? 0),
      byRevision: revRows.map((r) => ({
        revisionId: r.revision_id,
        revisionNumber: Number(r.revision_number ?? 0),
        // 'แก้ไข' fallback mirrors the aggregator/W58 default.
        revisionTypeName: r.revision_type_name ?? 'แก้ไข',
        itemCount: Number(r.n ?? 0),
      })),
      bySupplement: supRows.map((s) => ({
        supplementId: s.supplement_id,
        supplementNumber: Number(s.supplement_number ?? 0),
        itemCount: Number(s.n ?? 0),
      })),
    };
  }

  /**
   * Shared executive-list pipeline parameterised by an optional area
   * scope. `executiveList` (null → system-wide) and `staffList` (area
   * scope) both delegate here so the W67 strip/tag post-processing is
   * single-sourced and the two responses are byte-identical except for
   * the rows the scope admits.
   *
   * `areaScope = null` → loaders run with no extra WHERE (system-wide).
   * `areaScope` set → EPG scoped by `amphoeIds`, RELPG scoped by
   * `agencyIds` (OR across dimensions, NOT AND — EPG is amphoe-bound,
   * RELPG is agency-bound, matching the §3 / §4.1 staff rule).
   */
  private async executiveListWithScope(
    query: { developmentPlanId?: string },
    areaScope: { amphoeIds: string[]; agencyIds: string[] } | null,
    // Wave AI-EXEC-CHAT-DOCUMENT-EQUIPMENT-LISTING — `true` → document-level
    // (all EPG/RELPG/SEPG rows per book, no HEAD REPLACE). The W67 in-flight
    // strip + `executiveStatusGroup` tag below are applied IDENTICALLY in
    // both modes so the executive never sees an in-flight row (§51).
    includeSuperseded = false,
  ): Promise<UnifiedEquipmentRow[]> {
    const merged = await this.loadMergedHeadRows(
      query.developmentPlanId,
      null,
      areaScope,
      includeSuperseded,
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
    areaScope: { amphoeIds: string[]; agencyIds: string[] } | null = null,
    // Wave AI-EXEC-CHAT-DOCUMENT-EQUIPMENT-LISTING — `true` skips the §14.2
    // HEAD anti-join in the EPG/RELPG loaders (document-level view).
    includeSuperseded = false,
  ): Promise<UnifiedEquipmentRow[]> {
    // EPG is amphoe-bound; RELPG is agency-bound (§3 / §4.1). A dimension
    // with zero ids under an active area scope yields no rows for that
    // kind (fail-closed) — the loader receives an empty id array and
    // emits the no-match `1 = 0` guard.
    const epgAmphoeIds = areaScope ? areaScope.amphoeIds : null;
    const relpgAgencyIds = areaScope ? areaScope.agencyIds : null;
    // SEPG (ครุภัณฑ์ เล่มเพิ่มเติม) is agency-scoped for staff, matching
    // `StaffHomeService.aggregateSupplementLane` (both SPG and SEPG fan
    // out by `responsible_agency_id`). A SEPG CAN now be revised (RELPG
    // with `prev_project_type = 'supplement_equipment'`), so the HEAD
    // anti-join IS applied inside `loadSepgHeadRows` (see there).
    const sepgAgencyIds = areaScope ? areaScope.agencyIds : null;
    const [epgRows, relpgRows, sepgRows] = await Promise.all([
      this.loadEpgHeadRows(
        developmentPlanId,
        ownerWorkHistoryId,
        epgAmphoeIds,
        includeSuperseded,
      ),
      this.loadRelpgHeadRows(
        developmentPlanId,
        ownerWorkHistoryId,
        relpgAgencyIds,
        includeSuperseded,
      ),
      this.loadSepgHeadRows(
        developmentPlanId,
        ownerWorkHistoryId,
        sepgAgencyIds,
        includeSuperseded,
      ),
    ]);

    const merged = [...epgRows, ...relpgRows, ...sepgRows];
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
    /**
     * §3 / §4.1 area scope. `null` → no amphoe filter (system-wide /
     * admin bypass). A non-null (possibly empty) array → scope EPGs to
     * `epg.amphoe_id IN (...)`; an EMPTY array is the fail-closed
     * no-match (`1 = 0`), never a global scan.
     */
    amphoeIds: string[] | null = null,
    /**
     * Wave AI-EXEC-CHAT-DOCUMENT-EQUIPMENT-LISTING — when `true`, SKIP the
     * §14.2 HEAD anti-join so a main-book EPG that was later revised still
     * surfaces in its own book (document-level view — matches the physical
     * ผ.03 book and `documentCountsByBook`). Default `false` preserves the
     * HEAD-of-lineage REPLACE semantic used by the executive/owner lists.
     */
    includeSuperseded = false,
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
      .leftJoinAndSelect('epg.amphoe', 'epgAmphoe')
      .leftJoinAndSelect('epg.localAdministrativeOrganization', 'epgLao')
      .leftJoinAndSelect('epg.budgets', 'budgets')
      .leftJoinAndSelect('epg.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .where('epg.deletedAt IS NULL');

    if (!includeSuperseded) {
      // §14.2 HEAD anti-join — drop EPGs that already have a live RELPG.
      qb.leftJoin(
        RevisedEquipmentProjectGroup,
        'epg_desc',
        `epg_desc.prev_project_id = epg.id ` +
          `AND epg_desc.prev_project_type = 'equipment' ` +
          `AND epg_desc.deleted_at IS NULL`,
      ).andWhere('epg_desc.id IS NULL');
    }

    if (developmentPlanId) {
      qb.andWhere('developmentPlan.id = :planId', {
        planId: developmentPlanId,
      });
    }
    if (ownerWorkHistoryId) {
      qb.andWhere('createdBy.id = :ownerId', { ownerId: ownerWorkHistoryId });
    }
    if (amphoeIds !== null) {
      if (amphoeIds.length === 0) {
        // Fail-closed: staff with no responsible amphoes sees no EPGs.
        qb.andWhere('1 = 0');
      } else {
        qb.andWhere('epg.amphoe_id IN (:...amphoeIds)', { amphoeIds });
      }
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
    /**
     * §3 / §4.1 area scope. `null` → no agency filter (system-wide /
     * admin bypass). A non-null (possibly empty) array → scope RELPGs to
     * `relpg.responsible_agency_id IN (...)`; an EMPTY array is the
     * fail-closed no-match (`1 = 0`), never a global scan.
     */
    agencyIds: string[] | null = null,
    /**
     * Wave AI-EXEC-CHAT-DOCUMENT-EQUIPMENT-LISTING — when `true`, SKIP the
     * §14.2 HEAD anti-join so a RELPG that was later re-revised still
     * surfaces in its own revision book (document-level view). Default
     * `false` keeps the chain-head-only REPLACE semantic.
     */
    includeSuperseded = false,
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
      .leftJoinAndSelect('relpg.amphoe', 'relpgAmphoe')
      .leftJoinAndSelect('relpg.localAdministrativeOrganization', 'relpgLao')
      .leftJoinAndSelect('relpg.budgets', 'budgets')
      .leftJoinAndSelect('relpg.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .where('relpg.deletedAt IS NULL');

    if (!includeSuperseded) {
      // §14.2 HEAD anti-join — keep only RELPG chain heads.
      qb.leftJoin(
        RevisedEquipmentProjectGroup,
        'relpg_desc',
        `relpg_desc.prev_project_id = relpg.id ` +
          `AND relpg_desc.prev_project_type = 'revised_equipment' ` +
          `AND relpg_desc.deleted_at IS NULL`,
      ).andWhere('relpg_desc.id IS NULL');
    }

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
    if (agencyIds !== null) {
      if (agencyIds.length === 0) {
        // Fail-closed: staff with no responsible agencies sees no RELPGs.
        qb.andWhere('1 = 0');
      } else {
        qb.andWhere('relpg.responsible_agency_id IN (:...agencyIds)', {
          agencyIds,
        });
      }
    }

    const rows = await qb.getMany();
    return rows.map((relpg) => this.projectRelpg(relpg));
  }

  // ──────────────────────────────────────────────────────────────────
  //  SEPG head rows — ครุภัณฑ์ ผ.03 under DevelopmentPlanSupplement.
  //  §14 lineage is NO LONGER vacuous: a SEPG can be revised into a DPR
  //  context, creating a RevisedEquipmentProjectGroup with
  //  `prev_project_type = 'supplement_equipment'` (see
  //  `PrevEquipmentProjectType`). When such a live RELPG descendant
  //  exists the SEPG is superseded and MUST be dropped from the head
  //  view — else it appears twice (once under เพิ่มเติมครุภัณฑ์ here, once
  //  under its แก้ไข/เปลี่ยนแปลง round via `loadRelpgHeadRows`). §10
  //  plan-scope resolves via the parent supplement's developmentPlan.
  // ──────────────────────────────────────────────────────────────────

  private async loadSepgHeadRows(
    developmentPlanId: string | undefined,
    ownerWorkHistoryId: string | null,
    /**
     * §3 / §4.1 area scope. SEPG is agency-scoped for staff (mirrors
     * `StaffHomeService.aggregateSupplementLane`'s
     * `responsible_agency_id` fan-out). `null` → system-wide / admin
     * bypass. EMPTY array → fail-closed `1 = 0` no-match.
     */
    agencyIds: string[] | null = null,
    // Wave AI-EXEC-CHAT-DOCUMENT-EQUIPMENT-LISTING — `true` skips the §14.2
    // HEAD anti-join (document-level view), matching the EPG/RELPG loaders.
    includeSuperseded = false,
  ): Promise<UnifiedEquipmentRow[]> {
    const qb = this.sepgRepo
      .createQueryBuilder('sepg')
      .leftJoinAndSelect('sepg.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect(
        'sepg.developmentPlanSupplement',
        'developmentPlanSupplement',
      )
      .leftJoinAndSelect(
        'developmentPlanSupplement.developmentPlan',
        'developmentPlan',
      )
      .leftJoinAndSelect('sepg.strategy', 'strategy')
      .leftJoinAndSelect('sepg.tactic', 'tactic')
      .leftJoinAndSelect('sepg.plan', 'plan')
      .leftJoinAndSelect('sepg.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('sepg.equipmentCategory', 'equipmentCategory')
      .leftJoinAndSelect('sepg.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('sepg.amphoe', 'sepgAmphoe')
      .leftJoinAndSelect('sepg.localAdministrativeOrganization', 'sepgLao')
      .leftJoinAndSelect('sepg.budgets', 'budgets')
      .leftJoinAndSelect('sepg.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .where('sepg.deletedAt IS NULL');

    if (!includeSuperseded) {
      // §14.2 HEAD anti-join — drop SEPGs that a live RELPG has revised
      // (prev_project_type = 'supplement_equipment'). Mirrors the EPG /
      // RELPG anti-joins; keyed on the RevisedEquipmentProjectGroup entity
      // so no raw table literal is introduced.
      qb.leftJoin(
        RevisedEquipmentProjectGroup,
        'sepg_desc',
        `sepg_desc.prev_project_id = sepg.id ` +
          `AND sepg_desc.prev_project_type = 'supplement_equipment' ` +
          `AND sepg_desc.deleted_at IS NULL`,
      ).andWhere('sepg_desc.id IS NULL');
    }

    if (developmentPlanId) {
      qb.andWhere('developmentPlan.id = :planId', {
        planId: developmentPlanId,
      });
    }
    if (ownerWorkHistoryId) {
      qb.andWhere('createdBy.id = :ownerId', { ownerId: ownerWorkHistoryId });
    }
    if (agencyIds !== null) {
      if (agencyIds.length === 0) {
        // Fail-closed: staff with no responsible agencies sees no SEPGs.
        qb.andWhere('1 = 0');
      } else {
        qb.andWhere('sepg.responsible_agency_id IN (:...agencyIds)', {
          agencyIds,
        });
      }
    }

    const rows = await qb.getMany();
    return rows.map((sepg) => this.projectSepg(sepg));
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
      // §20.3 Invariant 1 — the per-row `is_booked` is the canonical
      // source. Fall back to the parent book's flag so rows whose
      // finalize path predates the §20.3 stamping rollout (or whose
      // assembly merge doesn't yet stamp them — see §20.2 Phase 3
      // deferral for the EDIT/CHANGE-side RELPG case) still surface
      // the correct "เข้าเล่มแล้ว" affordance to the staff browse view.
      isBooked: Boolean(epg.isBooked) || Boolean(plan?.isBooked),
      bookedAt: this.toIso(epg.bookedAt ?? plan?.bookedAt ?? null),
      pageNumber: epg.pageNumber ?? null,
      budgets: this.projectBudgets(epg.budgets),
      createdBy: epg.createdBy
        ? {
            workHistoryId: epg.createdBy.id,
            firstName: this.creatorFirstName(epg.createdBy),
            lastName: this.creatorLastName(epg.createdBy),
            profileImageUrl: this.creatorProfileImage(epg.createdBy),
          }
        : null,
      createdByWorkHistoryId: epg.createdBy?.id ?? null,
      responsibleAgency: epg.responsibleAgency
        ? {
            id: epg.responsibleAgency.id,
            name: epg.responsibleAgency.name ?? null,
          }
        : null,
      amphoe: epg.amphoe ? { id: epg.amphoe.id, name: epg.amphoe.name ?? null } : null,
      localAdministrativeOrganization: epg.localAdministrativeOrganization
        ? { id: epg.localAdministrativeOrganization.id, name: epg.localAdministrativeOrganization.name ?? null }
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
      // §20.3 Invariant 1 — fall back to the parent revision's flag.
      // This covers the §20.2 Phase 3 deferral: the EDIT/CHANGE
      // assembly `merge()` does NOT yet stamp `is_booked` /
      // `booked_at` on RELPG rows on finalize, so the row-level
      // column stays false even after the revision book is published.
      // Reading through the parent DPR surfaces the correct booked
      // affordance until Phase 3 ships per-row stamping.
      isBooked: Boolean(relpg.isBooked) || Boolean(dpr?.isBooked),
      bookedAt: this.toIso(relpg.bookedAt ?? dpr?.bookedAt ?? null),
      pageNumber: relpg.pageNumber ?? null,
      budgets: this.projectBudgets(relpg.budgets),
      createdBy: relpg.createdBy
        ? {
            workHistoryId: relpg.createdBy.id,
            firstName: this.creatorFirstName(relpg.createdBy),
            lastName: this.creatorLastName(relpg.createdBy),
            profileImageUrl: this.creatorProfileImage(relpg.createdBy),
          }
        : null,
      createdByWorkHistoryId: relpg.createdBy?.id ?? null,
      responsibleAgency: relpg.responsibleAgency
        ? {
            id: relpg.responsibleAgency.id,
            name: relpg.responsibleAgency.name ?? null,
          }
        : null,
      amphoe: relpg.amphoe ? { id: relpg.amphoe.id, name: relpg.amphoe.name ?? null } : null,
      localAdministrativeOrganization: relpg.localAdministrativeOrganization
        ? { id: relpg.localAdministrativeOrganization.id, name: relpg.localAdministrativeOrganization.name ?? null }
        : null,
      createdAt: this.toIso(relpg.createdAt) ?? new Date(0).toISOString(),
    };
  }

  private projectSepg(
    sepg: SupplementEquipmentProjectGroup,
  ): UnifiedEquipmentRow {
    const dps = sepg.developmentPlanSupplement;
    const plan = dps?.developmentPlan;
    return {
      kind: 'supplement-equipment',
      id: sepg.id,
      equipmentName: sepg.equipmentName ?? '',
      targetOutput: sepg.targetOutput ?? null,
      expectedResults: sepg.expectedResults ?? null,
      indicator: sepg.indicator ?? null,
      equipmentCategory: sepg.equipmentCategory
        ? {
            id: sepg.equipmentCategory.id,
            code: sepg.equipmentCategory.code,
            name: sepg.equipmentCategory.name,
          }
        : null,
      strategy: this.classificationLite(sepg.strategy),
      tactic: this.classificationLite(sepg.tactic),
      plan: this.classificationLite(sepg.plan),
      developmentIssue: this.classificationLite(sepg.developmentIssue),
      developmentPlan: {
        id: plan?.id ?? '',
        name: plan?.name ?? '',
        startYear: plan?.startYear ?? null,
        endYear: plan?.endYear ?? null,
        isLatest: plan?.isLatest ?? false,
        isBooked: plan?.isBooked ?? false,
        reportFormat:
          (plan?.reportFormat as 'STRATEGY_BASED' | 'ISSUE_BASED') ??
          'STRATEGY_BASED',
      },
      developmentPlanRevision: undefined,
      developmentPlanSupplement: dps
        ? {
            id: dps.id,
            supplementNumber: dps.supplementNumber ?? null,
            description: dps.description ?? null,
            isOpen: dps.isOpen ?? false,
            isBooked: dps.isBooked ?? false,
          }
        : undefined,
      status: this.latestStatus(sepg.trackingStatus),
      // §14 lineage is vacuous in SEPG v1 — no descendants by construction.
      hasDescendant: false,
      // §20.3 Invariant 1 — fall back to the parent supplement's
      // flag (mirrors the EPG/RELPG fallback pattern above). The
      // SUPPLEMENT assembly `merge()` stamps SEPG.is_booked per the
      // SEPG wave, but reading through the parent dps is a safety
      // net for any row whose finalize predates that stamping.
      isBooked: Boolean(sepg.isBooked) || Boolean(dps?.isBooked),
      bookedAt: this.toIso(sepg.bookedAt ?? dps?.bookedAt ?? null),
      pageNumber: sepg.pageNumber ?? null,
      budgets: this.projectBudgets(sepg.budgets),
      createdBy: sepg.createdBy
        ? {
            workHistoryId: sepg.createdBy.id,
            firstName: this.creatorFirstName(sepg.createdBy),
            lastName: this.creatorLastName(sepg.createdBy),
            profileImageUrl: this.creatorProfileImage(sepg.createdBy),
          }
        : null,
      createdByWorkHistoryId: sepg.createdBy?.id ?? null,
      responsibleAgency: sepg.responsibleAgency
        ? {
            id: sepg.responsibleAgency.id,
            name: sepg.responsibleAgency.name ?? null,
          }
        : null,
      amphoe: sepg.amphoe ? { id: sepg.amphoe.id, name: sepg.amphoe.name ?? null } : null,
      localAdministrativeOrganization: sepg.localAdministrativeOrganization
        ? { id: sepg.localAdministrativeOrganization.id, name: sepg.localAdministrativeOrganization.name ?? null }
        : null,
      createdAt: this.toIso(sepg.createdAt) ?? new Date(0).toISOString(),
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

  // Public avatar URL only (not contact PII) — mirrors the project list so the
  // owner-table creator avatar renders a photo instead of initials. The DB
  // stores a RELATIVE path (`/uploads/profiles/…`), so we prefix APP_URL to
  // hand the FE an absolute URL (a bare relative path would resolve against the
  // frontend origin and 404 → fall back to initials).
  private creatorProfileImage(wh: WorkHistory): string | null {
    const u = (wh as unknown as { user?: { profileImageUrl?: string } }).user;
    const raw = u?.profileImageUrl ?? null;
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw)) return raw;
    const base = (process.env.APP_URL ?? '').replace(/\/+$/, '');
    return base ? `${base}${raw.startsWith('/') ? '' : '/'}${raw}` : raw;
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

  /**
   * Load the caller's current WorkHistory with the role + responsibility
   * relations needed for the §3 / §4.1 staff area-scope resolution.
   * Relation set is VERBATIM the one used by `StaffHomeService.getOverdue`
   * (single-sourced scoping rule). Returns `null` (graceful empty) when
   * the user has no current WorkHistory.
   */
  private async loadStaffWorkHistory(
    userId: string,
  ): Promise<WorkHistory | null> {
    if (!userId) {
      throw new UnauthorizedException('UNAUTHENTICATED');
    }
    return this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: [
        'role',
        'workStatus',
        'workHistoryResponsibleAmphoe',
        'workHistoryResponsibleAmphoe.amphoe',
        'workHistoryResponsibleGovernmentAgency',
        'workHistoryResponsibleGovernmentAgency.governmentAgency',
      ],
    });
  }
}
