import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, DeepPartial, EntityManager, Repository } from 'typeorm';

import { EquipmentProjectGroup } from './entities/equipment-project-group.entity';
import { CreateEquipmentProjectGroupDto } from './dto/create-equipment-project-group.dto';
import { UpdateEquipmentProjectGroupDto } from './dto/update-equipment-project-group.dto';
import { ListEquipmentProjectGroupsQueryDto } from './dto/list-equipment-project-groups-query.dto';
import { EquipmentCountsByStatusDto } from './dto/equipment-counts-by-status.dto';

import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { WorkHistoryLookupService } from 'src/work-history/work-history-lookup.service';
import { ProjectClassificationValidator } from 'src/common/project-classification/project-classification.validator';
import { BookFormatResolver } from 'src/common/project-classification/book-format.resolver';
// Wave Equipment Revision Management — QA DEF-1 fix. §14 Version Lineage
// Immutability is bidirectional: a frozen EPG ancestor (one with a live
// RELPG descendant via prev_project_type='equipment') MUST reject its own
// data-mutation / row-delete paths, not only the RELPG fork-side check.
import { LineageLockService } from 'src/common/lineage-lock/lineage-lock.service';
import { ReportFormat } from 'src/development-plan/types/report-format.enum';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { EquipmentCategory } from 'src/equipment-category/entities/equipment-category.entity';
import { EquipmentCategoryScope } from 'src/equipment-category/entities/equipment-category-scope.entity';
import { PlanPhase, PhaseType } from 'src/plan-phase/entities/plan-phase.entity';
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
// Wave Equipment ผ.03 Phase 2 — BE-06 (2026-05-28). §17.4 `no-ai-baseline`
// snapshot fires at the publish path (isDraft=false → Pending). Mirrors
// the SPG trigger in `TrackingStatusService.fireSpgBaselineSnapshot`.
import { PreSubmitSnapshotService } from 'src/ai/pre-submit-snapshot.service';
// 2026-05-30 — decrypt-then-mask createdBy.user PII on read surfaces,
// parity with `ProjectGroupsService.maskCreatedByUserOnProjects` (W100).
// Without this the staff equipment table renders the raw ciphertext
// email hash instead of `c***@gmail.com`.
import { UsersService } from 'src/users/users.service';
import { maskEmail } from 'src/notifications/email/utils/mask-email.util';

/**
 * Wave Equipment ผ.03, Phase 2 — BE-04 (2026-05-28).
 *
 * Equipment project (ครุภัณฑ์ ผ.03) CRUD + workflow integration.
 * Mirrors `ProjectGroupsService` for create / update / delete / list,
 * scoped to equipment items. Reuses:
 *   - `WorkHistoryLookupService` for §1 / §2 lookups
 *   - `ProjectClassificationValidator` for §16.5 dual-shape validation
 *   - `BookFormatResolver` to resolve parent plan `reportFormat`
 *   - `getAgencyData` for §5/§7 responsibleAgency auto-assign
 *   - `isAgencyWorkHistory` for §1 agency-only gate (Layer-2 defense)
 *
 * # Locked constraints (2026-05-28)
 *
 * - **Agency-only writes (Q-AGENCY).** Every write method calls
 *   `assertAgencyWorkHistory` as the FIRST step after workStatus,
 *   throwing `403 EQUIPMENT_AGENCY_ONLY` if the caller is `lao`.
 *   Read methods do NOT enforce this gate.
 * - **Dual format (Q5=B).** STRATEGY_BASED and ISSUE_BASED parent
 *   plans both supported. STRATEGY_BASED additionally validates the
 *   `(tactic, plan, equipmentCategory)` triple against
 *   `equipment_category_scopes`. ISSUE_BASED validates only that the
 *   `developmentIssue` belongs to the parent plan (Option (i)).
 * - **No lineage (R3=NO).** No §14 lineage edges. Revision/Change
 *   deferred to Phase 3.
 */
@Injectable()
export class EquipmentProjectGroupService {
  private readonly logger = new Logger(EquipmentProjectGroupService.name);

