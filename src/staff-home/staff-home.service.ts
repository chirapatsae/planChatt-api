import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TrackingStatus } from '../tracking-status/entities/tracking-status.entity';
import { WorkHistory } from '../work-history/entities/work-history.entity';
import {
  StaffOverdueBookKind,
  StaffOverdueBucketDef,
  StaffOverdueBucketKey,
  StaffOverdueItem,
  StaffOverdueLane,
  StaffOverdueLaneEntry,
  StaffOverdueResponseDto,
  StaffOverdueStage,
  StaffOverdueStageEntry,
} from './dto/staff-overdue.dto';

/**
 * StaffHomeService — area-scoped, read-only aging/overdue aggregator.
 *
 * Wave: wave-staff-review-dashboard, Phase 2 (PHASE2-BE-01).
 * Drill-down enrichment: wave-staff-home-actionable (BE-01, 2026-06-07).
 * Contract: docs/tasks/wave-staff-home-actionable/DOCS-01-RESULT-composition-and-drilldown-contract.md
 *
 * CLAUDE.md compliance:
 *   - §1 / §3 / §4.1 — staff-lead authority; staff are AREA-FILTERED via the
 *     same responsibility-table mechanism the existing review queues use
 *     (`WorkHistoryAmphoeResponsibility` for PG/equipment amphoe scope,
 *     `WorkHistoryGovernmentAgencyResponsibility` for RPG/RELPG/SPG agency
 *     scope). admin / super-admin bypass. No new scoping rule is invented.
 *     The BE-01 enrichment adds SELECT columns + parent-book JOINs on the
 *     SAME area-filtered row set — it does NOT widen the WHERE clause.
 *   - §10 — age is bound to each project's OWN latest TrackingStatus
 *     (`is_latest = true`). No global scan for plain staff (fail-closed).
 *   - §12 — age derived from `tracking_status.create_at`; no new timestamp.
 *   - §17.2 / §18.13 — strictly advisory + read-side aggregator: ZERO writes.
 *     Every method issues only SELECTs. `bookLabel` / `actionRoute` /
 *     `detailRoute` / `historyRoute` are computed, never stored.
 */
@Injectable()
export class StaffHomeService {
  /** Lower bound (days) of the overdue bucket. */
  private static readonly OVERDUE_THRESHOLD_DAYS = 15;

  /** Top-N drill items per lane×stage (DOCS-01 §7.1 DECISION-A). */
  private static readonly TOP_N_PER_STAGE = 5;

  /** Fixed bucket dictionary, contract order. */
  private static readonly BUCKETS: StaffOverdueBucketDef[] = [
    { key: 'd0_3', labelTh: '0-3 วัน', minDays: 1, maxDays: 3 },
    { key: 'd4_7', labelTh: '4-7 วัน', minDays: 4, maxDays: 7 },
    { key: 'd8_14', labelTh: '8-14 วัน', minDays: 8, maxDays: 14 },
    { key: 'd15p', labelTh: '15 วันขึ้นไป', minDays: 15, maxDays: null },
  ];

  private static readonly STAGES: StaffOverdueStage[] = [
    'Pending',
    'Verified',
    'Pending_Approval',
  ];

  private static readonly STAGE_LABEL_TH: Record<StaffOverdueStage, string> = {
    Pending: 'รอตรวจสอบ',
    Verified: 'ตรวจแล้ว',
    Pending_Approval: 'รออนุมัติ',
  };

  private static readonly LANE_LABEL_TH: Record<StaffOverdueLane, string> = {
    mainPlan: 'เล่มหลัก',
    revisionEdit: 'แก้ไข',
    revisionChange: 'เปลี่ยนแปลง',
    supplement: 'เพิ่มเติม',
    equipment: 'ครุภัณฑ์',
  };

  /** Combined เล่ม label for revision-book drill items (RPG/RELPG) — used as
   *  the `composeBookLabel` fallback when the parent plan name is absent. Kept
   *  as the pre-split "แก้ไข/เปลี่ยนแปลง" wording (the lane is now split, but a
   *  single drill item is still "in the revision book"). */
  private static readonly REVISION_BASE_LABEL = 'แก้ไข/เปลี่ยนแปลง';

