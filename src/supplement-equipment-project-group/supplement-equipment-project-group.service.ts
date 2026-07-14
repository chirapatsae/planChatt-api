import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, DeepPartial, EntityManager, Repository } from 'typeorm';

import { SupplementEquipmentProjectGroup } from './entities/supplement-equipment-project-group.entity';
import { CreateSupplementEquipmentProjectGroupDto } from './dto/create-supplement-equipment-project-group.dto';
import { UpdateSupplementEquipmentProjectGroupDto } from './dto/update-supplement-equipment-project-group.dto';
import { ListSupplementEquipmentProjectGroupsQueryDto } from './dto/list-supplement-equipment-project-groups-query.dto';
import { SupplementEquipmentCountsByStatusDto } from './dto/supplement-equipment-counts-by-status.dto';

import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { WorkHistoryLookupService } from 'src/work-history/work-history-lookup.service';
import { ProjectClassificationValidator } from 'src/common/project-classification/project-classification.validator';
import { BookFormatResolver } from 'src/common/project-classification/book-format.resolver';
import { BookLockService } from 'src/common/book-lock/book-lock.service';
import { ReportFormat } from 'src/development-plan/types/report-format.enum';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { EquipmentCategory } from 'src/equipment-category/entities/equipment-category.entity';
import { EquipmentCategoryScope } from 'src/equipment-category/entities/equipment-category-scope.entity';
import { Status } from 'src/status/entities/status.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { Budget } from 'src/budget/entities/budget.entity';
import {
  getAgencyData,
  isAgencyWorkHistory,
} from 'src/project-groups/util/agency-data.util';
import {
  ERROR_CODES,
  ERROR_MESSAGES,
} from 'src/common/project-classification/constants';
import { PreSubmitSnapshotService } from 'src/ai/pre-submit-snapshot.service';
import { UsersService } from 'src/users/users.service';
import { maskEmail } from 'src/notifications/email/utils/mask-email.util';

/**
 * Wave wave-supplement-equipment-por03 — BE-B1 (2026-06-08).
 *
 * Supplement-equipment (ครุภัณฑ์ ผ.03 under เล่มเพิ่มเติม) CRUD. Mirrors
 * `EquipmentProjectGroupService` for create / update / delete / list,
 * with the book parent swapped from `DevelopmentPlan` →
 * `DevelopmentPlanSupplement` (§10 scope binding). Reuses:
 *   - `WorkHistoryLookupService` for §1 / §2 lookups
 *   - `ProjectClassificationValidator` for §16.5 dual-shape validation
 *   - `BookFormatResolver.resolveBySupplement` to resolve parent plan
 *     `reportFormat` via supplement → plan JOIN (§16.3)
 *   - `getAgencyData` for §5.1 / §7.1 responsibleAgency auto-assign
 *   - `isAgencyWorkHistory` for §1/§5.3 agency-only gate (Layer-2 defense)
 *   - `BookLockService.assertEditable(supplementId, 'development_plan_supplement')`
 *     for §15.4 book lock
 *   - `PreSubmitSnapshotService` for the §17.4 `no-ai-baseline` snapshot
 *
 * # Locked constraints (OQ-B1..B5, 2026-06-08)
 *
 * - **Agency-only writes (Q-AGENCY, §5.3).** Every write method calls
 *   `assertAgencyWorkHistory` as a Layer-2 defense after workStatus
 *   (Layer-1 is the controller `AgencyOnlyGuard`), throwing
 *   `403 EQUIPMENT_AGENCY_ONLY` if the caller is `lao`. Read methods do
 *   NOT enforce this gate.
 * - **Dual format (OQ-B5).** STRATEGY_BASED and ISSUE_BASED parent plans
 *   both supported. STRATEGY_BASED additionally validates the
 *   `(tactic, plan, equipmentCategory)` triple against
 *   `equipment_category_scopes`. ISSUE_BASED validates only that the
 *   `developmentIssue` belongs to the parent plan (Option (i)).
 * - **No lineage (OQ-B3).** §14 vacuous — no `prev_project_id` columns,
 *   no lineage guard. Revision/Change of supplement equipment deferred.
 */
@Injectable()
export class SupplementEquipmentProjectGroupService {
  private readonly logger = new Logger(
    SupplementEquipmentProjectGroupService.name,
  );

  // Canonical `Ready` Status id — mirror the literal id used by
  // `EquipmentProjectGroupService` so audit rows stay in lockstep with
  // PG / EPG. `Pending` is resolved by name to avoid baking another
  // literal that could drift.
  private static readonly READY_STATUS_ID =
    '8219cd82-fa61-4292-bd0d-fa58b08507e1';