  // Canonical Status row ids — mirror the literal id used by
  // `ProjectGroupsService.create` for `Ready` so equipment audit rows
  // stay in lockstep with PG. `Pending` is resolved by name to avoid
  // baking another literal that could drift.
  private static readonly READY_STATUS_ID =
    '8219cd82-fa61-4292-bd0d-fa58b08507e1';

  constructor(
    @InjectRepository(EquipmentProjectGroup)
    private readonly equipmentRepo: Repository<EquipmentProjectGroup>,
    private readonly dataSource: DataSource,
    private readonly workHistoryLookup: WorkHistoryLookupService,
    private readonly classificationValidator: ProjectClassificationValidator,
    private readonly bookFormatResolver: BookFormatResolver,
    // Wave Equipment ผ.03 Phase 2 — BE-06 (2026-05-28).
    private readonly preSubmitSnapshotService: PreSubmitSnapshotService,
    // 2026-05-30 — PII decrypt-then-mask on read surfaces (W100 parity).
    private readonly usersService: UsersService,
    // QA DEF-1 fix — §14.3 / §14.9 EPG-mutate-path lineage lock.
    private readonly lineageLockService: LineageLockService,
  ) {}

  /**
   * 2026-05-30 — W100 parity for equipment read surfaces. Decrypt then
   * mask the `createdBy.user` PII on every equipment row so the staff
   * table shows `c***@gmail.com` (not the raw ciphertext) and never
   * leaks phone / citizenId. Mirrors
   * `ProjectGroupsService.maskCreatedByUserOnProjects`. Idempotent +
   * dedup by User identity.
   */
  private async maskCreatedByUserOnEquipment(
    items: EquipmentProjectGroup[],
  ): Promise<void> {
    const seen = new WeakSet<object>();
    // Decrypt-then-mask a single User PII object in place. Display name
    // (firstName / lastName) is intentionally left untouched so staff
    // reviewers / owners remain identifiable; only email / phone /
    // citizenId are masked. Dedup by User identity via `seen`.
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
      // Equipment owner (createdBy.user).
      await maskUser(
        e?.createdBy?.user as
          | { email?: string; phone?: string; citizenId?: string }
          | undefined,
      );
      // 2026-05-30 — Wave Equipment Comment Visibility (BE-01). The
      // detail read now eager-loads `trackingStatus[].createdBy.user`
      // so the owner edit page can render the staff review-comment
      // thread with its author. Those staff authors carry PII through
      // the same `user` shape, so mask them identically (parity with
      // the project path, which masks tracking/comment authors). Staff
      // display name stays visible — only contact PII is stripped.
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

  async create(dto: CreateEquipmentProjectGroupDto, userId: string) {
    return this.dataSource.transaction(async (manager) => {
      // 1-3. Auth → WorkHistory → workStatus=approved
      const workHistory = await this.workHistoryLookup.getCurrent(
        manager,
        userId,
      );
      this.workHistoryLookup.assertWorkStatusApproved(workHistory);

      // 4. §1 agency-only gate (Layer-2 defense; controller has Layer-1).
      this.assertAgencyWorkHistory(workHistory);

      // 5. Resolve parent plan + §16.5 shape validation.
      const format = await this.bookFormatResolver.resolveByPlan(
        dto.developmentPlanId,
        manager,
      );
      this.classificationValidator.validate(format, {
        strategyId: dto.strategyId,
        tacticId: dto.tacticId,
        planId: dto.planId,
        developmentIssueId: dto.developmentIssueId,
        // Equipment relaxes the STRATEGY_BASED indicator-required floor
        // (DB-02 §6). Force indicator to a non-empty sentinel for the
        // validator's purposes — the persisted row keeps `indicator =
        // null` regardless of format per the entity's nullable column.
        indicator: format === ReportFormat.STRATEGY_BASED ? '_' : null,
      });

      // 6. Foreign-key + scope validation per format.
      const developmentPlan = await this.loadActivePlan(
        manager,
        dto.developmentPlanId,
      );
      await this.validatePlanPhase(manager, developmentPlan, workHistory);

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

      // 7. Build agency context (§5.1 — agency-only at this point, so
      //    `responsibleAgency` is always auto-populated).
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
              // §16.5 indicator-relaxation — equipment never persists a
              // KPI even on STRATEGY_BASED plans.
              indicator: null,
              developmentIssue: null,
            };

      const entity = manager.create(EquipmentProjectGroup, {
        equipmentName: dto.equipmentName,
        targetOutput: dto.targetOutput,
        expectedResults: dto.expectedResults,
        ...classificationColumns,
        equipmentCategory,
        developmentPlan,
        createdBy: workHistory,
        amphoe: { id: workHistory.amphoe.id } as any,
        localAdministrativeOrganization: {
          id: workHistory.localAdministrativeOrganization.id,
        } as any,
        // Agency callers never set `originAgencyId` (PG's LAO-origin
        // marker); equipment is agency-only by construction.
        originAgencyId: null as any,
        ...(agencyData as DeepPartial<EquipmentProjectGroup>),
      } as DeepPartial<EquipmentProjectGroup>);

      const saved = await manager.save(entity);

      // 8. §12 audit — write initial TrackingStatus row.
      const statusId = await this.resolveInitialStatusId(
        manager,
        dto.isDraft ?? false,
      );
      const tracking = manager.create(TrackingStatus, {
        equipmentProjectGroupId: saved,
        statusId: { id: statusId } as Status,
        createdBy: workHistory,
        isLatest: true,
      } as DeepPartial<TrackingStatus>);
      await manager.save(tracking);

      // 9. Budgets — same polymorphic pattern PG uses.
      if (Array.isArray(dto.budget) && dto.budget.length > 0) {
        await this.assertBudgetYears(dto.budget, developmentPlan);
        const budgets = dto.budget.map((b) =>
          manager.create(Budget, {
            equipmentProjectGroupId: { id: saved.id } as EquipmentProjectGroup,
            year: b.year,
            quantity: b.quantity,
          } as DeepPartial<Budget>),
        );
        await manager.save(budgets);
      }

      // 10. §17.4 `no-ai-baseline` snapshot — publish path only.
      //
      // Wave Equipment ผ.03 Phase 2 — BE-06 (2026-05-28). Mirrors the
      // SPG trigger in `TrackingStatusService.fireSpgBaselineSnapshot`
      // and the PG bulk path in `BulkUploadService.fireBaselineSnapshots`.
      //
      // Trigger policy:
      //   - Fires ONLY on the publish path (`isDraft=false` → `Pending`).
      //     Draft saves (`isDraft=true` → `Ready`) MUST NOT fire per
      //     §17.4 Wave 11 authoring-vs-workflow distinction.
      //   - Equipment is created through the wizard, which IS an
      //     authoring surface (BE-06 task §4 out-of-scope clause).
      //   - Snapshot write failure rolls back the equipment publish TX
      //     per BE-06 task §7 — `createSnapshot` opens its own inner
      //     transaction; any throw propagates out and the outer create
      //     transaction rolls back accordingly.
      //
      // Idempotency (§17.4 Wave 10):
      //   - `(target_kind, target_id, content_hash)` short-circuits on
      //     same-hash repeat fires.
      //   - `no-ai-baseline` is the lower endpoint rank; a future live
      //     `pre-submit-review` row (Phase 3) will upgrade-replace the
      //     baseline per the Wave 18C upgrade-from-baseline branch.
      //
      // §17.3 audit separation — snapshot row references the equipment
      // by `(target_kind='equipment-project-group', target_id=saved.id)`
      // WITHOUT an FK. No project-table mutation occurs in this call.
      if (!(dto.isDraft ?? false)) {
        await this.preSubmitSnapshotService.createSnapshot(
          userId,
          {
          targetKind: 'equipment-project-group',
          targetId: saved.id,
          workflow: 'add',
          // Null `result` → snapshot service writes the audit-baseline
          // row (`endpoint='no-ai-baseline'`). No live AI invocation,
          // no quota deduction, no `ai_usage_logs` row.
          result: null,
          project: {
            // Equipment field → canonical hash slot mapping (BE-06
            // task §7). Equipment relaxes `indicator` (§16.5
            // exception); the canonical hash omits it on the
            // STRATEGY_BASED branch because we pass null.
            title: saved.equipmentName ?? null,
            goal: saved.targetOutput ?? null,
            expected: saved.expectedResults ?? null,
            indicator: null,
            // Equipment has no lat/lng nor origin agency in its DTO.
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
            // Equipment-only discriminator — canonicalized by
            // `computeSmartApproveContentHash` only when non-null.
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
          // Forward the outer EntityManager so `loadOwnerWorkHistoryId`
          // sees the row we just inserted in this transaction. Without
          // this, READ COMMITTED isolation would hide the row from the
          // default-connection lookup and the trigger would throw
          // `404 ไม่พบรายการครุภัณฑ์`, rolling back the publish.
          manager,
        );
      }

      this.logger.log(
        `Created equipment id=${saved.id} format=${format} category=${equipmentCategory.code} createdBy=${workHistory.id} draft=${dto.isDraft ?? false}`,
      );
      return this.findOneInternal(manager, saved.id);
    });
  }

  // ──────────────────────────────────────────────────────────────────
  //  UPDATE
  // ──────────────────────────────────────────────────────────────────

  async update(
    id: string,
    dto: UpdateEquipmentProjectGroupDto,
    userId: string,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const workHistory = await this.workHistoryLookup.getCurrent(
        manager,
        userId,
      );
      this.workHistoryLookup.assertWorkStatusApproved(workHistory);
      this.assertAgencyWorkHistory(workHistory);

      const existing = await manager.findOne(EquipmentProjectGroup, {
        where: { id },
        relations: ['createdBy', 'developmentPlan'],
      });
      if (!existing) {
        throw new NotFoundException(`Equipment item not found: ${id}`);
      }
      this.assertOwnership(existing, workHistory);

      // QA DEF-1 fix — §14.3 / §14.9 Version Lineage Immutability. A frozen
      // EPG (one with a live RELPG descendant via prev_project_type=
      // 'equipment') MUST reject field mutation. Runs inside this
      // transaction's `manager` and BEFORE any repository write. No role
      // exemption (§14.5). Throws ConflictException PROJECT_HAS_DESCENDANT.
      await this.lineageLockService.assertEditable(id, 'equipment', manager);

      // Determine the effective developmentPlanId for shape resolution.
      // We disallow re-pointing the parent plan on update — that's a
      // structural change indistinguishable from delete + recreate.
      if (
        dto.developmentPlanId !== undefined &&
        dto.developmentPlanId !== existing.developmentPlan?.id
      ) {
        throw new BadRequestException(
          'EQUIPMENT_PLAN_IMMUTABLE: ไม่อนุญาตให้เปลี่ยนแผนพัฒนาของรายการครุภัณฑ์',
        );
      }
      const planId = existing.developmentPlan!.id;

      const format = await this.bookFormatResolver.resolveByPlan(
        planId,
        manager,
      );

      // Build the effective post-update classification slot map so the
      // shape validator sees the FINAL state, not just the patch delta.
      const effective = this.mergeClassificationForUpdate(existing, dto);

      this.classificationValidator.validate(format, {
        strategyId: effective.strategyId,
        tacticId: effective.tacticId,
        planId: effective.planId,
        developmentIssueId: effective.developmentIssueId,
        indicator: format === ReportFormat.STRATEGY_BASED ? '_' : null,
      });

      // Re-validate the format-specific scope ONLY when relevant slots
      // were touched.
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
          planId,
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

      const patch: DeepPartial<EquipmentProjectGroup> = {
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

      await manager.update(EquipmentProjectGroup, { id }, patch as any);

      // Budgets — replace-all when supplied (mirror PG `publishDraft`).
      if (dto.budget !== undefined) {
        await manager.delete(Budget, {
          equipmentProjectGroupId: { id } as any,
        });
        if (dto.budget.length > 0) {
          await this.assertBudgetYears(
            dto.budget,
            existing.developmentPlan as DevelopmentPlan,
          );
          const budgets = dto.budget.map((b) =>
            manager.create(Budget, {
              equipmentProjectGroupId: {
                id,
              } as EquipmentProjectGroup,
              year: b.year,
              quantity: b.quantity,
            } as DeepPartial<Budget>),
          );
          await manager.save(budgets);
        }
      }

      this.logger.log(
        `Updated equipment id=${id} format=${format} category=${equipmentCategory.code} updatedBy=${workHistory.id}`,
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

      const existing = await manager.findOne(EquipmentProjectGroup, {
        where: { id },
        relations: ['createdBy'],
      });
      if (!existing) {
        throw new NotFoundException(`Equipment item not found: ${id}`);
      }
      this.assertOwnership(existing, workHistory);

      // QA DEF-1 fix — §14.3 / §14.9 Version Lineage Immutability. A frozen
      // EPG (one with a live RELPG descendant via prev_project_type=
      // 'equipment') MUST reject soft-delete. Runs inside this transaction's
      // `manager` and BEFORE the softRemove write. No role exemption
      // (§14.5). Throws ConflictException PROJECT_HAS_DESCENDANT.
      await this.lineageLockService.assertDeletable(id, 'equipment', manager);

      await manager.softRemove(EquipmentProjectGroup, existing);
      this.logger.log(`Soft-removed equipment id=${id} by=${workHistory.id}`);
    });
  }

  // ──────────────────────────────────────────────────────────────────
  //  READ (LAO users allowed)
  // ──────────────────────────────────────────────────────────────────

  async findOne(id: string) {
    return this.findOneInternal(this.equipmentRepo.manager, id);
  }

  async findAll(query: ListEquipmentProjectGroupsQueryDto, userId: string) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    // Resolve caller WorkHistory only when we need owner-scoping. Read
    // is unrestricted otherwise (LAO users may view), but `mineOnly`
    // still requires a known caller.
    const qb = this.equipmentRepo
      .createQueryBuilder('equipment')
      .leftJoinAndSelect('equipment.createdBy', 'createdBy')
      // 2026-05-29 — load `createdBy.user` so the staff queue table
      // can surface "ผู้ส่ง" (firstName + lastName) per parity with
      // the project staff table (`TableHeaderVerify`'s "เจ้าของโครงการ"
      // column). Without this leftJoin the FE adapter sees
      // `createdBy.user = undefined` and renders '-' silently.
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      // 2026-05-30 — load the creator WorkHistory's amphoe + LAO so the
      // staff table avatar tooltip shows full owner context (parity with
      // the project table's Avatars props).
      .leftJoinAndSelect('createdBy.amphoe', 'createdByAmphoe')
      .leftJoinAndSelect(
        'createdBy.localAdministrativeOrganization',
        'createdByLao',
      )
      .leftJoinAndSelect('equipment.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('equipment.strategy', 'strategy')
      .leftJoinAndSelect('equipment.tactic', 'tactic')
      .leftJoinAndSelect('equipment.plan', 'plan')
      .leftJoinAndSelect('equipment.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('equipment.equipmentCategory', 'equipmentCategory')
      .leftJoinAndSelect('equipment.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('equipment.amphoe', 'amphoe')
      .leftJoinAndSelect(
        'equipment.localAdministrativeOrganization',
        'lao',
      )
      .leftJoinAndSelect('equipment.budgets', 'budgets')
      .leftJoinAndSelect('equipment.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .where('equipment.deletedAt IS NULL');

    if (query.developmentPlanId) {
      qb.andWhere('developmentPlan.id = :planId', {
        planId: query.developmentPlanId,
      });
    }

    // Staff review queues opt in to exclude เข้าเล่ม (booked) rows so a
    // finalized book stops surfacing actionable items (parity with the
    // project finder's `projectGroup.isBooked = false` filter at
    // project-groups.service.ts). Per-row flag is authoritative — the
    // revision-equipment source picker omits this and still sees booked
    // originals as valid revision sources.
    if (query.excludeBooked) {
      qb.andWhere('equipment.isBooked = :notBooked', { notBooked: false });
    }

    if (query.status) {
      qb.andWhere(
        'EXISTS (SELECT 1 FROM tracking_status ts ' +
          ' INNER JOIN status s ON s.id = ts.status_id ' +
          ' WHERE ts.equipment_project_group_id = equipment.id ' +
          '   AND ts.is_latest = true ' +
          '   AND s.name = :statusName)',
        { statusName: query.status },
      );
    }

    if (query.mineOnly) {
      const workHistory = await this.workHistoryLookup.getCurrent(
        this.equipmentRepo.manager,
        userId,
      );
      this.workHistoryLookup.assertWorkStatusApproved(workHistory);
      qb.andWhere('createdBy.id = :ownerId', { ownerId: workHistory.id });
    }

    qb.orderBy('equipment.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();
    // 2026-05-30 — W100 PII: decrypt-then-mask createdBy.user before
    // returning so the staff table shows masked email (not ciphertext).
    await this.maskCreatedByUserOnEquipment(items);

    // CLAUDE.md §14 — decorate each EPG with `hasDescendant` so the
    // revision-equipment "select source" list can lock / hide an EPG that
    // already has a live RELPG (revised_equipment_project_groups with
    // prev_project_type='equipment', deleted_at IS NULL). Single batched
    // query (mirrors project-groups.findProjectGroupIdsWithDescendants).
    if (items.length > 0) {
      const rows = (await this.dataSource.query(
        `SELECT DISTINCT prev_project_id AS "parentId"
           FROM revised_equipment_project_groups
          WHERE prev_project_id = ANY($1::uuid[])
            AND prev_project_type = 'equipment'
            AND deleted_at IS NULL`,
        [items.map((i) => i.id)],
      )) as Array<{ parentId: string }>;
      const lockedIds = new Set(rows.map((r) => r.parentId));
      items.forEach((i) => {
        (i as unknown as { hasDescendant: boolean }).hasDescendant =
          lockedIds.has(i.id);
      });
    }

    return {
      items,
      total,
      page,
      limit,
    };
  }

  /**
   * Wave Equipment Sidebar Counts — BE-01 (2026-05-28).
   *
   * Owner-scoped count envelope powering the 4 sidebar badges at
   * `/project/equipment/{ready-to-send,verify,edit,pullback}`.
   *
   * Response shape (FROZEN):
   *   `{ ready, pending, verified, returnedForRevision, pullBack }`
   *
   * Authority:
   *   - agency-classified callers — live `COUNT(*) FILTER` aggregation
   *     over the caller's owned equipment rows (`createdBy.id =
   *     currentWorkHistory.id`, `deleted_at IS NULL`, latest tracking
   *     row resolves to one of the 5 named statuses).
   *   - LAO / non-agency callers — receive all-zero envelope at HTTP
   *     200 (NOT 403). Mirrors `SPG.findMineCounts` defensive zero;
   *     equipment is agency-only by §5.3 construction so LAO counts
   *     are vacuous. Skips the DB query entirely.
   *   - §17.11 — no role bypass. super-admin LAO ALSO receives zeros;
   *     classification (§1) is the only gate.
   *   - §2 `workStatus = approved` still applies via
   *     `WorkHistoryLookupService.assertWorkStatusApproved`.
   *
   * Compliance:
   *   - §17.2 advisory-only — output MUST NOT gate any workflow.
   *   - §17.3 audit separation — READ-ONLY. NO `TrackingStatus` writes.
   *   - §12 — no transition; this is a pure read.
   *
   * Implementation: ONE SQL round-trip via Postgres
   * `COUNT(*) FILTER (WHERE …)`. JOIN topology mirrors `findAll`'s
   * `status` filter EXISTS-clause and `SPG.findMineCounts` exactly,
   * so badge count and page list cannot drift.
   *
   * Statuses outside the 5 envelope keys (`Pending_Approval`,
   * `Approved`, `Rejected`) are SILENTLY DROPPED — no consuming
   * surface per the wave scope.
   *
   * Sibling pattern: `SPG.findMineCounts` at
   * `supplement-project-group.service.ts:533`.
   */
  async getCountsByStatus(
    userId: string,
  ): Promise<EquipmentCountsByStatusDto> {
    // 1-3. Resolve WorkHistory + §2 workStatus gate. Mirrors
    //      `findAll(mineOnly=true)`. Uses the default manager because
    //      this is a read-only round-trip (no enclosing transaction).
    const workHistory = await this.workHistoryLookup.getCurrent(
      this.equipmentRepo.manager,
      userId,
    );
    this.workHistoryLookup.assertWorkStatusApproved(workHistory);

    // 4. §1 / §5.3 classification gate — LAO callers (and any non-agency
    //    work history) get the zero envelope IMMEDIATELY. No DB hit.
    //    This is the deliberate divergence from the write surfaces in
    //    this service: write paths throw `403 EQUIPMENT_AGENCY_ONLY`,
    //    read counts return zeros so the sidebar fetch never errors
    //    (matches `SPG.findMineCounts` and the FE `fallbackZero`
    //    contract documented in BE-01 task §README → LAO short-circuit).
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
    //    mirrors `findAll` and `SPG.findMineCounts`:
    //      - INNER JOIN `equipment.trackingStatus` ON `is_latest = true`
    //      - INNER JOIN `latestTracking.statusId` ON status PK
    //      - WHERE `createdBy.id = :workHistoryId`
    //      - WHERE `equipment.deleted_at IS NULL` (TypeORM applies the
    //        soft-delete filter automatically; explicit `IS NULL` kept
    //        for parity with `findAll`)
    //
    //    Lowercase SQL aliases — Postgres folds unquoted identifiers to
    //    lowercase. Map to camelCase response keys explicitly below.
    const row = await this.equipmentRepo
      .createQueryBuilder('equipment')
      .innerJoin('equipment.createdBy', 'createdBy')
      .innerJoin(
        'equipment.trackingStatus',
        'latestTracking',
        'latestTracking.isLatest = :isLatest',
        { isLatest: true },
      )
      .innerJoin('latestTracking.statusId', 'latestStatus')
      .where('createdBy.id = :workHistoryId', {
        workHistoryId: workHistory.id,
      })
      .andWhere('equipment.deleted_at IS NULL')
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

    // `pg` driver returns COUNT as string; coerce defensively. FILTER
    // aggregates always return 0 on an empty set so `null` is
    // unreachable in practice — guarded anyway.
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

  // ──────────────────────────────────────────────────────────────────
  //  Private helpers
  // ──────────────────────────────────────────────────────────────────

  /**
   * §1 agency-only gate — Layer 2 (defense-in-depth). Layer 1 is the
   * controller's `AgencyOnlyGuard`. Mirrors the in-line check at
   * `RevisedProjectGroupsService` (revised-project-group.service.ts:2233-2239).
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
   * §4 — Ownership check. Compares `equipment.createdBy.id` against
   * `workHistory.id`, NEVER `userId`.
   */
  private assertOwnership(
    equipment: EquipmentProjectGroup,
    workHistory: WorkHistory,
  ): void {
    if (equipment.createdBy?.id !== workHistory.id) {
      throw new ForbiddenException(
        'คุณไม่มีสิทธิ์ดำเนินการกับรายการครุภัณฑ์นี้',
      );
    }
  }

  /**
   * §8 main-plan activation — load + assert isLatest=true, isBooked=false.
   */
  private async loadActivePlan(
    manager: EntityManager,
    planId: string,
  ): Promise<DevelopmentPlan> {
    const plan = await manager.findOne(DevelopmentPlan, {
      where: { id: planId },
    });
    if (!plan) {
      throw new NotFoundException(`Development Plan not found: ${planId}`);
    }
    if (!plan.isLatest) {
      throw new BadRequestException('แผนพัฒนาฯ ที่ระบุไม่ใช่แผนปัจจุบัน');
    }
    if (plan.isBooked) {
      throw new BadRequestException(
        'แผนพัฒนาฯ ถูกรวมเล่มแล้ว ไม่สามารถดำเนินการได้',
      );
    }
    return plan;
  }

  /**
   * §4.2 — equipment is agency-only, so the matching PlanPhase MUST be
   * the agency phase. Mirrors `ProjectGroupsService.validatePlanPhase`
   * but the requiredPhaseType is fixed (no LAO branch).
   */
  private async validatePlanPhase(
    manager: EntityManager,
    plan: DevelopmentPlan,
    _workHistory: WorkHistory,
  ): Promise<void> {
    const openPhase = await manager.findOne(PlanPhase, {
      where: {
        developmentPlan: { id: plan.id },
        phaseType: PhaseType.AGENCY,
        isOpen: true,
      },
    });
    if (!openPhase) {
      throw new BadRequestException(
        'ระยะเวลายื่นโครงการสำหรับ ส่วนราชการ (AGENCY) ยังไม่เปิด หรือปิดแล้ว',
      );
    }
  }

  private async loadEquipmentCategory(
    manager: EntityManager,
    id: string,
  ): Promise<EquipmentCategory> {
    const cat = await manager.findOne(EquipmentCategory, { where: { id } });
    if (!cat) {
      throw new NotFoundException(
        `EQUIPMENT_CATEGORY_NOT_FOUND: ${id}`,
      );
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
   * `EQUIPMENT_CATEGORY_SCOPE_INVALID` on miss.
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
      // Equipment-specific code per BE-04 spec (clearer than the
      // generic §16 mismatch code).
      throw new BadRequestException(
        `EQUIPMENT_ISSUE_NOT_IN_PLAN: ${ERROR_MESSAGES.DEVELOPMENT_ISSUE_PLAN_MISMATCH}`,
      );
    }
    return issue;
  }

  private mergeClassificationForUpdate(
    existing: EquipmentProjectGroup,
    dto: UpdateEquipmentProjectGroupDto,
  ): {
    strategyId?: string | null;
    tacticId?: string | null;
    planId?: string | null;
    developmentIssueId?: string | null;
  } {
    // When a slot is `undefined` in the patch, fall back to the
    // existing row's value. When it's explicitly `null` / empty
    // string, clear it (handled by the validator's empty-to-null
    // normalisation).
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
      // Mirror PG: use the literal `Ready` id used elsewhere.
      return EquipmentProjectGroupService.READY_STATUS_ID;
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
  ): Promise<EquipmentProjectGroup> {
    const row = await manager.findOne(EquipmentProjectGroup, {
      where: { id },
      relations: [
        'createdBy',
        'developmentPlan',
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
        // 2026-05-30 — Wave Equipment Comment Visibility (BE-01). The
        // owner edit page renders the staff review-comment thread, so
        // the detail read MUST eager-load the tracking-status comment
        // sub-tree + author chain. Shape parity with the project detail
        // path (`ProjectGroupsService` loads `trackingStatus.comments`
        // + `trackingStatus.createdBy` + `trackingStatus.createdBy.user`).
        // `comments` is the OneToMany relation name on TrackingStatus
        // (Comment has no own author — the author IS the tracking row's
        // `createdBy`). Author PII is masked in
        // `maskCreatedByUserOnEquipment` (display name preserved).
        'trackingStatus.comments',
        'trackingStatus.createdBy',
        'trackingStatus.createdBy.user',
      ],
    });
    if (!row) {
      throw new NotFoundException(`Equipment item not found: ${id}`);
    }
    // 2026-05-30 — W100 PII mask on the detail read too. Now also masks
    // the staff comment authors loaded via `trackingStatus.createdBy.user`.
    await this.maskCreatedByUserOnEquipment([row]);
    return row;
  }
}

// Silence unused import warning — ConflictException is retained for
// forward compatibility (e.g., future duplicate-name guard).
void ConflictException;