  /**
   * Canonical review-page deep-links per (bookKind × stage).
   *
   * DOCS-01 §9 route-resolution table — the BE-owned single source of truth
   * (DECISION-B). Mirrors the FE `OVERDUE_LINKS` map verbatim and resolves
   * the §9.1 gaps deliberately:
   *   - `change` Verified → `/revise/change/admin/print` (registered route,
   *     navigated to from `ReviseAdminChangeDashboard.tsx`; symmetric with
   *     the pending/approval pair).
   *   - `revised-equipment` (RELPG) → folded onto the `/revise/edit/admin/*`
   *     queue (no dedicated RELPG admin queue route exists; LOCKED v1
   *     behavior per §9.1.2 — the drawer still exposes RELPG-specific
   *     detail/history routes below).
   *   - `supplement` detail → null (no version-detail route today, §9.1.3).
   */
  private static readonly ACTION_ROUTE: Record<
    StaffOverdueBookKind,
    Record<StaffOverdueStage, string>
  > = {
    mainPlan: {
      Pending: '/agency/admin/pending',
      Verified: '/agency/admin/print-presentation',
      Pending_Approval: '/agency/admin/ready-to-approved',
    },
    edit: {
      Pending: '/revise/edit/admin/pending',
      Verified: '/revise/edit/admin/print',
      Pending_Approval: '/revise/edit/admin/ready-to-approved',
    },
    change: {
      Pending: '/revise/change/admin/pending',
      Verified: '/revise/change/admin/print',
      Pending_Approval: '/revise/change/admin/ready-to-approved',
    },
    supplement: {
      Pending: '/supplement/admin/pending',
      Verified: '/supplement/admin/print-presentation',
      Pending_Approval: '/supplement/admin/ready-to-approved',
    },
    equipment: {
      Pending: '/agency/admin/pending',
      Verified: '/agency/admin/print-presentation',
      Pending_Approval: '/agency/admin/ready-to-approved',
    },
    'revised-equipment': {
      // §9.1.2 — folded onto the edit-revision admin queue (no dedicated
      // RELPG admin review queue route exists in the current route table).
      Pending: '/revise/edit/admin/pending',
      Verified: '/revise/edit/admin/print',
      Pending_Approval: '/revise/edit/admin/ready-to-approved',
    },
    'supplement-equipment': {
      // SEPG (ผ.03 เล่มเพิ่มเติม) — folded onto the supplement admin queue
      // (the SEPG staff review tab lives on the supplement admin pages).
      Pending: '/supplement/admin/pending',
      Verified: '/supplement/admin/print-presentation',
      Pending_Approval: '/supplement/admin/ready-to-approved',
    },
  };

  private static readonly STAFF_LEAD_ROLES = ['staff', 'admin', 'super-admin'];

  constructor(
    @InjectRepository(TrackingStatus)
    private readonly trackingStatusRepo: Repository<TrackingStatus>,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,
  ) {}