  constructor(
    @InjectRepository(SupplementEquipmentProjectGroup)
    private readonly sepgRepo: Repository<SupplementEquipmentProjectGroup>,
    private readonly dataSource: DataSource,
    private readonly workHistoryLookup: WorkHistoryLookupService,
    private readonly classificationValidator: ProjectClassificationValidator,
    private readonly bookFormatResolver: BookFormatResolver,
    private readonly bookLockService: BookLockService,
    private readonly preSubmitSnapshotService: PreSubmitSnapshotService,
    private readonly usersService: UsersService,
  ) {}

  /**
   * W100 parity — decrypt-then-mask the `createdBy.user` PII on every row
   * so the staff table shows `c***@gmail.com` (not raw ciphertext) and
   * never leaks phone / citizenId. Mirrors
   * `EquipmentProjectGroupService.maskCreatedByUserOnEquipment`.
   * Idempotent + dedup by User identity.
   */
  private async maskCreatedByUserOnSepg(
    items: SupplementEquipmentProjectGroup[],
  ): Promise<void> {
    const seen = new WeakSet<object>();
    const maskUser = async (
      user:
        | { email?: string; phone?: string; citizenId?: string }
        | undefined,
    ): Promise<void> => {
      if (!user || seen.has(user)) return;
      seen.add(user);
      await this.usersService.decryptUserPii(user as any);
      user.email = user.email ? maskEmail(user.email) : (null as any);
      user.phone = null as any;
      user.citizenId = null as any;
    };

    for (const e of items) {
      await maskUser(
        e?.createdBy?.user as
          | { email?: string; phone?: string; citizenId?: string }
          | undefined,
      );
      const tracking = e?.trackingStatus;
      if (Array.isArray(tracking)) {
        for (const ts of tracking) {
          await maskUser(
            (ts as any)?.createdBy?.user as
              | { email?: string; phone?: string; citizenId?: string }
              | undefined,
          );
        }
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────
  //  CREATE
  // ──────────────────────────────────────────────────────────────────

  async create(
    dto: CreateSupplementEquipmentProjectGroupDto,
    userId: string,
  ) {
    return this.dataSource.transaction(async (manager) => {
      // 1-3. Auth → WorkHistory → workStatus=approved
      const workHistory = await this.workHistoryLookup.getCurrent(
        manager,
        userId,
      );
      this.workHistoryLookup.assertWorkStatusApproved(workHistory);

      // 4. §1/§5.3 agency-only gate (Layer-2 defense; controller has Layer-1).
      this.assertAgencyWorkHistory(workHistory);

      // 5. §16.3 — resolve parent plan reportFormat via supplement → plan
      //    JOIN (supplement does NOT own reportFormat). §16.5 shape.
      const format = await this.bookFormatResolver.resolveBySupplement(
        dto.developmentPlanSupplementId,
        manager,
      );
      this.classificationValidator.validate(format, {
        strategyId: dto.strategyId,
        tacticId: dto.tacticId,
        planId: dto.planId,
        developmentIssueId: dto.developmentIssueId,
        // Equipment relaxes the STRATEGY_BASED indicator-required floor
        // (§16.5 indicator-relaxation). Force a non-empty sentinel for
        // the validator; the persisted row keeps `indicator = null`.
        indicator: format === ReportFormat.STRATEGY_BASED ? '_' : null,
      });

      // 6. §10 — validate against the SEPG's own DevelopmentPlanSupplement
      //    (isOpen / isLatest / isBooked + parent plan latest), NEVER a
      //    global supplement. §15.4 book lock before the write.
      const { supplement, developmentPlan } =
        await this.validateSupplementScope(
          manager,
          dto.developmentPlanSupplementId,
        );
      await this.bookLockService.assertEditable(
        supplement.id,
        'development_plan_supplement',
        manager,
      );

      const equipmentCategory = await this.loadEquipmentCategory(
        manager,
        dto.equipmentCategoryId,
      );

      let strategy: Strategy | null = null;
      let tactic: Tactic | null = null;
      let plan: Plan | null = null;
      let developmentIssue: DevelopmentIssue | null = null;

      if (format === ReportFormat.STRATEGY_BASED) {
        [strategy, tactic, plan] = await this.loadStrategyTriple(manager, {
          strategyId: dto.strategyId!,
          tacticId: dto.tacticId!,
          planId: dto.planId!,
        });
        await this.assertScopeTripleValid(
          manager,
          dto.tacticId!,
          dto.planId!,
          dto.equipmentCategoryId,
        );
      } else {
        developmentIssue = await this.loadIssueForPlan(
          manager,
          dto.developmentIssueId!,
          developmentPlan.id,
        );
      }

      // 7. §5.1 / §7.1 — responsibleAgency auto-assigned from creator
      //    WorkHistory (agency-origin only; never user-supplied).
      const agencyData = getAgencyData(workHistory);

      const classificationColumns =
        format === ReportFormat.ISSUE_BASED
          ? {
              strategy: null,
              tactic: null,
              plan: null,
              indicator: null,
              developmentIssue,
            }
          : {
              strategy,
              tactic,
              plan,
              // §16.5 indicator-relaxation — never persists a KPI.
              indicator: null,
              developmentIssue: null,
            };

      const entity = manager.create(SupplementEquipmentProjectGroup, {
        equipmentName: dto.equipmentName,
        targetOutput: dto.targetOutput,
        expectedResults: dto.expectedResults,
        ...classificationColumns,
        equipmentCategory,
        developmentPlanSupplement: supplement,
        createdBy: workHistory,
        amphoe: { id: workHistory.amphoe.id } as any,
        localAdministrativeOrganization: {
          id: workHistory.localAdministrativeOrganization.id,
        } as any,
        // Agency callers never set `originAgencyId` (LAO-origin marker);
        // SEPG is agency-only by construction (§5.3).
        originAgencyId: null as any,
        ...(agencyData as DeepPartial<SupplementEquipmentProjectGroup>),
      } as DeepPartial<SupplementEquipmentProjectGroup>);

      const saved = await manager.save(entity);

      // 8. §12 audit — write initial TrackingStatus row.
      const statusId = await this.resolveInitialStatusId(
        manager,
        dto.isDraft ?? false,
      );
      const tracking = manager.create(TrackingStatus, {
        supplementEquipmentProjectGroupId: saved,
        statusId: { id: statusId } as Status,
        createdBy: workHistory,
        isLatest: true,
      } as DeepPartial<TrackingStatus>);
      await manager.save(tracking);

      // 9. Budgets — same polymorphic pattern as EPG.
      if (Array.isArray(dto.budget) && dto.budget.length > 0) {
        await this.assertBudgetYears(dto.budget, developmentPlan);
        const budgets = dto.budget.map((b) =>
          manager.create(Budget, {
            supplementEquipmentProjectGroupId: {
              id: saved.id,
            } as SupplementEquipmentProjectGroup,
            year: b.year,
            quantity: b.quantity,
          } as DeepPartial<Budget>),
        );
        await manager.save(budgets);
      }

      // 10. §17.4 `no-ai-baseline` snapshot — publish path only.
      //
      // Mirrors `EquipmentProjectGroupService.create`. Fires ONLY on the
      // publish path (`isDraft=false` → `Pending`). Draft saves
      // (`isDraft=true` → `Ready`) MUST NOT fire per §17.4 Wave 11
      // authoring-vs-workflow distinction. Equipment is created through
      // the wizard, which IS an authoring surface.
      //
      // §17.3 audit separation — snapshot references the SEPG by
      // `(target_kind='supplement-equipment-project-group', target_id)`
      // WITHOUT an FK. No project-table mutation in this call. The outer
      // manager is forwarded so the owner lookup sees the row we just
      // inserted (READ COMMITTED would otherwise hide it).
      if (!(dto.isDraft ?? false)) {
        await this.preSubmitSnapshotService.createSnapshot(
          userId,
          {
            targetKind: 'supplement-equipment-project-group',
            targetId: saved.id,
            workflow: 'add',
            result: null,
            project: {
              title: saved.equipmentName ?? null,
              goal: saved.targetOutput ?? null,
              expected: saved.expectedResults ?? null,
              indicator: null,
              startLat: null,
              startLng: null,
              endLat: null,
              endLng: null,
              amphoeId: workHistory.amphoe?.id ?? null,
              localOrganizationId:
                workHistory.localAdministrativeOrganization?.id ?? null,
              budgets: Array.isArray(dto.budget)
                ? dto.budget.map((b) => ({
                    year: b.year,
                    quantity: b.quantity ?? 0,
                  }))
                : [],
              equipmentCategoryId: equipmentCategory.id,
            },
            classification: {
              reportFormat:
                format === ReportFormat.ISSUE_BASED
                  ? 'ISSUE_BASED'
                  : 'STRATEGY_BASED',
              strategyName: strategy?.name ?? null,
              tacticName: tactic?.name ?? null,
              planName: plan?.name ?? null,
              developmentIssueName: developmentIssue?.name ?? null,
            },
            attachments: [],
          },
          manager,
        );
      }

      this.logger.log(
        `Created supplement-equipment id=${saved.id} format=${format} category=${equipmentCategory.code} createdBy=${workHistory.id} draft=${dto.isDraft ?? false}`,
      );
      return this.findOneInternal(manager, saved.id);
    });
  }

  // ──────────────────────────────────────────────────────────────────
  //  UPDATE
  // ──────────────────────────────────────────────────────────────────

  async update(
    id: string,
    dto: UpdateSupplementEquipmentProjectGroupDto,
    userId: string,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const workHistory = await this.workHistoryLookup.getCurrent(
        manager,
        userId,
      );
      this.workHistoryLookup.assertWorkStatusApproved(workHistory);
      this.assertAgencyWorkHistory(workHistory);

      const existing = await manager.findOne(SupplementEquipmentProjectGroup, {
        where: { id },
        relations: [
          'createdBy',
          'developmentPlanSupplement',
          'strategy',
          'tactic',
          'plan',
          'developmentIssue',
          'equipmentCategory',
        ],
      });
      if (!existing) {
        throw new NotFoundException(
          `Supplement equipment item not found: ${id}`,
        );
      }
      this.assertOwnership(existing, workHistory);

      // Re-pointing the parent supplement on update is forbidden — that's
      // a structural change indistinguishable from delete + recreate.
      if (
        dto.developmentPlanSupplementId !== undefined &&
        dto.developmentPlanSupplementId !==
          existing.developmentPlanSupplement?.id
      ) {
        throw new BadRequestException(
          'EQUIPMENT_SUPPLEMENT_IMMUTABLE: ไม่อนุญาตให้เปลี่ยนเล่มเพิ่มเติมของรายการครุภัณฑ์',
        );
      }
      const supplementId = existing.developmentPlanSupplement!.id;

      // §10 + §15.4 — re-validate the supplement window is still open and
      // the book is not §15-locked, BEFORE any mutation.
      const { developmentPlan } = await this.validateSupplementScope(
        manager,
        supplementId,
      );
      await this.bookLockService.assertEditable(
        supplementId,
        'development_plan_supplement',
        manager,
      );

      const format = await this.bookFormatResolver.resolveBySupplement(
        supplementId,
        manager,
      );

      // Build the effective post-update classification so the validator
      // sees the FINAL state, not just the patch delta.
      const effective = this.mergeClassificationForUpdate(existing, dto);

      this.classificationValidator.validate(format, {
        strategyId: effective.strategyId,
        tacticId: effective.tacticId,
        planId: effective.planId,
        developmentIssueId: effective.developmentIssueId,
        indicator: format === ReportFormat.STRATEGY_BASED ? '_' : null,
      });

      const equipmentCategoryId =
        dto.equipmentCategoryId ?? existing.equipmentCategory?.id;
      if (!equipmentCategoryId) {
        throw new BadRequestException('Missing equipmentCategoryId');
      }
      const equipmentCategory = await this.loadEquipmentCategory(
        manager,
        equipmentCategoryId,
      );

      let strategy: Strategy | null = null;
      let tactic: Tactic | null = null;
      let plan: Plan | null = null;
      let developmentIssue: DevelopmentIssue | null = null;

      if (format === ReportFormat.STRATEGY_BASED) {
        [strategy, tactic, plan] = await this.loadStrategyTriple(manager, {
          strategyId: effective.strategyId!,
          tacticId: effective.tacticId!,
          planId: effective.planId!,
        });
        await this.assertScopeTripleValid(
          manager,
          effective.tacticId!,
          effective.planId!,
          equipmentCategoryId,
        );
      } else {
        developmentIssue = await this.loadIssueForPlan(
          manager,
          effective.developmentIssueId!,
          developmentPlan.id,
        );
      }

      const classificationColumns =
        format === ReportFormat.ISSUE_BASED
          ? {
              strategy: null,
              tactic: null,
              plan: null,
              indicator: null,
              developmentIssue,
            }
          : {
              strategy,
              tactic,
              plan,
              indicator: null,
              developmentIssue: null,
            };

      const patch: DeepPartial<SupplementEquipmentProjectGroup> = {
        ...(dto.equipmentName !== undefined && {
          equipmentName: dto.equipmentName,
        }),
        ...(dto.targetOutput !== undefined && {
          targetOutput: dto.targetOutput,
        }),
        ...(dto.expectedResults !== undefined && {
          expectedResults: dto.expectedResults,
        }),
        ...classificationColumns,
        equipmentCategory,
      };

      await manager.update(
        SupplementEquipmentProjectGroup,
        { id },
        patch as any,
      );

      // Budgets — replace-all when supplied.
      if (dto.budget !== undefined) {
        await manager.delete(Budget, {
          supplementEquipmentProjectGroupId: { id } as any,
        });
        if (dto.budget.length > 0) {
          await this.assertBudgetYears(dto.budget, developmentPlan);
          const budgets = dto.budget.map((b) =>
            manager.create(Budget, {
              supplementEquipmentProjectGroupId: {
                id,
              } as SupplementEquipmentProjectGroup,
              year: b.year,
              quantity: b.quantity,
            } as DeepPartial<Budget>),
          );
          await manager.save(budgets);
        }
      }

      this.logger.log(
        `Updated supplement-equipment id=${id} format=${format} category=${equipmentCategory.code} updatedBy=${workHistory.id}`,
      );
      return this.findOneInternal(manager, id);
    });
  }

  // ──────────────────────────────────────────────────────────────────
  //  DELETE (soft)
  // ──────────────────────────────────────────────────────────────────

  async softRemove(id: string, userId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const workHistory = await this.workHistoryLookup.getCurrent(
        manager,
        userId,
      );
      this.workHistoryLookup.assertWorkStatusApproved(workHistory);
      this.assertAgencyWorkHistory(workHistory);

      const existing = await manager.findOne(SupplementEquipmentProjectGroup, {
        where: { id },
        relations: ['createdBy', 'developmentPlanSupplement'],
      });
      if (!existing) {
        throw new NotFoundException(
          `Supplement equipment item not found: ${id}`,
        );
      }
      this.assertOwnership(existing, workHistory);

      // §15.4 — reject soft-delete when the parent supplement book is
      // §15-locked (a newer-booked sibling exists). Runs BEFORE the write.
      const supplementId = existing.developmentPlanSupplement?.id;
      if (supplementId) {
        await this.bookLockService.assertDeletable(
          supplementId,
          'development_plan_supplement',
          manager,
        );
      }

      // §14 lineage descendant guard is VACUOUS in v1 (OQ-B3 — SEPG has
      // no `prev_project_id` columns). No `LineageLockService` call.

      await manager.softRemove(SupplementEquipmentProjectGroup, existing);
      this.logger.log(
        `Soft-removed supplement-equipment id=${id} by=${workHistory.id}`,
      );
    });
  }

  // ──────────────────────────────────────────────────────────────────
  //  READ (LAO users allowed — UNgated by agency-only, §5.3)
  // ──────────────────────────────────────────────────────────────────

  async findOne(id: string) {
    return this.findOneInternal(this.sepgRepo.manager, id);
  }

  /**
   * Wave wave-supplement-equipment-por03 — counts-by-status (2026-06-09).
   *
   * Owner-scoped per-status count envelope. Mirrors
   * `EquipmentProjectGroupService.getCountsByStatus` byte-for-spirit —
   * only the entity / repo (`SupplementEquipmentProjectGroup`) differs.
   *
   * Response (FROZEN):
   *   `{ ready, pending, verified, returnedForRevision, pullBack }`
   *
   * Authority:
   *   - agency-classified callers — live counts (§4 owner-scope)
   *   - LAO / non-agency callers — all-zero envelope at HTTP 200
   *     (NOT 403). Read counts return zeros so the sidebar fetch never
   *     errors for LAO users. Matches the EPG / SPG precedent.
   *   - §17.11 no role bypass — super-admin LAO also gets zeros.
   *
   * §17.2 advisory-only — counts MUST NOT gate any workflow.
   * §17.3 audit separation — READ-ONLY; no `TrackingStatus` writes.
   *
   * Statuses outside the 5 envelope keys (`Pending_Approval`,
   * `Approved`, `Rejected`) are SILENTLY DROPPED — no consuming surface.
   */
  async getCountsByStatus(
    userId: string,
  ): Promise<SupplementEquipmentCountsByStatusDto> {
    // 1-3. Resolve WorkHistory + §2 workStatus gate. Read-only, so use
    //       the default manager (no enclosing transaction).
    const workHistory = await this.workHistoryLookup.getCurrent(
      this.sepgRepo.manager,
      userId,
    );
    this.workHistoryLookup.assertWorkStatusApproved(workHistory);

    // 4. §1 / §5.3 classification gate — LAO callers (and any non-agency
    //    work history) get the zero envelope IMMEDIATELY. No DB hit.
    //    Read counts return zeros (not 403) so the sidebar fetch never
    //    errors — mirrors `EquipmentProjectGroupService.getCountsByStatus`.
    if (!isAgencyWorkHistory(workHistory)) {
      return {
        ready: 0,
        pending: 0,
        verified: 0,
        returnedForRevision: 0,
        pullBack: 0,
      };
    }

    // 5. ONE round-trip — Postgres FILTER aggregation. JOIN topology
    //    mirrors EPG `getCountsByStatus`:
    //      - INNER JOIN `sepg.trackingStatus` ON `is_latest = true`
    //        (FK `supplement_equipment_project_group_id` — §12 6th FK)
    //      - INNER JOIN `latestTracking.statusId` ON status PK
    //      - WHERE `createdBy.id = :workHistoryId`
    //      - WHERE `sepg.deleted_at IS NULL`
    const row = await this.sepgRepo
      .createQueryBuilder('sepg')
      .innerJoin('sepg.createdBy', 'createdBy')
      .innerJoin(
        'sepg.trackingStatus',
        'latestTracking',
        'latestTracking.isLatest = :isLatest',
        { isLatest: true },
      )
      .innerJoin('latestTracking.statusId', 'latestStatus')
      .where('createdBy.id = :workHistoryId', {
        workHistoryId: workHistory.id,
      })
      .andWhere('sepg.deleted_at IS NULL')
      .select(
        `COUNT(*) FILTER (WHERE "latestStatus"."name" = 'Ready')`,
        'ready_count',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE "latestStatus"."name" = 'Pending')`,
        'pending_count',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE "latestStatus"."name" = 'Verified')`,
        'verified_count',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE "latestStatus"."name" = 'Returned_For_Revision')`,
        'returned_for_revision_count',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE "latestStatus"."name" = 'Pull_Back')`,
        'pull_back_count',
      )
      .getRawOne<{
        ready_count: string | number | null;
        pending_count: string | number | null;
        verified_count: string | number | null;
        returned_for_revision_count: string | number | null;
        pull_back_count: string | number | null;
      }>();

    // `pg` driver returns COUNT as string; coerce defensively.
    const toInt = (v: string | number | null | undefined): number => {
      if (v === null || v === undefined) return 0;
      const n = typeof v === 'number' ? v : parseInt(v, 10);
      return Number.isFinite(n) ? n : 0;
    };

    return {
      ready: toInt(row?.ready_count),
      pending: toInt(row?.pending_count),
      verified: toInt(row?.verified_count),
      returnedForRevision: toInt(row?.returned_for_revision_count),
      pullBack: toInt(row?.pull_back_count),
    };
  }

  async findAll(
    query: ListSupplementEquipmentProjectGroupsQueryDto,
    userId: string,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.sepgRepo
      .createQueryBuilder('sepg')
      .leftJoinAndSelect('sepg.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'createdByAmphoe')
      .leftJoinAndSelect(
        'createdBy.localAdministrativeOrganization',
        'createdByLao',
      )
      .leftJoinAndSelect('sepg.developmentPlanSupplement', 'supplement')
      .leftJoinAndSelect('supplement.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('sepg.strategy', 'strategy')
      .leftJoinAndSelect('sepg.tactic', 'tactic')
      .leftJoinAndSelect('sepg.plan', 'plan')
      .leftJoinAndSelect('sepg.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('sepg.equipmentCategory', 'equipmentCategory')
      .leftJoinAndSelect('sepg.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('sepg.amphoe', 'amphoe')
      .leftJoinAndSelect('sepg.localAdministrativeOrganization', 'lao')
      .leftJoinAndSelect('sepg.budgets', 'budgets')
      .leftJoinAndSelect('sepg.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .where('sepg.deletedAt IS NULL');

    if (query.developmentPlanSupplementId) {
      qb.andWhere('supplement.id = :supplementId', {
        supplementId: query.developmentPlanSupplementId,
      });
    }

    if (query.status) {
      qb.andWhere(
        'EXISTS (SELECT 1 FROM tracking_status ts ' +
          ' INNER JOIN status s ON s.id = ts.status_id ' +
          ' WHERE ts.supplement_equipment_project_group_id = sepg.id ' +
          '   AND ts.is_latest = true ' +
          '   AND s.name = :statusName)',
        { statusName: query.status },
      );
    }

    if (query.mineOnly) {
      const workHistory = await this.workHistoryLookup.getCurrent(
        this.sepgRepo.manager,
        userId,
      );
      this.workHistoryLookup.assertWorkStatusApproved(workHistory);
      qb.andWhere('createdBy.id = :ownerId', { ownerId: workHistory.id });
    }

    qb.orderBy('sepg.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();
    await this.maskCreatedByUserOnSepg(items);

    return {
      items,
      total,
      page,
      limit,
    };
  }

  // ──────────────────────────────────────────────────────────────────
  //  Private helpers
  // ──────────────────────────────────────────────────────────────────

  /**
   * §1/§5.3 agency-only gate — Layer 2 (defense-in-depth). Layer 1 is the
   * controller `AgencyOnlyGuard`. Mirrors
   * `EquipmentProjectGroupService.assertAgencyWorkHistory`.
   */
  private assertAgencyWorkHistory(workHistory: WorkHistory): void {
    if (!isAgencyWorkHistory(workHistory)) {
      throw new ForbiddenException({
        code: 'EQUIPMENT_AGENCY_ONLY',
        message: 'ฟีเจอร์ครุภัณฑ์ (ผ.03) ใช้ได้เฉพาะผู้ใช้ของเทศบาลตำบลหนองกระทุ่ม',
      });
    }
  }

  /**
   * §4 — Ownership check. Compares `sepg.createdBy.id` against
   * `workHistory.id`, NEVER `userId`.
   */
  private assertOwnership(
    sepg: SupplementEquipmentProjectGroup,
    workHistory: WorkHistory,
  ): void {
    if (sepg.createdBy?.id !== workHistory.id) {
      throw new ForbiddenException(
        'คุณไม่มีสิทธิ์ดำเนินการกับรายการครุภัณฑ์นี้',
      );
    }
  }

  /**
   * §10 — validate against the SEPG's own DevelopmentPlanSupplement
   * (isLatest / isOpen / isBooked + parent plan latest). Mirrors
   * `SupplementProjectGroupService.validateForeignKeysAndScope`'s scope
   * gates. The parent `DevelopmentPlan.isBooked` is the EXPECTED state
   * for the supplement workflow (supplements ride a finalized plan), so
   * it is NOT a gate here.
   */
  private async validateSupplementScope(
    manager: EntityManager,
    supplementId: string,
  ): Promise<{
    supplement: DevelopmentPlanSupplement;
    developmentPlan: DevelopmentPlan;
  }> {
    const supplement = await manager.findOne(DevelopmentPlanSupplement, {
      where: { id: supplementId },
      relations: ['developmentPlan'],
    });
    if (!supplement) {
      throw new NotFoundException(
        `DevelopmentPlanSupplement with ID ${supplementId} not found`,
      );
    }
    if (!supplement.isLatest) {
      throw new BadRequestException(
        'เล่มเพิ่มเติมที่ระบุไม่ใช่เล่มล่าสุดของรอบนี้',
      );
    }
    if (!supplement.isOpen) {
      throw new BadRequestException(
        'เล่มเพิ่มเติมที่ระบุยังไม่เปิดให้บันทึก หรือปิดรอบแล้ว',
      );
    }
    if (supplement.isBooked) {
      throw new BadRequestException(
        'เล่มเพิ่มเติมที่ระบุถูกรวมเล่มแล้ว ไม่สามารถดำเนินการได้',
      );
    }

    const developmentPlan = supplement.developmentPlan;
    if (!developmentPlan) {
      throw new BadRequestException(
        'เล่มเพิ่มเติมที่ระบุไม่มีแผนพัฒนาฯ ต้นทาง',
      );
    }
    if (!developmentPlan.isLatest) {
      throw new BadRequestException('แผนพัฒนาฯ ต้นทางไม่ใช่แผนปัจจุบัน');
    }

    return { supplement, developmentPlan };
  }

  private async loadEquipmentCategory(
    manager: EntityManager,
    id: string,
  ): Promise<EquipmentCategory> {
    const cat = await manager.findOne(EquipmentCategory, { where: { id } });
    if (!cat) {
      throw new NotFoundException(`EQUIPMENT_CATEGORY_NOT_FOUND: ${id}`);
    }
    return cat;
  }

  private async loadStrategyTriple(
    manager: EntityManager,
    ids: { strategyId: string; tacticId: string; planId: string },
  ): Promise<[Strategy, Tactic, Plan]> {
    const [strategy, tactic, plan] = await Promise.all([
      manager.findOne(Strategy, { where: { id: ids.strategyId } }),
      manager.findOne(Tactic, { where: { id: ids.tacticId } }),
      manager.findOne(Plan, { where: { id: ids.planId } }),
    ]);
    if (!strategy)
      throw new NotFoundException(`Strategy ID not found: ${ids.strategyId}`);
    if (!tactic)
      throw new NotFoundException(`Tactic ID not found: ${ids.tacticId}`);
    if (!plan) throw new NotFoundException(`Plan ID not found: ${ids.planId}`);
    return [strategy, tactic, plan];
  }

  /**
   * Phase 1 scope-junction lookup. Asserts the
   * `(tactic, plan, equipmentCategory)` triple exists in
   * `equipment_category_scopes`. Triggers BadRequest
   * `EQUIPMENT_CATEGORY_SCOPE_INVALID` on miss (STRATEGY_BASED only).
   */
  private async assertScopeTripleValid(
    manager: EntityManager,
    tacticId: string,
    planId: string,
    equipmentCategoryId: string,
  ): Promise<void> {
    const row = await manager.findOne(EquipmentCategoryScope, {
      where: { tacticId, planId, equipmentCategoryId },
    });
    if (!row) {
      throw new BadRequestException(
        `EQUIPMENT_CATEGORY_SCOPE_INVALID: tactic=${tacticId}, plan=${planId}, category=${equipmentCategoryId}`,
      );
    }
  }

  /**
   * ISSUE_BASED — load issue and assert it belongs to the same plan.
   */
  private async loadIssueForPlan(
    manager: EntityManager,
    issueId: string,
    planId: string,
  ): Promise<DevelopmentIssue> {
    const issue = await manager.findOne(DevelopmentIssue, {
      where: { id: issueId },
      relations: ['developmentPlan'],
    });
    if (!issue) {
      throw new NotFoundException(
        `${ERROR_CODES.DEVELOPMENT_ISSUE_NOT_FOUND}: ${ERROR_MESSAGES.DEVELOPMENT_ISSUE_NOT_FOUND}`,
      );
    }
    if (issue.developmentPlan?.id !== planId) {
      throw new BadRequestException(
        `EQUIPMENT_ISSUE_NOT_IN_PLAN: ${ERROR_MESSAGES.DEVELOPMENT_ISSUE_PLAN_MISMATCH}`,
      );
    }
    return issue;
  }

  private mergeClassificationForUpdate(
    existing: SupplementEquipmentProjectGroup,
    dto: UpdateSupplementEquipmentProjectGroupDto,
  ): {
    strategyId?: string | null;
    tacticId?: string | null;
    planId?: string | null;
    developmentIssueId?: string | null;
  } {
    return {
      strategyId:
        dto.strategyId !== undefined ? dto.strategyId : existing.strategy?.id,
      tacticId:
        dto.tacticId !== undefined ? dto.tacticId : existing.tactic?.id,
      planId: dto.planId !== undefined ? dto.planId : existing.plan?.id,
      developmentIssueId:
        dto.developmentIssueId !== undefined
          ? dto.developmentIssueId
          : existing.developmentIssue?.id,
    };
  }

  private async resolveInitialStatusId(
    manager: EntityManager,
    isDraft: boolean,
  ): Promise<string> {
    if (isDraft) {
      return SupplementEquipmentProjectGroupService.READY_STATUS_ID;
    }
    const pending = await manager.findOne(Status, {
      where: { name: 'Pending' },
    });
    if (!pending) {
      throw new NotFoundException(
        'ไม่พบสถานะ "Pending" ในระบบ ข้อมูลสถานะอาจไม่สมบูรณ์',
      );
    }
    return pending.id;
  }

  private async assertBudgetYears(
    items: Array<{ year: number }>,
    plan: DevelopmentPlan,
  ): Promise<void> {
    for (const b of items) {
      if (b.year < plan.startYear || b.year > plan.endYear) {
        throw new BadRequestException(
          `ปีงบประมาณต้องอยู่ในช่วง พ.ศ. ${plan.startYear} - ${plan.endYear} (ปีที่ส่งมา: ${b.year})`,
        );
      }
    }
  }

  private async findOneInternal(
    manager: EntityManager,
    id: string,
  ): Promise<SupplementEquipmentProjectGroup> {
    const row = await manager.findOne(SupplementEquipmentProjectGroup, {
      where: { id },
      relations: [
        'createdBy',
        'developmentPlanSupplement',
        'developmentPlanSupplement.developmentPlan',
        'strategy',
        'tactic',
        'plan',
        'developmentIssue',
        'equipmentCategory',
        'responsibleAgency',
        'amphoe',
        'localAdministrativeOrganization',
        'budgets',
        'trackingStatus',
        'trackingStatus.statusId',
        'trackingStatus.comments',
        'trackingStatus.createdBy',
        'trackingStatus.createdBy.user',
      ],
    });
    if (!row) {
      throw new NotFoundException(`Supplement equipment item not found: ${id}`);
    }
    await this.maskCreatedByUserOnSepg([row]);
    return row;
  }
}