  /**
   * GET /v1/staff-home/overdue handler. Read-only.
   *
   * Validation order (CLAUDE.md VALIDATION ORDER + existing review queues):
   *   1. authenticated user (JWT — guard)
   *   2. current WorkHistory (absent → graceful all-zero DTO)
   *   3. workStatus = approved (else 401)
   *   4. role gate: staff-lead (else 403)
   *   5. resolve area scope, aggregate, project.
   */
  async getOverdue(userId: string): Promise<StaffOverdueResponseDto> {
    const workHistory = await this.workHistoryRepo.findOne({
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

    // No current WorkHistory → graceful empty (mirrors review-queue `return []`).
    if (!workHistory) {
      return this.emptyResponse();
    }

    // §2 Work Status Rule.
    if (workHistory.workStatus?.name !== 'approved') {
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');
    }

    // §3 staff-lead authority gate.
    const role = workHistory.role?.name;
    if (!role || !StaffHomeService.STAFF_LEAD_ROLES.includes(role)) {
      throw new ForbiddenException('STAFF_HOME_FORBIDDEN');
    }

    const bypassAreaFilter = role === 'admin' || role === 'super-admin';

    // §3 / §4.1 area scope — same mechanism as the review queues.
    const responsibleAmphoeIds = (workHistory.workHistoryResponsibleAmphoe ?? [])
      .map((r) => r.amphoe?.id)
      .filter((id): id is string => !!id);
    const responsibleAgencyIds = (
      workHistory.workHistoryResponsibleGovernmentAgency ?? []
    )
      .map((r) => r.governmentAgency?.id)
      .filter((id): id is string => !!id);

    const lanes: StaffOverdueLaneEntry[] = [
      await this.aggregateLane('mainPlan', 'projectGroupId', 'project_groups', {
        scopeColumn: 'amphoe_id',
        scopeIds: responsibleAmphoeIds,
        bypassAreaFilter,
        titleColumn: 'title',
        excludeDraft: true,
        bookKind: 'mainPlan',
        bookJoin: 'plan',
      }),
      await this.aggregateRevisionEditLane(responsibleAgencyIds, bypassAreaFilter),
      await this.aggregateRevisionChangeLane(responsibleAgencyIds, bypassAreaFilter),
      await this.aggregateSupplementLane(
        responsibleAgencyIds,
        bypassAreaFilter,
      ),
      await this.aggregateLane(
        'equipment',
        'equipmentProjectGroupId',
        'equipment_project_groups',
        {
          scopeColumn: 'amphoe_id',
          scopeIds: responsibleAmphoeIds,
          bypassAreaFilter,
          titleColumn: 'equipment_name',
          excludeDraft: false,
          bookKind: 'equipment',
          bookJoin: 'plan',
        },
      ),
    ];

    let totalOverdue = 0;
    let totalAging = 0;
    for (const lane of lanes) {
      for (const stage of lane.stages) {
        totalOverdue += stage.overdue;
        totalAging += stage.total;
      }
    }

    return {
      asOf: new Date().toISOString(),
      overdueThresholdDays: StaffHomeService.OVERDUE_THRESHOLD_DAYS,
      buckets: StaffHomeService.BUCKETS,
      totalOverdue,
      totalAging,
      lanes,
    };
  }

  /**
   * The revision books (RPG + RELPG, both agency-scoped per §14/§18) are
   * surfaced as TWO lanes split by parent `revision_type.name`:
   * `revisionEdit` (แก้ไข) and `revisionChange` (เปลี่ยนแปลง). 2026-07-14 —
   * previously one combined `revision` lane.
   *
   * Each lane merges its RPG + RELPG halves (both filtered to the SAME
   * revision type via `revisionTypePredicate`). Item-level `bookKind` /
   * `actionRoute` are UNCHANGED: RPG → `edit`/`change` (per-row from
   * revision_type.name); RELPG → `revised-equipment` (DOCS-01 §7.4, still
   * routed to the /revise/edit admin queue per §9.1.2). Splitting is a pure
   * lane repartition — the RPG-edit/RPG-change/RELPG-edit/RELPG-change
   * sub-queries partition the exact same row set, so per-bucket counts and
   * `totalOverdue` reconcile with the pre-split combined lane.
   */
  private aggregateRevisionEditLane(
    responsibleAgencyIds: string[],
    bypassAreaFilter: boolean,
  ): Promise<StaffOverdueLaneEntry> {
    return this.aggregateRevisionTypeLane(
      'revisionEdit',
      'edit',
      responsibleAgencyIds,
      bypassAreaFilter,
    );
  }

  private aggregateRevisionChangeLane(
    responsibleAgencyIds: string[],
    bypassAreaFilter: boolean,
  ): Promise<StaffOverdueLaneEntry> {
    return this.aggregateRevisionTypeLane(
      'revisionChange',
      'change',
      responsibleAgencyIds,
      bypassAreaFilter,
    );
  }

  /** Shared body — merge the RPG + RELPG halves for ONE revision type. */
  private async aggregateRevisionTypeLane(
    lane: 'revisionEdit' | 'revisionChange',
    revisionTypePredicate: 'edit' | 'change',
    responsibleAgencyIds: string[],
    bypassAreaFilter: boolean,
  ): Promise<StaffOverdueLaneEntry> {
    const rpg = await this.aggregateLane(
      lane,
      'revisedProjectGroupId',
      'revised_project_groups',
      {
        scopeColumn: 'responsible_agency_id',
        scopeIds: responsibleAgencyIds,
        bypassAreaFilter,
        titleColumn: 'title',
        excludeDraft: false,
        // RPG bookKind is resolved per-row from revision_type.name.
        bookKind: 'edit',
        bookJoin: 'revision',
        revisionTypePredicate,
      },
    );
    const relpg = await this.aggregateLane(
      lane,
      'revisedEquipmentProjectGroupId',
      'revised_equipment_project_groups',
      {
        scopeColumn: 'responsible_agency_id',
        scopeIds: responsibleAgencyIds,
        bypassAreaFilter,
        titleColumn: 'equipment_name',
        excludeDraft: false,
        bookKind: 'revised-equipment',
        bookJoin: 'revision',
        revisionTypePredicate,
      },
    );
    return this.mergeLanes(rpg, relpg);
  }

  /**
   * The `supplement` lane folds SPG + SEPG into one lane (both supplement-book
   * agency-scoped per §5.3 SEPG). Aggregate each then merge stage-by-stage.
   * SPG → `supplement`; SEPG → `supplement-equipment` (ผ.03 เล่มเพิ่มเติม),
   * each keeping its OWN `bookKind` / `actionRoute`.
   */
  private async aggregateSupplementLane(
    responsibleAgencyIds: string[],
    bypassAreaFilter: boolean,
  ): Promise<StaffOverdueLaneEntry> {
    const spg = await this.aggregateLane(
      'supplement',
      'supplementProjectGroupId',
      'supplement_project_groups',
      {
        scopeColumn: 'responsible_agency_id',
        scopeIds: responsibleAgencyIds,
        bypassAreaFilter,
        titleColumn: 'title',
        excludeDraft: true,
        bookKind: 'supplement',
        bookJoin: 'supplement',
      },
    );
    const sepg = await this.aggregateLane(
      'supplement',
      'supplementEquipmentProjectGroupId',
      'supplement_equipment_project_groups',
      {
        scopeColumn: 'responsible_agency_id',
        scopeIds: responsibleAgencyIds,
        bypassAreaFilter,
        titleColumn: 'equipment_name',
        excludeDraft: false,
        bookKind: 'supplement-equipment',
        bookJoin: 'supplement',
      },
    );
    return this.mergeLanes(spg, sepg);
  }

  /**
   * Aggregate a single project sub-type into a lane entry.
   *
   * Issues ONLY SELECTs against `tracking_status` joined to the target table
   * plus the parent-book chain (plan / revision / supplement) for the
   * drill-down `bookLabel`. Latest-status (`is_latest = true`), non-deleted
   * rows in the three review stages, area-filtered for plain staff.
   */
  private async aggregateLane(
    lane: StaffOverdueLane,
    fkProperty:
      | 'projectGroupId'
      | 'revisedProjectGroupId'
      | 'supplementProjectGroupId'
      | 'equipmentProjectGroupId'
      | 'revisedEquipmentProjectGroupId'
      | 'supplementEquipmentProjectGroupId',
    tableName: string,
    opts: {
      scopeColumn: 'amphoe_id' | 'responsible_agency_id';
      scopeIds: string[];
      bypassAreaFilter: boolean;
      titleColumn: 'title' | 'equipment_name';
      excludeDraft: boolean;
      /** static fallback bookKind (RPG rows are re-resolved per-row). */
      bookKind: StaffOverdueBookKind;
      /** which parent-book chain to JOIN for the human เล่ม label. */
      bookJoin: 'plan' | 'revision' | 'supplement';
      /**
       * Restrict a revision-book aggregation to ONE revision_type
       * (2026-07-14, revisionEdit/revisionChange lane split). Only honoured
       * when `bookJoin === 'revision'`. 'change' = rows whose parent
       * `revision_type.name = เปลี่ยนแปลง`; 'edit' = the TOTAL catch-all
       * (`<> เปลี่ยนแปลง OR IS NULL`) — mirrors `resolveBookKind` so an item's
       * lane and its bookKind can never disagree, and the two predicates
       * partition the RPG/RELPG row set exactly (no drop, no double-count).
       */
      revisionTypePredicate?: 'edit' | 'change';
    },
  ): Promise<StaffOverdueLaneEntry> {
    // Fail-closed: plain staff with zero responsibilities for this scope sees
    // nothing (mirrors the existing `1 = 0` guard). Never a global scan.
    if (!opts.bypassAreaFilter && opts.scopeIds.length === 0) {
      return this.emptyLane(lane);
    }

    const qb = this.trackingStatusRepo
      .createQueryBuilder('ts')
      .select('proj.id', 'projectid')
      .addSelect(`proj.${opts.titleColumn}`, 'title')
      .addSelect('status.name', 'statusname')
      .addSelect('status.th_name', 'statusth')
      .addSelect('ts.createAt', 'createat')
      .innerJoin('ts.statusId', 'status')
      .innerJoin(tableName, 'proj', `proj.id = ts.${this.fkColumn(fkProperty)}`)
      .where('ts.isLatest = :latest', { latest: true })
      .andWhere('ts.deletedAt IS NULL')
      .andWhere('proj.deleted_at IS NULL')
      .andWhere('status.name IN (:...stages)', {
        stages: StaffHomeService.STAGES,
      });

    // Booked-state columns (§20 Invariant 1 / §5.3). PG / RPG / SPG name these
    // with TypeORM's default camelCase column names (`isBooked` / `pageNumber`)
    // → must be double-quoted in raw SQL. EPG / RELPG use snake-cased
    // `is_booked` / `page_number`; per DOCS-01 §7.4 the page number is NOT
    // surfaced for equipment (emit null), so only `isBooked` is selected for
    // those two tables.
    const isEquipmentTable =
      tableName === 'equipment_project_groups' ||
      tableName === 'revised_equipment_project_groups' ||
      tableName === 'supplement_equipment_project_groups';
    if (isEquipmentTable) {
      qb.addSelect('proj.is_booked', 'isbooked');
      // pageNumber intentionally NOT selected (DOCS-01 §7.4 → emit null).
    } else {
      qb.addSelect('proj."isBooked"', 'isbooked');
      qb.addSelect('proj."pageNumber"', 'pagenumber');
    }

    // Parent-book JOINs for the human เล่ม label (DOCS-01 §7.3). SELECT-only.
    if (opts.bookJoin === 'plan') {
      qb.innerJoin('development_plan', 'plan', 'plan.id = proj.development_plan_id')
        .addSelect('plan.name', 'planname');
    } else if (opts.bookJoin === 'revision') {
      qb.innerJoin(
        'development_plan_revision',
        'dpr',
        'dpr.id = proj.development_plan_revision_id',
      )
        .leftJoin('development_plan', 'plan', 'plan.id = dpr.development_plan_id')
        .leftJoin('revision_type', 'rtype', 'rtype.id = dpr.revision_type_id')
        .addSelect('plan.name', 'planname')
        .addSelect('dpr.revision_number', 'revisionnumber')
        .addSelect('rtype.name', 'revisiontypename');

      // Lane split (revisionEdit / revisionChange). 'change' = exact type
      // match; 'edit' = total catch-all incl. a hypothetical null-type row,
      // so the two predicates disjointly partition the whole revision set.
      if (opts.revisionTypePredicate === 'change') {
        qb.andWhere('rtype.name = :changeName', { changeName: 'เปลี่ยนแปลง' });
      } else if (opts.revisionTypePredicate === 'edit') {
        qb.andWhere('(rtype.name <> :changeName OR rtype.name IS NULL)', {
          changeName: 'เปลี่ยนแปลง',
        });
      }
    } else {
      // supplement
      qb.innerJoin(
        'development_plan_supplement',
        'dps',
        'dps.id = proj.development_plan_supplement_id',
      )
        .leftJoin('development_plan', 'plan', 'plan.id = dps.development_plan_id')
        .addSelect('plan.name', 'planname')
        .addSelect('dps.supplement_number', 'supplementnumber');
    }

    if (opts.excludeDraft) {
      // The draft flag column is camelCase (`isDraft`) on project_groups /
      // supplement_project_groups — must be double-quoted in raw SQL.
      qb.andWhere('proj."isDraft" = false');
    }

    if (!opts.bypassAreaFilter) {
      qb.andWhere(`proj.${opts.scopeColumn} IN (:...scopeIds)`, {
        scopeIds: opts.scopeIds,
      });
    }

    const rows: StaffOverdueRawRow[] = await qb.getRawMany();

    return this.foldRowsIntoLane(lane, rows, opts.bookKind);
  }

  private fkColumn(fkProperty: string): string {
    switch (fkProperty) {
      case 'projectGroupId':
        return 'project_group_id';
      case 'revisedProjectGroupId':
        return 'revised_project_group_id';
      case 'supplementProjectGroupId':
        return 'supplement_project_group_id';
      case 'equipmentProjectGroupId':
        return 'equipment_project_group_id';
      case 'revisedEquipmentProjectGroupId':
        return 'revised_equipment_project_group_id';
      case 'supplementEquipmentProjectGroupId':
        return 'supplement_equipment_project_group_id';
      default:
        // Unreachable — fkProperty is a closed union at the call sites.
        throw new Error(`Unknown FK property: ${fkProperty}`);
    }
  }

  /**
   * Resolve the precise `bookKind` for a row. RPG rows branch edit/change on
   * the joined `revision_type.name`; all other sub-types use the static kind
   * passed by the call site (DOCS-01 §7.4).
   */
  private resolveBookKind(
    fallbackKind: StaffOverdueBookKind,
    revisionTypeName: string | null,
  ): StaffOverdueBookKind {
    if (fallbackKind === 'edit' || fallbackKind === 'change') {
      // RPG path — branch on revision type. `เปลี่ยนแปลง` → change, else edit.
      return revisionTypeName === 'เปลี่ยนแปลง' ? 'change' : 'edit';
    }
    return fallbackKind;
  }

  /**
   * Compose the human เล่ม label per bookKind (DOCS-01 §7.3). Falls back to the
   * lane label when the plan name is missing (legacy rows), never an empty
   * string.
   */
  private composeBookLabel(
    bookKind: StaffOverdueBookKind,
    row: StaffOverdueRawRow,
  ): string {
    const planName = row.planname?.trim() || null;
    switch (bookKind) {
      case 'mainPlan':
        return planName ?? StaffHomeService.LANE_LABEL_TH.mainPlan;
      case 'equipment':
        return planName ?? StaffHomeService.LANE_LABEL_TH.equipment;
      case 'edit': {
        const base = planName ?? StaffHomeService.REVISION_BASE_LABEL;
        return `${base} · แก้ไข ครั้งที่ ${row.revisionnumber ?? '-'}`;
      }
      case 'change': {
        const base = planName ?? StaffHomeService.REVISION_BASE_LABEL;
        return `${base} · เปลี่ยนแปลง ครั้งที่ ${row.revisionnumber ?? '-'}`;
      }
      case 'revised-equipment': {
        const base = planName ?? StaffHomeService.REVISION_BASE_LABEL;
        const prefix =
          row.revisiontypename === 'เปลี่ยนแปลง' ? 'เปลี่ยนแปลง' : 'แก้ไข';
        return `${base} · ${prefix} ครั้งที่ ${row.revisionnumber ?? '-'}`;
      }
      case 'supplement':
      case 'supplement-equipment': {
        const base = planName ?? StaffHomeService.LANE_LABEL_TH.supplement;
        return `${base} · ฉบับเพิ่มเติม ครั้งที่ ${row.supplementnumber ?? '-'}`;
      }
      default:
        return planName ?? StaffHomeService.LANE_LABEL_TH.mainPlan;
    }
  }

  /**
   * Read-only detail / history routes per bookKind (DOCS-01 §8.3). These REUSE
   * the routes `ProjectEquipmentBrowser` already navigates to + the App.tsx
   * registrations (lines 416-419). `null` where no canonical route exists —
   * never fabricated.
   */
  private resolveDetailRoute(
    bookKind: StaffOverdueBookKind,
    projectId: string,
  ): string | null {
    switch (bookKind) {
      case 'edit':
      case 'change':
        return `/revision/detail/version/${projectId}`;
      case 'revised-equipment':
        return `/revision/detail/equipment/version/${projectId}`;
      default:
        // mainPlan / supplement / equipment have no per-id version-detail route.
        return null;
    }
  }

  private resolveHistoryRoute(
    bookKind: StaffOverdueBookKind,
    projectId: string,
  ): string | null {
    switch (bookKind) {
      case 'edit':
      case 'change':
        return `/revision/tracking/detail/${projectId}`;
      case 'revised-equipment':
        return `/revision/tracking/equipment/detail/${projectId}`;
      default:
        return null;
    }
  }

  /** Build the enriched drill item from a raw row (DOCS-01 §7.2). Pure. */
  private buildItem(
    row: StaffOverdueRawRow,
    stage: StaffOverdueStage,
    ageDays: number,
    fallbackKind: StaffOverdueBookKind,
  ): StaffOverdueItem {
    const bookKind = this.resolveBookKind(
      fallbackKind,
      row.revisiontypename ?? null,
    );
    return {
      projectId: row.projectid,
      title: row.title ?? null,
      ageDays,
      enteredStatusAt: new Date(row.createat).toISOString(),
      bookKind,
      bookLabel: this.composeBookLabel(bookKind, row),
      stage,
      stageLabelTh: StaffHomeService.STAGE_LABEL_TH[stage],
      statusTh: row.statusth ?? '',
      isBooked: row.isbooked === true,
      pageNumber: row.pagenumber ?? null,
      actionRoute: StaffHomeService.ACTION_ROUTE[bookKind][stage],
      detailRoute: this.resolveDetailRoute(bookKind, row.projectid),
      historyRoute: this.resolveHistoryRoute(bookKind, row.projectid),
    };
  }

  /** Bucket + tally raw rows into the lane DTO. Pure in-memory. */
  private foldRowsIntoLane(
    lane: StaffOverdueLane,
    rows: StaffOverdueRawRow[],
    fallbackKind: StaffOverdueBookKind,
  ): StaffOverdueLaneEntry {
    const now = Date.now();
    const stageMap = new Map<StaffOverdueStage, StaffOverdueStageEntry>();
    const itemsByStage = new Map<StaffOverdueStage, StaffOverdueItem[]>();
    for (const stage of StaffHomeService.STAGES) {
      stageMap.set(stage, this.emptyStage(stage));
      itemsByStage.set(stage, []);
    }

    for (const r of rows) {
      const stage = r.statusname as StaffOverdueStage;
      const entry = stageMap.get(stage);
      if (!entry) continue; // defensive — status outside the 3 review stages

      const ageDays = Math.max(
        1,
        Math.ceil(
          (now - new Date(r.createat).getTime()) / (1000 * 60 * 60 * 24),
        ),
      );
      const bucketKey = this.bucketForAge(ageDays);
      entry.buckets[bucketKey] += 1;
      entry.total += 1;
      if (bucketKey === 'd15p') entry.overdue += 1;

      itemsByStage.get(stage)!.push(this.buildItem(r, stage, ageDays, fallbackKind));
    }

    // Sort each stage's items by ageDays DESC, take top-N, derive oldest.
    for (const stage of StaffHomeService.STAGES) {
      const entry = stageMap.get(stage)!;
      const sorted = itemsByStage
        .get(stage)!
        .sort((a, b) => b.ageDays - a.ageDays);
      entry.topItems = sorted.slice(0, StaffHomeService.TOP_N_PER_STAGE);
      entry.oldest = entry.topItems[0] ?? null;
    }

    return {
      lane,
      labelTh: StaffHomeService.LANE_LABEL_TH[lane],
      stages: StaffHomeService.STAGES.map((s) => stageMap.get(s)!),
    };
  }

  private bucketForAge(ageDays: number): StaffOverdueBucketKey {
    if (ageDays <= 3) return 'd0_3';
    if (ageDays <= 7) return 'd4_7';
    if (ageDays <= 14) return 'd8_14';
    return 'd15p';
  }

  /**
   * Merge two lane entries (same lane) stage-by-stage (RPG + RELPG). Each
   * item keeps its OWN `bookKind` / `actionRoute` / routes — the merge only
   * re-sorts + re-tops the combined item list, it does NOT re-tag kinds
   * (DOCS-01 §7.4 / §11 risk note).
   */
  private mergeLanes(
    a: StaffOverdueLaneEntry,
    b: StaffOverdueLaneEntry,
  ): StaffOverdueLaneEntry {
    const stages = StaffHomeService.STAGES.map((stage) => {
      const sa = a.stages.find((s) => s.stage === stage)!;
      const sb = b.stages.find((s) => s.stage === stage)!;
      const buckets: Record<StaffOverdueBucketKey, number> = {
        d0_3: sa.buckets.d0_3 + sb.buckets.d0_3,
        d4_7: sa.buckets.d4_7 + sb.buckets.d4_7,
        d8_14: sa.buckets.d8_14 + sb.buckets.d8_14,
        d15p: sa.buckets.d15p + sb.buckets.d15p,
      };
      const topItems = [...sa.topItems, ...sb.topItems]
        .sort((x, y) => y.ageDays - x.ageDays)
        .slice(0, StaffHomeService.TOP_N_PER_STAGE);
      return {
        stage,
        stageLabelTh: StaffHomeService.STAGE_LABEL_TH[stage],
        buckets,
        total: sa.total + sb.total,
        overdue: sa.overdue + sb.overdue,
        oldest: topItems[0] ?? null,
        topItems,
      };
    });
    return { lane: a.lane, labelTh: a.labelTh, stages };
  }

  private emptyStage(stage: StaffOverdueStage): StaffOverdueStageEntry {
    return {
      stage,
      stageLabelTh: StaffHomeService.STAGE_LABEL_TH[stage],
      buckets: { d0_3: 0, d4_7: 0, d8_14: 0, d15p: 0 },
      total: 0,
      overdue: 0,
      oldest: null,
      topItems: [],
    };
  }

  private emptyLane(lane: StaffOverdueLane): StaffOverdueLaneEntry {
    return {
      lane,
      labelTh: StaffHomeService.LANE_LABEL_TH[lane],
      stages: StaffHomeService.STAGES.map((s) => this.emptyStage(s)),
    };
  }

  private emptyResponse(): StaffOverdueResponseDto {
    const lanes: StaffOverdueLane[] = [
      'mainPlan',
      'revisionEdit',
      'revisionChange',
      'supplement',
      'equipment',
    ];
    return {
      asOf: new Date().toISOString(),
      overdueThresholdDays: StaffHomeService.OVERDUE_THRESHOLD_DAYS,
      buckets: StaffHomeService.BUCKETS,
      totalOverdue: 0,
      totalAging: 0,
      lanes: lanes.map((l) => this.emptyLane(l)),
    };
  }
}

/** Shape of a raw aggregator row (post-enrichment SELECT aliases). */
interface StaffOverdueRawRow {
  projectid: string;
  title: string | null;
  statusname: string;
  statusth: string | null;
  createat: Date;
  isbooked: boolean | null;
  pagenumber: number | null;
  planname: string | null;
  revisionnumber: number | null;
  revisiontypename: string | null;
  supplementnumber: number | null;
}
