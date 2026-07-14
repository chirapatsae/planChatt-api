import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, DeepPartial, EntityManager, Repository } from 'typeorm';

import { RevisedEquipmentProjectGroup } from './entities/revised-equipment-project-group.entity';
import { PrevEquipmentProjectType } from './dto/prev-equipment-project-type.enum';
import { CreateRevisedEquipmentProjectGroupDto } from './dto/create-revised-equipment-project-group.dto';
import { UpdateRevisedEquipmentProjectGroupDto } from './dto/update-revised-equipment-project-group.dto';
import { ListRevisedEquipmentProjectGroupsQueryDto } from './dto/list-revised-equipment-project-groups-query.dto';
import { RevisedEquipmentCountsByStatusDto } from './dto/revised-equipment-counts-by-status.dto';
import { StaffTransitionRevisedEquipmentProjectGroupDto } from './dto/staff-transition-revised-equipment-project-group.dto';
import { RollbackRevisedEquipmentProjectGroupDto } from './dto/rollback-revised-equipment-project-group.dto';

import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { WorkHistoryGovernmentAgencyResponsibility } from 'src/work-history-government-agency-responsibility/entities/work-history-government-agency-responsibility.entity';
import { WorkHistoryLookupService } from 'src/work-history/work-history-lookup.service';
import { ProjectClassificationValidator } from 'src/common/project-classification/project-classification.validator';
import { BookFormatResolver } from 'src/common/project-classification/book-format.resolver';
import { LineageLockService } from 'src/common/lineage-lock/lineage-lock.service';
import { ReportFormat } from 'src/development-plan/types/report-format.enum';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { EquipmentProjectGroup } from 'src/equipment-project-group/entities/equipment-project-group.entity';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { EquipmentCategory } from 'src/equipment-category/entities/equipment-category.entity';
import { EquipmentCategoryScope } from 'src/equipment-category/entities/equipment-category-scope.entity';
import { Status } from 'src/status/entities/status.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { Budget } from 'src/budget/entities/budget.entity';
import { STATUS_NAMES } from 'src/common/status-names';
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
 * Wave Equipment Revision Management — BE-01 (Phase 3).
 *
 * RELPG (RevisedEquipmentProjectGroup) — the equipment (ผ.03) analog of
 * `RevisedProjectGroupService`. User-facing CRUD + workflow + audit for
 * forking an approved EquipmentProjectGroup (EPG) into a
 * DevelopmentPlanRevision (DPR) context.
 *
 * Structural template: `EquipmentProjectGroupService` (agency-only gate,
 * dual-shape classification, scope-junction validation, no-ai-baseline
 * snapshot, PII mask). Revision-context adaptations: DPR `isOpen` scope
 * binding (§9 / §10), §14 lineage-lock check on the source EPG, lineage
 * columns, Pull Back (GLOBAL PULL BACK RULE).
 *
 * # Locked constraints
 *
 * - **Agency-only writes (§3 / §5.3).** Every write method calls
 *   `assertAgencyWorkHistory` as Layer-2 defense (controller mounts
 *   `AgencyOnlyGuard` as Layer-1). LAO callers → `403 EQUIPMENT_AGENCY_ONLY`.
 *   Read methods do NOT enforce the gate (§5.3 — reads unrestricted).
 * - **§14 lineage lock.** `assertEditable(epg.id, 'equipment', em)` runs
 *   BEFORE the fork insert; a second live RELPG fork → `409
 *   PROJECT_HAS_DESCENDANT`. Edit / delete of a RELPG that itself has a
 *   live RELPG descendant → same code via `assertEditable(id,
 *   'revised_equipment', em)` / `assertDeletable`.
 * - **§11 versioning.** Fork = new RELPG row; the source EPG is untouched.
 *   Pull Back reuses the SAME RELPG row (no new version).
 * - **§12 audit.** Create writes `Ready`; submit writes `Pending`; pull
 *   back writes `Pull_Back`. Every transition writes a `TrackingStatus`
 *   row tagged on `revisedEquipmentProjectGroupId`.
 * - **§17.4.** Submit fires a `no-ai-baseline` snapshot
 *   (`target_kind='revised-equipment-project-group'`,
 *   `staleness_policy='snapshot-only'`) INSIDE the same transaction as
 *   the `Pending` tracking insert.
 * - **§13 N/A** — equipment is not geographic; no geolocation validation.
 *
 * Staff endpoints (verify / approve / return / rollback) are OUT OF SCOPE
 * here (BE-02). BE-02 extends this service; the service is `export`ed
 * from the module so BE-02 can add staff-transition methods alongside the
 * owner-scoped CRUD below.
 */
@Injectable()
export class RevisedEquipmentProjectGroupService {
  private readonly logger = new Logger(
    RevisedEquipmentProjectGroupService.name,
  );

  // Canonical Status row id — mirror the literal `Ready` id used by
  // `EquipmentProjectGroupService` / `ProjectGroupsService` so RELPG audit
  // rows stay in lockstep with the rest of the workflow. `Pending` /
  // `Pull_Back` are resolved by name to avoid baking additional literals.
  private static readonly READY_STATUS_ID =
    '8219cd82-fa61-4292-bd0d-fa58b08507e1';

  constructor(
    @InjectRepository(RevisedEquipmentProjectGroup)
    private readonly relpgRepo: Repository<RevisedEquipmentProjectGroup>,
    private readonly dataSource: DataSource,
    private readonly workHistoryLookup: WorkHistoryLookupService,
    private readonly classificationValidator: ProjectClassificationValidator,
    private readonly bookFormatResolver: BookFormatResolver,
    private readonly lineageLockService: LineageLockService,
    private readonly preSubmitSnapshotService: PreSubmitSnapshotService,
    private readonly usersService: UsersService,
  ) {}

  // ====================================================================
  //  CREATE / fork EPG → RELPG (§7.2)
  // ====================================================================

  /**
   * Publish-on-create entry point. Defaults to draft (Ready) unless the
   * DTO explicitly sets `isDraft: false` to publish straight to Pending.
   */
  async create(
    dto: CreateRevisedEquipmentProjectGroupDto,
    userId: string,
  ): Promise<RevisedEquipmentProjectGroup> {
    return this.forkInternal(dto, userId, dto.isDraft ?? true);
  }

  /**
   * Explicit draft fork — same as `create` but forces the Ready initial
   * status regardless of the DTO `isDraft` flag.
   */
  async createDraft(
    dto: CreateRevisedEquipmentProjectGroupDto,
    userId: string,
  ): Promise<RevisedEquipmentProjectGroup> {
    return this.forkInternal(dto, userId, true);
  }

  private async forkInternal(
    dto: CreateRevisedEquipmentProjectGroupDto,
    userId: string,
    isDraft: boolean,
  ): Promise<RevisedEquipmentProjectGroup> {
    return this.dataSource.transaction(async (manager) => {
      // 1-3. Auth → WorkHistory → workStatus=approved.
      const workHistory = await this.workHistoryLookup.getCurrent(
        manager,
        userId,
      );
      this.workHistoryLookup.assertWorkStatusApproved(workHistory);

      // 4-5. §1 classification + agency-only gate (Layer-2 defense).
      this.assertAgencyWorkHistory(workHistory);

      // 6a. Resolve the lineage source. EXACTLY ONE of the two source ids is
      //     accepted (§14.1/§14.7 Phase 3):
      //       - `equipmentProjectGroupId`        → fork an EPG root
      //         (`prev_project_type='equipment'`).
      //       - `revisedEquipmentProjectGroupId` → fork an Approved RELPG tip
      //         (`prev_project_type='revised_equipment'`, RELPG→RELPG chain).
      const hasEpgSource = !!dto.equipmentProjectGroupId;
      const hasRelpgSource = !!dto.revisedEquipmentProjectGroupId;
      if (hasEpgSource === hasRelpgSource) {
        throw new BadRequestException(
          'Exactly one of equipmentProjectGroupId / revisedEquipmentProjectGroupId must be supplied',
        );
      }

      // The lineage-root EPG (FK kept populated on the new RELPG regardless of
      // source kind) and the §14 lineage edge the new RELPG points at.
      let rootEpg: EquipmentProjectGroup;
      let prevProjectId: string;
      let prevProjectType: PrevEquipmentProjectType;

      if (hasEpgSource) {
        // Load source EPG (lineage root). Must exist, not soft-deleted,
        // latest status = Approved (§7.2 step 2).
        const epg = await manager.findOne(EquipmentProjectGroup, {
          where: { id: dto.equipmentProjectGroupId },
          relations: ['developmentPlan'],
        });
        if (!epg) {
          throw new NotFoundException(
            `EquipmentProjectGroup (source) not found: ${dto.equipmentProjectGroupId}`,
          );
        }
        await this.assertEpgApproved(manager, epg.id);

        // §14 lineage lock — reject if the EPG already has a live RELPG
        // descendant. MUST run BEFORE any write (§14.9).
        await this.lineageLockService.assertEditable(
          epg.id,
          'equipment',
          manager,
        );

        rootEpg = epg;
        prevProjectId = epg.id;
        prevProjectType = PrevEquipmentProjectType.EQUIPMENT;
      } else {
        // Load source RELPG tip. Must exist, not soft-deleted, latest status =
        // Approved. Its own `equipmentProjectGroup` is the lineage-root EPG.
        const srcRelpg = await manager.findOne(RevisedEquipmentProjectGroup, {
          where: { id: dto.revisedEquipmentProjectGroupId },
          relations: ['equipmentProjectGroup', 'equipmentProjectGroup.developmentPlan'],
        });
        if (!srcRelpg) {
          throw new NotFoundException(
            `RevisedEquipmentProjectGroup (source) not found: ${dto.revisedEquipmentProjectGroupId}`,
          );
        }
        await this.assertRelpgApproved(manager, srcRelpg.id);

        // §14 lineage lock — reject if the source RELPG already has a live
        // `revised_equipment` descendant. MUST run BEFORE any write (§14.9).
        await this.lineageLockService.assertEditable(
          srcRelpg.id,
          'revised_equipment',
          manager,
        );

        if (!srcRelpg.equipmentProjectGroup) {
          throw new NotFoundException(
            `Lineage-root EquipmentProjectGroup not found for RELPG ${srcRelpg.id}`,
          );
        }
        rootEpg = srcRelpg.equipmentProjectGroup;
        prevProjectId = srcRelpg.id;
        prevProjectType = PrevEquipmentProjectType.REVISED_EQUIPMENT;
      }
      const epg = rootEpg;

      // 7. Load DPR + §9 / §10 scope binding (isOpen = true). Scope is
      //    bound to the RELPG's OWN DPR — never a global latest lookup.
      const dpr = await this.loadOpenRevision(
        manager,
        dto.developmentPlanRevisionId,
      );

      // 8. §16.5 — resolve parent plan reportFormat via DPR → plan, then
      //    validate the incoming classification shape.
      const format = await this.bookFormatResolver.resolveByRevision(
        dto.developmentPlanRevisionId,
        manager,
      );
      this.classificationValidator.validate(format, {
        strategyId: dto.strategyId,
        tacticId: dto.tacticId,
        planId: dto.planId,
        developmentIssueId: dto.developmentIssueId,
        // Equipment relaxes the STRATEGY_BASED indicator floor; force a
        // non-empty sentinel for the validator only — the persisted row
        // keeps `indicator = null`.
        indicator: format === ReportFormat.STRATEGY_BASED ? '_' : null,
      });

      // 9. Format-specific FK + scope-junction validation.
      const equipmentCategory = await this.loadEquipmentCategory(
        manager,
        dto.equipmentCategoryId,
      );

      const developmentPlan = dpr.developmentPlan;
      if (!developmentPlan) {
        throw new NotFoundException(
          `Parent DevelopmentPlan not found for revision ${dpr.id}`,
        );
      }

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

      // 10. §5.1 — agency-origin (always, equipment is agency-only), so
      //     responsibleAgency is auto-assigned from creator context.
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
              // §16.5 indicator-relaxation — equipment never persists a KPI.
              indicator: null,
              developmentIssue: null,
            };

      const entity = manager.create(RevisedEquipmentProjectGroup, {
        developmentPlanRevision: dpr,
        developmentPlan,
        // FK kept on the lineage-root EPG regardless of source kind.
        equipmentProjectGroup: epg,
        // §14 lineage edge — EPG source → 'equipment'; RELPG source →
        // 'revised_equipment' (§14.1/§14.7 Phase 3 chain).
        prevProjectId,
        prevProjectType,
        equipmentName: dto.equipmentName,
        targetOutput: dto.targetOutput,
        expectedResults: dto.expectedResults,
        // Free-form revision request reason — additive metadata (mirrors
        // RPG.additionalDetail). Empty-string coerced to null.
        reason: dto.reason?.trim() ? dto.reason : null,
        ...classificationColumns,
        equipmentCategory,
        createdBy: workHistory,
        amphoe: { id: workHistory.amphoe.id } as any,
        localAdministrativeOrganization: {
          id: workHistory.localAdministrativeOrganization.id,
        } as any,
        // Agency callers never set `originAgencyId`.
        originAgencyId: null as any,
        ...(agencyData as DeepPartial<RevisedEquipmentProjectGroup>),
      } as DeepPartial<RevisedEquipmentProjectGroup>);

      const saved = await manager.save(entity);

      // 11. §12 audit — write initial TrackingStatus row.
      const statusId = await this.resolveInitialStatusId(manager, isDraft);
      const tracking = manager.create(TrackingStatus, {
        revisedEquipmentProjectGroupId: saved,
        statusId: { id: statusId } as Status,
        createdBy: workHistory,
        isLatest: true,
      } as DeepPartial<TrackingStatus>);
      await manager.save(tracking);

      // 12. Budgets — polymorphic pattern (5th FK column).
      if (Array.isArray(dto.budget) && dto.budget.length > 0) {
        await this.assertBudgetYears(dto.budget, developmentPlan);
        const budgets = dto.budget.map((b) =>
          manager.create(Budget, {
            revisedEquipmentProjectGroupId: {
              id: saved.id,
            } as RevisedEquipmentProjectGroup,
            year: b.year,
            quantity: b.quantity,
          } as DeepPartial<Budget>),
        );
        await manager.save(budgets);
      }

      // 13. §17.4 `no-ai-baseline` snapshot — publish path only. Fired
      //     INSIDE this transaction so an abort rolls back both the
      //     tracking insert and the snapshot (§17.4 / risks §11).
      if (!isDraft) {
        await this.fireBaselineSnapshot(
          manager,
          userId,
          saved,
          format,
          { strategy, tactic, plan, developmentIssue },
          workHistory,
          dto.budget,
        );
      }

      this.logger.log(
        `Created RELPG id=${saved.id} format=${format} epg=${epg.id} createdBy=${workHistory.id} draft=${isDraft}`,
      );
      return this.findOneInternal(manager, saved.id);
    });
  }

  // ====================================================================
  //  UPDATE (draft + post-Returned_For_Revision correction)
  // ====================================================================

  /**
   * §7.2 / §7.4 — owner-scoped edit. Allowed only when the latest status
   * is editable (`Ready`, `Pull_Back`, `Returned_For_Revision`). §14
   * lineage lock runs BEFORE any write.
   */
  async updateDraft(
    id: string,
    dto: UpdateRevisedEquipmentProjectGroupDto,
    userId: string,
  ): Promise<RevisedEquipmentProjectGroup> {
    return this.updateInternal(id, dto, userId);
  }

  /**
   * Alias for `updateDraft` — same owner-scoped edit semantics. Kept as a
   * distinct entry point so a future wave can diverge the post-submit
   * correction flow without a controller refactor.
   */
  async update(
    id: string,
    dto: UpdateRevisedEquipmentProjectGroupDto,
    userId: string,
  ): Promise<RevisedEquipmentProjectGroup> {
    return this.updateInternal(id, dto, userId);
  }

  private async updateInternal(
    id: string,
    dto: UpdateRevisedEquipmentProjectGroupDto,
    userId: string,
  ): Promise<RevisedEquipmentProjectGroup> {
    return this.dataSource.transaction(async (manager) => {
      const workHistory = await this.workHistoryLookup.getCurrent(
        manager,
        userId,
      );
      this.workHistoryLookup.assertWorkStatusApproved(workHistory);
      this.assertAgencyWorkHistory(workHistory);

      const existing = await manager.findOne(RevisedEquipmentProjectGroup, {
        where: { id },
        relations: [
          'createdBy',
          'developmentPlanRevision',
          'developmentPlanRevision.developmentPlan',
          'strategy',
          'tactic',
          'plan',
          'developmentIssue',
          'equipmentCategory',
        ],
      });
      if (!existing) {
        throw new NotFoundException(`RELPG not found: ${id}`);
      }
      this.assertOwnership(existing, workHistory);

      // §14 lineage lock — a RELPG with a live RELPG descendant is frozen.
      await this.lineageLockService.assertEditable(
        id,
        'revised_equipment',
        manager,
      );

      // §10 scope binding — the RELPG's OWN DPR must be open.
      const dpr = existing.developmentPlanRevision;
      if (!dpr) {
        throw new NotFoundException(
          `Parent DevelopmentPlanRevision not found for RELPG ${id}`,
        );
      }
      this.assertRevisionOpen(dpr);

      // Status must be editable (owner court).
      await this.assertLatestStatusIn(manager, id, [
        STATUS_NAMES.READY,
        STATUS_NAMES.PULL_BACK,
        STATUS_NAMES.RETURNED_FOR_REVISION,
      ]);

      // §16.5 — re-validate the effective post-update classification shape.
      const planId = dpr.developmentPlan?.id;
      if (!planId) {
        throw new NotFoundException(
          `Parent DevelopmentPlan not found for RELPG ${id}`,
        );
      }
      const format = await this.bookFormatResolver.resolveByRevision(
        dpr.id,
        manager,
      );
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

      const patch: DeepPartial<RevisedEquipmentProjectGroup> = {
        ...(dto.equipmentName !== undefined && {
          equipmentName: dto.equipmentName,
        }),
        ...(dto.targetOutput !== undefined && {
          targetOutput: dto.targetOutput,
        }),
        ...(dto.expectedResults !== undefined && {
          expectedResults: dto.expectedResults,
        }),
        // Free-form revision request reason — additive metadata. Only
        // patched when supplied; empty-string coerced to null.
        ...(dto.reason !== undefined && {
          reason: dto.reason?.trim() ? dto.reason : null,
        }),
        ...classificationColumns,
        equipmentCategory,
      };

      await manager.update(RevisedEquipmentProjectGroup, { id }, patch as any);

      // Budgets — replace-all when supplied (mirror EPG update).
      if (dto.budget !== undefined) {
        await manager.delete(Budget, {
          revisedEquipmentProjectGroupId: { id } as any,
        });
        if (dto.budget.length > 0) {
          await this.assertBudgetYears(dto.budget, dpr.developmentPlan!);
          const budgets = dto.budget.map((b) =>
            manager.create(Budget, {
              revisedEquipmentProjectGroupId: {
                id,
              } as RevisedEquipmentProjectGroup,
              year: b.year,
              quantity: b.quantity,
            } as DeepPartial<Budget>),
          );
          await manager.save(budgets);
        }
      }

      this.logger.log(
        `Updated RELPG id=${id} format=${format} updatedBy=${workHistory.id}`,
      );
      return this.findOneInternal(manager, id);
    });
  }

  // ====================================================================
  //  SUBMIT (Ready / Pull_Back / Returned_For_Revision → Pending) (§7.3)
  // ====================================================================

  async submit(id: string, userId: string): Promise<RevisedEquipmentProjectGroup> {
    return this.dataSource.transaction(async (manager) => {
      const workHistory = await this.workHistoryLookup.getCurrent(
        manager,
        userId,
      );
      this.workHistoryLookup.assertWorkStatusApproved(workHistory);
      this.assertAgencyWorkHistory(workHistory);

      const existing = await manager.findOne(RevisedEquipmentProjectGroup, {
        where: { id },
        relations: [
          'createdBy',
          'developmentPlanRevision',
          'developmentPlanRevision.developmentPlan',
          'strategy',
          'tactic',
          'plan',
          'developmentIssue',
          'equipmentCategory',
          'budgets',
        ],
      });
      if (!existing) {
        throw new NotFoundException(`RELPG not found: ${id}`);
      }
      this.assertOwnership(existing, workHistory);

      const dpr = existing.developmentPlanRevision;
      if (!dpr) {
        throw new NotFoundException(
          `Parent DevelopmentPlanRevision not found for RELPG ${id}`,
        );
      }
      this.assertRevisionOpen(dpr);

      // §7.3 — submit allowed from Ready / Pull_Back / Returned_For_Revision.
      const currentTracking = await this.assertLatestStatusIn(manager, id, [
        STATUS_NAMES.READY,
        STATUS_NAMES.PULL_BACK,
        STATUS_NAMES.RETURNED_FOR_REVISION,
      ]);

      // §12 audit — demote prior latest, insert Pending.
      const pendingStatusId = await this.resolveStatusIdByName(
        manager,
        STATUS_NAMES.PENDING,
      );
      await manager.update(
        TrackingStatus,
        { id: currentTracking.id },
        { isLatest: false },
      );
      const tracking = manager.create(TrackingStatus, {
        revisedEquipmentProjectGroupId: { id } as RevisedEquipmentProjectGroup,
        statusId: { id: pendingStatusId } as Status,
        createdBy: workHistory,
        isLatest: true,
      } as DeepPartial<TrackingStatus>);
      await manager.save(tracking);

      // §17.4 — fire no-ai-baseline INSIDE this transaction.
      const format = await this.bookFormatResolver.resolveByRevision(
        dpr.id,
        manager,
      );
      await this.fireBaselineSnapshot(
        manager,
        userId,
        existing,
        format,
        {
          strategy: existing.strategy,
          tactic: existing.tactic,
          plan: existing.plan,
          developmentIssue: existing.developmentIssue,
        },
        workHistory,
        existing.budgets?.map((b) => ({
          year: b.year,
          quantity: Number(b.quantity),
        })),
      );

      this.logger.log(`Submitted RELPG id=${id} by=${workHistory.id} → Pending`);
      return this.findOneInternal(manager, id);
    });
  }

  // ====================================================================
  //  PULL BACK (Pending / Verified → Pull_Back) (§7.4 / GLOBAL PULL BACK)
  // ====================================================================

  async pullBack(
    id: string,
    userId: string,
    comment?: string,
  ): Promise<RevisedEquipmentProjectGroup> {
    return this.dataSource.transaction(async (manager) => {
      const workHistory = await this.workHistoryLookup.getCurrent(
        manager,
        userId,
      );
      this.workHistoryLookup.assertWorkStatusApproved(workHistory);
      this.assertAgencyWorkHistory(workHistory);

      const existing = await manager.findOne(RevisedEquipmentProjectGroup, {
        where: { id },
        relations: [
          'createdBy',
          'developmentPlanRevision',
          'developmentPlanRevision.developmentPlan',
        ],
      });
      if (!existing) {
        throw new NotFoundException(`RELPG not found: ${id}`);
      }
      this.assertOwnership(existing, workHistory);

      const dpr = existing.developmentPlanRevision;
      if (!dpr) {
        throw new NotFoundException(
          `Parent DevelopmentPlanRevision not found for RELPG ${id}`,
        );
      }
      this.assertRevisionOpen(dpr);

      // GLOBAL PULL BACK RULE — only Pending / Verified may be pulled back.
      const currentTracking = await this.assertLatestStatusIn(manager, id, [
        STATUS_NAMES.PENDING,
        STATUS_NAMES.VERIFIED,
      ]);

      // §12 audit — demote prior latest, insert Pull_Back. No new version
      // (§11), responsibleAgency NEVER cleared (§7 Pull Back rule).
      const pullBackStatusId = await this.resolveStatusIdByName(
        manager,
        STATUS_NAMES.PULL_BACK,
      );
      await manager.update(
        TrackingStatus,
        { id: currentTracking.id },
        { isLatest: false },
      );
      const tracking = manager.create(TrackingStatus, {
        revisedEquipmentProjectGroupId: { id } as RevisedEquipmentProjectGroup,
        statusId: { id: pullBackStatusId } as Status,
        createdBy: workHistory,
        isLatest: true,
        // 2026-06-02 — owner pull-back reason (เหตุผลการขอดึงกลับ), mirrors
        // the project RPG pull-back `comment`. Trimmed; empty → null. §12.
        comment: comment?.trim() ? comment.trim() : undefined,
      } as DeepPartial<TrackingStatus>);
      await manager.save(tracking);

      this.logger.log(`Pulled back RELPG id=${id} by=${workHistory.id}`);
      return this.findOneInternal(manager, id);
    });
  }

  // ====================================================================
  //  DELETE (soft) (§14)
  // ====================================================================

  async softRemove(id: string, userId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const workHistory = await this.workHistoryLookup.getCurrent(
        manager,
        userId,
      );
      this.workHistoryLookup.assertWorkStatusApproved(workHistory);
      this.assertAgencyWorkHistory(workHistory);

      const existing = await manager.findOne(RevisedEquipmentProjectGroup, {
        where: { id },
        relations: ['createdBy'],
      });
      if (!existing) {
        throw new NotFoundException(`RELPG not found: ${id}`);
      }
      this.assertOwnership(existing, workHistory);

      // §14 lineage lock — guard BEFORE the soft-delete so cascade cannot
      // destroy a child RELPG silently.
      await this.lineageLockService.assertDeletable(
        id,
        'revised_equipment',
        manager,
      );

      await manager.softRemove(RevisedEquipmentProjectGroup, existing);
      this.logger.log(`Soft-removed RELPG id=${id} by=${workHistory.id}`);
    });
  }

  // ====================================================================
  //  READ (LAO users allowed — §5.3)
  // ====================================================================

  async findOne(id: string): Promise<RevisedEquipmentProjectGroup> {
    return this.findOneInternal(this.relpgRepo.manager, id);
  }

  async findAll(
    query: ListRevisedEquipmentProjectGroupsQueryDto,
    userId: string,
  ): Promise<{
    items: RevisedEquipmentProjectGroup[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.relpgRepo
      .createQueryBuilder('relpg')
      .leftJoinAndSelect('relpg.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'createdByAmphoe')
      .leftJoinAndSelect(
        'createdBy.localAdministrativeOrganization',
        'createdByLao',
      )
      .leftJoinAndSelect('relpg.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect(
        'relpg.developmentPlanRevision',
        'developmentPlanRevision',
      )
      .leftJoinAndSelect('relpg.equipmentProjectGroup', 'equipmentProjectGroup')
      .leftJoinAndSelect('relpg.strategy', 'strategy')
      .leftJoinAndSelect('relpg.tactic', 'tactic')
      .leftJoinAndSelect('relpg.plan', 'plan')
      .leftJoinAndSelect('relpg.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('relpg.equipmentCategory', 'equipmentCategory')
      .leftJoinAndSelect('relpg.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('relpg.amphoe', 'amphoe')
      .leftJoinAndSelect('relpg.localAdministrativeOrganization', 'lao')
      .leftJoinAndSelect('relpg.budgets', 'budgets')
      .leftJoinAndSelect('relpg.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .where('relpg.deletedAt IS NULL');

    // §10 scope binding — filter by the RELPG's OWN DPR.
    if (query.developmentPlanRevisionId) {
      qb.andWhere('developmentPlanRevision.id = :dprId', {
        dprId: query.developmentPlanRevisionId,
      });
    }

    if (query.status) {
      qb.andWhere(
        'EXISTS (SELECT 1 FROM tracking_status ts ' +
          ' INNER JOIN status s ON s.id = ts.status_id ' +
          ' WHERE ts.revised_equipment_project_group_id = relpg.id ' +
          '   AND ts.is_latest = true ' +
          '   AND s.name = :statusName)',
        { statusName: query.status },
      );
    }

    if (query.mineOnly) {
      const workHistory = await this.workHistoryLookup.getCurrent(
        this.relpgRepo.manager,
        userId,
      );
      this.workHistoryLookup.assertWorkStatusApproved(workHistory);
      qb.andWhere('createdBy.id = :ownerId', { ownerId: workHistory.id });
    }

    qb.orderBy('relpg.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();
    await this.maskCreatedByUserOnRelpg(items);
    this.projectLatestStatusOnRelpg(items);
    return { items, total, page, limit };
  }

  /**
   * Owner-scoped list — thin wrapper over `findAll` forcing `mineOnly`.
   */
  async findMine(
    query: ListRevisedEquipmentProjectGroupsQueryDto,
    userId: string,
  ): Promise<{
    items: RevisedEquipmentProjectGroup[];
    total: number;
    page: number;
    limit: number;
  }> {
    return this.findAll({ ...query, mineOnly: true }, userId);
  }

  /**
   * Wave equipment-revision-pool-lineage-tip-fix — BE-01.
   *
   * Returns the Approved RELPG lineage LEAVES under a plan: each RELPG whose
   * latest status is `Approved`, `deletedAt IS NULL`, and that has NO live
   * `revised_equipment` descendant (i.e. it is the head-of-lineage tip). This
   * is the equipment analog of `project-groups.service.ts`
   * `findLineageLeafRevisedProjects` — it lets the revision/change equipment
   * wizard offer a lineage whose head is now an RELPG (the locked-ancestor EPG
   * is excluded from the EPG list via its `hasDescendant` flag; without this
   * method the whole lineage would vanish from the pool).
   *
   * §10 scope binding — filtered by the RELPG's OWN `developmentPlan`. §5.3 —
   * read surface, no agency-only gate. Scale-safe: ONE list query + ONE
   * batched descendant lookup (no N+1).
   */
  async findApprovedLineageLeafSources(
    developmentPlanId: string,
    userId: string,
  ): Promise<{ items: RevisedEquipmentProjectGroup[] }> {
    if (!developmentPlanId) {
      throw new BadRequestException('developmentPlanId is required');
    }

    // Resolve + assert the caller's workStatus (§2). Read surface — no
    // agency-only gate (§5.3 reads unrestricted).
    const workHistory = await this.workHistoryLookup.getCurrent(
      this.relpgRepo.manager,
      userId,
    );
    this.workHistoryLookup.assertWorkStatusApproved(workHistory);

    const items = await this.relpgRepo
      .createQueryBuilder('relpg')
      .leftJoinAndSelect('relpg.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'createdByAmphoe')
      .leftJoinAndSelect(
        'createdBy.localAdministrativeOrganization',
        'createdByLao',
      )
      .leftJoinAndSelect('relpg.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect(
        'relpg.developmentPlanRevision',
        'developmentPlanRevision',
      )
      // Source-book badge (parity with project pool) needs the revisionType
      // name (แก้ไข / เปลี่ยนแปลง) so the FE can label which round the RELPG
      // leaf came from. Without this join `revisionType` is undefined and the
      // FE falls back to "เล่มแก้ไข" for every RELPG.
      .leftJoinAndSelect('developmentPlanRevision.revisionType', 'revisionType')
      .leftJoinAndSelect('relpg.equipmentProjectGroup', 'equipmentProjectGroup')
      .leftJoinAndSelect('relpg.strategy', 'strategy')
      .leftJoinAndSelect('relpg.tactic', 'tactic')
      .leftJoinAndSelect('relpg.plan', 'plan')
      .leftJoinAndSelect('relpg.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('relpg.equipmentCategory', 'equipmentCategory')
      .leftJoinAndSelect('relpg.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('relpg.amphoe', 'amphoe')
      .leftJoinAndSelect('relpg.localAdministrativeOrganization', 'lao')
      .leftJoinAndSelect('relpg.budgets', 'budgets')
      .leftJoinAndSelect('relpg.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .where('relpg.deletedAt IS NULL')
      // §10 — scope to the RELPG's own parent plan.
      .andWhere('developmentPlan.id = :planId', { planId: developmentPlanId })
      // Latest status = Approved (mirror `findAll` status EXISTS clause).
      .andWhere(
        'EXISTS (SELECT 1 FROM tracking_status ts ' +
          ' INNER JOIN status s ON s.id = ts.status_id ' +
          ' WHERE ts.revised_equipment_project_group_id = relpg.id ' +
          '   AND ts.is_latest = true ' +
          "   AND s.name = 'Approved')",
      )
      // §14.2/§14.7 head-of-lineage — exclude RELPGs that already have a live
      // `revised_equipment` child. The alias is quoted ("relpg".id) so
      // Postgres does NOT lowercase it (avoids 42P01 — the lesson from the
      // project-pool fix).
      .andWhere(
        'NOT EXISTS (SELECT 1 FROM revised_equipment_project_groups child ' +
          '  WHERE child.prev_project_id = "relpg".id ' +
          "    AND child.prev_project_type = 'revised_equipment' " +
          '    AND child.deleted_at IS NULL)',
      )
      .orderBy('relpg.createdAt', 'DESC')
      .getMany();

    await this.maskCreatedByUserOnRelpg(items);
    this.projectLatestStatusOnRelpg(items);

    // They are leaves by construction — decorate `hasDescendant=false` so the
    // FE `!hasDescendant` safety filter is a no-op.
    items.forEach((i) => {
      (i as unknown as { hasDescendant: boolean }).hasDescendant = false;
    });

    return { items };
  }

  /**
   * §7.10 — owner-scoped per-status counts for FE-03 sidebar badges.
   *
   * LAO / non-agency callers receive the all-zero envelope at HTTP 200
   * (NOT 403) — equipment is agency-only by construction so LAO RELPG
   * counts are vacuous. Mirrors `EquipmentProjectGroupService.getCountsByStatus`.
   */
  async getCountsByStatus(
    userId: string,
    developmentPlanRevisionId?: string,
  ): Promise<RevisedEquipmentCountsByStatusDto> {
    const workHistory = await this.workHistoryLookup.getCurrent(
      this.relpgRepo.manager,
      userId,
    );
    this.workHistoryLookup.assertWorkStatusApproved(workHistory);

    const zero: RevisedEquipmentCountsByStatusDto = {
      ready: 0,
      pending: 0,
      verified: 0,
      pendingApproval: 0,
      approved: 0,
      pullBack: 0,
      returnedForRevision: 0,
      rejected: 0,
    };

    // §1 / §5.3 — LAO callers get zeros immediately, no DB hit.
    if (!isAgencyWorkHistory(workHistory)) {
      return zero;
    }

    const qb = this.relpgRepo
      .createQueryBuilder('relpg')
      .innerJoin('relpg.createdBy', 'createdBy')
      .innerJoin(
        'relpg.trackingStatus',
        'latestTracking',
        'latestTracking.isLatest = :isLatest',
        { isLatest: true },
      )
      .innerJoin('latestTracking.statusId', 'latestStatus')
      .where('createdBy.id = :workHistoryId', { workHistoryId: workHistory.id })
      .andWhere('relpg.deleted_at IS NULL');

    if (developmentPlanRevisionId) {
      qb.innerJoin('relpg.developmentPlanRevision', 'dpr').andWhere(
        'dpr.id = :dprId',
        { dprId: developmentPlanRevisionId },
      );
    }

    const row = await qb
      .select(
        `COUNT(*) FILTER (WHERE "latestStatus"."name" = '${STATUS_NAMES.READY}')`,
        'ready_count',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE "latestStatus"."name" = '${STATUS_NAMES.PENDING}')`,
        'pending_count',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE "latestStatus"."name" = '${STATUS_NAMES.VERIFIED}')`,
        'verified_count',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE "latestStatus"."name" = '${STATUS_NAMES.PENDING_APPROVAL}')`,
        'pending_approval_count',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE "latestStatus"."name" = '${STATUS_NAMES.APPROVED}')`,
        'approved_count',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE "latestStatus"."name" = '${STATUS_NAMES.PULL_BACK}')`,
        'pull_back_count',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE "latestStatus"."name" = '${STATUS_NAMES.RETURNED_FOR_REVISION}')`,
        'returned_for_revision_count',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE "latestStatus"."name" = '${STATUS_NAMES.REJECTED}')`,
        'rejected_count',
      )
      .getRawOne<Record<string, string | number | null>>();

    const toInt = (v: string | number | null | undefined): number => {
      if (v === null || v === undefined) return 0;
      const n = typeof v === 'number' ? v : parseInt(v, 10);
      return Number.isFinite(n) ? n : 0;
    };

    return {
      ready: toInt(row?.ready_count),
      pending: toInt(row?.pending_count),
      verified: toInt(row?.verified_count),
      pendingApproval: toInt(row?.pending_approval_count),
      approved: toInt(row?.approved_count),
      pullBack: toInt(row?.pull_back_count),
      returnedForRevision: toInt(row?.returned_for_revision_count),
      rejected: toInt(row?.rejected_count),
    };
  }

  // ====================================================================
  //  STAFF — workflow transitions + rollback (BE-02)
  //
  //  Per §4.1 / §5.3 these are NOT gated by the agency-only authoring rule
  //  and NOT ownership-scoped. Authority is role (staff-lead) + workStatus
  //  + area responsibility (staff only; admin / super-admin bypass) +
  //  current-status transition rules. `assertAgencyWorkHistory` is
  //  DELIBERATELY NOT called here.
  // ====================================================================

  /**
   * §7.3 — Pending → Verified (staff-controlled).
   */
  async verifyByStaff(
    id: string,
    dto: StaffTransitionRevisedEquipmentProjectGroupDto,
    userId: string,
  ): Promise<RevisedEquipmentProjectGroup> {
    return this.staffTransition(id, userId, dto, {
      from: [STATUS_NAMES.PENDING],
      to: STATUS_NAMES.VERIFIED,
    });
  }

  /**
   * §7.3 — Verified → Pending_Approval (staff-controlled).
   */
  async moveToApprovalByStaff(
    id: string,
    dto: StaffTransitionRevisedEquipmentProjectGroupDto,
    userId: string,
  ): Promise<RevisedEquipmentProjectGroup> {
    return this.staffTransition(id, userId, dto, {
      from: [STATUS_NAMES.VERIFIED],
      to: STATUS_NAMES.PENDING_APPROVAL,
    });
  }

  /**
   * §7.3 — Pending_Approval → Approved (staff-controlled).
   */
  async approveByStaff(
    id: string,
    dto: StaffTransitionRevisedEquipmentProjectGroupDto,
    userId: string,
  ): Promise<RevisedEquipmentProjectGroup> {
    return this.staffTransition(id, userId, dto, {
      from: [STATUS_NAMES.PENDING_APPROVAL],
      to: STATUS_NAMES.APPROVED,
    });
  }

  /**
   * §7.3 / Returned_For_Revision Rule — Pending OR Verified →
   * Returned_For_Revision (owner's court). MUST originate ONLY from Pending
   * or Verified; Pending_Approval → 400. Does NOT create a new version
   * (§11) and does NOT modify project structure — the owner edits the
   * existing RELPG and resubmits via the normal workflow.
   */
  async returnForRevisionByStaff(
    id: string,
    dto: StaffTransitionRevisedEquipmentProjectGroupDto,
    userId: string,
  ): Promise<RevisedEquipmentProjectGroup> {
    return this.staffTransition(id, userId, dto, {
      from: [STATUS_NAMES.PENDING, STATUS_NAMES.VERIFIED],
      to: STATUS_NAMES.RETURNED_FOR_REVISION,
    });
  }

  /**
   * Shared staff forward/return transition core. §7.2 validation order:
   *   1-3. Auth → WorkHistory → workStatus=approved
   *   4.   Role MUST be staff-lead (controller RolesGuard is Layer-1; this
   *        is the Layer-2 service re-assertion)
   *   5.   Load target RELPG (not soft-deleted)
   *   6.   §10 scope binding — RELPG's OWN DPR must be the latest, not yet
   *        assembled round (mirrors RPG staff transition: isLatest=true,
   *        isBooked=false; DPR.isOpen is NOT a staff gate)
   *   7.   Area responsibility (staff only; admin / super-admin bypass)
   *   8.   Current latest status must be in the allowed `from` set
   *   9.   §12 audit — demote prior latest, insert the new status row
   */
  private async staffTransition(
    id: string,
    userId: string,
    dto: StaffTransitionRevisedEquipmentProjectGroupDto,
    transition: { from: readonly string[]; to: string },
  ): Promise<RevisedEquipmentProjectGroup> {
    return this.dataSource.transaction(async (manager) => {
      const workHistory = await this.workHistoryLookup.getCurrent(
        manager,
        userId,
      );
      this.workHistoryLookup.assertWorkStatusApproved(workHistory);
      this.assertStaffLead(workHistory);

      const existing = await manager.findOne(RevisedEquipmentProjectGroup, {
        where: { id },
        relations: [
          'developmentPlanRevision',
          'developmentPlanRevision.developmentPlan',
          'responsibleAgency',
        ],
      });
      if (!existing) {
        throw new NotFoundException(`RELPG not found: ${id}`);
      }

      // §10 scope binding — validate against the RELPG's OWN DPR.
      const dpr = existing.developmentPlanRevision;
      if (!dpr) {
        throw new NotFoundException(
          `Parent DevelopmentPlanRevision not found for RELPG ${id}`,
        );
      }
      this.assertRevisionActiveForStaff(dpr);

      // Area responsibility (staff only; admin / super-admin bypass).
      await this.assertStaffAreaResponsibility(manager, workHistory, existing);

      // §12 audit — demote prior latest, insert the new status.
      const currentTracking = await this.assertLatestStatusIn(
        manager,
        id,
        transition.from,
      );
      const nextStatusId = await this.resolveStatusIdByName(
        manager,
        transition.to,
      );
      await manager.update(
        TrackingStatus,
        { id: currentTracking.id },
        { isLatest: false },
      );
      const tracking = manager.create(TrackingStatus, {
        revisedEquipmentProjectGroupId: { id } as RevisedEquipmentProjectGroup,
        statusId: { id: nextStatusId } as Status,
        createdBy: workHistory,
        comment: dto.comment ?? null,
        staffRemark: dto.staffRemark ?? null,
        isLatest: true,
      } as DeepPartial<TrackingStatus>);
      await manager.save(tracking);

      this.logger.log(
        `Staff transition RELPG id=${id} ${transition.from.join('/')} → ${transition.to} by=${workHistory.id} (role=${workHistory.role?.name})`,
      );
      return this.findOneInternal(manager, id);
    });
  }

  /**
   * §7.4 / §14.6 — staff-led rollback for RELPG.
   *
   * Reverts to the previous status and HARD-DELETES the RELPG row as the
   * final transactional step so the parent EPG unlocks automatically under
   * §14 (the `'equipment'` discriminator probe returns false once the only
   * RELPG descendant is gone). Distinct from owner Pull Back: rollback does
   * NOT add a `Pull_Back` row — it removes the latest tracking row and
   * restores the previous to `isLatest = true`.
   *
   * Sequence (single transaction):
   *   1. Role check (staff-lead)
   *   2. Load RELPG, not soft-deleted
   *   3. Staff area-responsibility check (admin / super-admin bypass)
   *   4. Minimum history: ≥1 previous (isLatest=false) tracking row
   *   5. §14 leaf guard: assertEditable(id, 'revised_equipment', em)
   *   6. Current latest status MUST NOT be Pull_Back or Ready
   *   7. Hard-delete current latest, restore previous to latest
   *   8. Hard-delete the RELPG row (final step — unlocks parent EPG)
   *   9. Notifications post-commit (fire-and-forget)
   */
  async rollbackByStaff(
    id: string,
    dto: RollbackRevisedEquipmentProjectGroupDto,
    userId: string,
  ): Promise<{ message: string; status: string }> {
    const result = await this.dataSource.transaction(async (manager) => {
      const workHistory = await this.workHistoryLookup.getCurrent(
        manager,
        userId,
      );
      this.workHistoryLookup.assertWorkStatusApproved(workHistory);
      this.assertStaffLead(workHistory);

      const existing = await manager.findOne(RevisedEquipmentProjectGroup, {
        where: { id },
        relations: [
          'createdBy',
          'developmentPlanRevision',
          'developmentPlanRevision.developmentPlan',
          'responsibleAgency',
        ],
      });
      if (!existing) {
        throw new NotFoundException(`RELPG not found: ${id}`);
      }

      // Area responsibility (staff only; admin / super-admin bypass).
      await this.assertStaffAreaResponsibility(manager, workHistory, existing);

      // §14 leaf guard — a RELPG that itself has a live RELPG descendant
      // cannot be rolled back (would orphan the descendant). MUST run
      // BEFORE the tracking-history cleanup so a non-leaf row never has its
      // tracking rows mutated.
      await this.lineageLockService.assertEditable(
        id,
        'revised_equipment',
        manager,
      );

      // Status constraint — cannot rollback from Pull_Back or Ready.
      const currentTracking = await manager.findOne(TrackingStatus, {
        where: { revisedEquipmentProjectGroupId: { id }, isLatest: true },
        relations: ['statusId'],
      });
      if (!currentTracking) {
        throw new NotFoundException(
          `ไม่พบสถานะปัจจุบันของรายการครุภัณฑ์ (ฉบับแก้ไข) ${id}`,
        );
      }
      const currentStatusName = currentTracking.statusId?.name ?? '';
      if (
        currentStatusName === STATUS_NAMES.PULL_BACK ||
        currentStatusName === STATUS_NAMES.READY
      ) {
        throw new BadRequestException(
          `ไม่สามารถดึงกลับได้จากสถานะ "${currentStatusName}"`,
        );
      }

      // Minimum history — there must be a previous (non-latest) tracking row.
      const previousTracking = await manager.findOne(TrackingStatus, {
        where: { revisedEquipmentProjectGroupId: { id }, isLatest: false },
        relations: ['statusId'],
        order: { createAt: 'DESC' },
      });
      if (!previousTracking?.statusId) {
        throw new BadRequestException(
          'ไม่พบสถานะก่อนหน้า ไม่สามารถย้อนกลับได้',
        );
      }

      // §7.4 step 7 — hard-delete current latest, restore previous to latest
      // (rollback audit exception per §12 / STAFF-LED ROLLBACK RULE). This is
      // the ONLY hard-delete rollback performs.
      await manager.delete(TrackingStatus, { id: currentTracking.id });
      await manager.update(
        TrackingStatus,
        { id: previousTracking.id },
        { isLatest: true },
      );

      // §14.6 (REVISED 2026-06-03) — NATURAL rollback semantics: the RELPG
      // row is KEPT (status revert only), mirroring PG / RPG / SPG. The prior
      // "ghost-descendant hard-delete" of the row was REMOVED because
      // "ย้อนสถานะ" is a workflow status correction, NOT a fork-undo —
      // destroying the whole revision on every rollback was data loss. The
      // leaf-only guard at step 5 still blocks rolling back a non-leaf row;
      // an upstream parent it was forked from correctly STAYS §14-locked
      // because the revision still exists at its reverted status.

      this.logger.log(
        `Staff rollback RELPG id=${id} ${currentStatusName} → ${previousTracking.statusId.name} ` +
          `by=${workHistory.id} (role=${workHistory.role?.name})` +
          (dto.reason ? ` reason="${dto.reason}"` : ''),
      );
      return {
        previousStatusName: previousTracking.statusId.name,
        ownerWorkHistoryId: existing.createdBy?.id ?? null,
      };
    });

    // §7.4 step 9 — notifications post-commit (fire-and-forget). The RELPG
    // module has no notification dependency wired (parity with BE-01 and the
    // EPG rollback path which also emit none); record the post-commit intent
    // for traceability. A failure here MUST NOT undo the committed rollback.
    try {
      this.logger.log(
        `RELPG rollback committed id=${id} → ${result.previousStatusName} ` +
          `(owner WH=${result.ownerWorkHistoryId ?? 'unknown'})`,
      );
    } catch (notifyErr) {
      this.logger.warn(
        `RELPG rollback post-commit notification failed id=${id}: ${String(notifyErr)}`,
      );
    }

    return {
      message: `ย้อนสถานะสำเร็จ (กลับไปเป็น "${result.previousStatusName}")`,
      status: 'success',
    };
  }

  /**
   * §4.1 staff round-reassignment — move a RELPG to a DIFFERENT revision
   * round of the SAME plan, so staff can fix a wrong edit↔change
   * submission. Mirrors the project equivalent
   * (`RevisedProjectGroupService.updateChangeDevelopmentPlanRevision`),
   * which only repoints the `developmentPlanRevision` FK.
   *
   * §10 scope binding — the target DPR MUST belong to the RELPG's OWN plan
   * AND be open (`isOpen = true`) AND not yet assembled
   * (`isBooked = false`). Other plans' rounds, closed rounds, and booked
   * rounds are rejected with `BadRequestException('INVALID_TARGET_REVISION')`.
   *
   * §17.2 — this is workflow data correction, NOT a status transition: it
   * does NOT write a `TrackingStatus` row (parity with the project
   * version, which only updates the FK).
   */
  async changeDevelopmentPlanRevision(
    id: string,
    developmentPlanRevisionId: string,
    userId: string,
  ): Promise<RevisedEquipmentProjectGroup> {
    return this.dataSource.transaction(async (manager) => {
      const workHistory = await this.workHistoryLookup.getCurrent(
        manager,
        userId,
      );
      this.workHistoryLookup.assertWorkStatusApproved(workHistory);
      this.assertStaffLead(workHistory);

      // 1. Load the RELPG (with plan + current revision). 404 if missing.
      const relpg = await manager.findOne(RevisedEquipmentProjectGroup, {
        where: { id },
        relations: ['developmentPlan', 'developmentPlanRevision'],
      });
      if (!relpg) {
        throw new NotFoundException(`RELPG not found: ${id}`);
      }

      // 2. Load the target DPR (with its plan). 404 if missing.
      const targetDpr = await manager.findOne(DevelopmentPlanRevision, {
        where: { id: developmentPlanRevisionId },
        relations: ['developmentPlan'],
      });
      if (!targetDpr) {
        throw new NotFoundException(
          `DevelopmentPlanRevision not found: ${developmentPlanRevisionId}`,
        );
      }

      // 3. §10 — target round MUST be in the SAME plan, OPEN, and un-booked.
      const samePlan =
        targetDpr.developmentPlan?.id === relpg.developmentPlan?.id &&
        !!relpg.developmentPlan?.id;
      if (!samePlan || !targetDpr.isOpen || targetDpr.isBooked) {
        throw new BadRequestException('INVALID_TARGET_REVISION');
      }

      // 4. Repoint the FK only (no status transition — §17.2).
      await manager.update(RevisedEquipmentProjectGroup, id, {
        developmentPlanRevision: { id: developmentPlanRevisionId } as any,
      });

      this.logger.log(
        `Staff reassigned RELPG id=${id} → DPR=${developmentPlanRevisionId} ` +
          `by=${workHistory.id} (role=${workHistory.role?.name})`,
      );

      // 5. Return the updated RELPG (same shape as getRelpg / findOne).
      return this.findOneInternal(manager, id);
    });
  }

  // ====================================================================
  //  STAFF — queue finders (BE-02 §7.5)
  //
  //  Paginated, area-scoped for `staff` role (filter by responsibleAgency
  //  via WorkHistoryGovernmentAgencyResponsibility); admin / super-admin
  //  see all. No `mineOnly` filter — staff see every RELPG in their area.
  // ====================================================================

  async findStaffPending(
    query: ListRevisedEquipmentProjectGroupsQueryDto,
    userId: string,
  ) {
    return this.findStaffQueue(STATUS_NAMES.PENDING, query, userId);
  }

  async findStaffVerified(
    query: ListRevisedEquipmentProjectGroupsQueryDto,
    userId: string,
  ) {
    return this.findStaffQueue(STATUS_NAMES.VERIFIED, query, userId);
  }

  async findStaffPendingApproval(
    query: ListRevisedEquipmentProjectGroupsQueryDto,
    userId: string,
  ) {
    return this.findStaffQueue(STATUS_NAMES.PENDING_APPROVAL, query, userId);
  }

  async findStaffApproved(
    query: ListRevisedEquipmentProjectGroupsQueryDto,
    userId: string,
  ) {
    return this.findStaffQueue(STATUS_NAMES.APPROVED, query, userId);
  }

  async findStaffReturned(
    query: ListRevisedEquipmentProjectGroupsQueryDto,
    userId: string,
  ) {
    return this.findStaffQueue(
      STATUS_NAMES.RETURNED_FOR_REVISION,
      query,
      userId,
    );
  }

  /**
   * Shared staff-queue core. Role-gated at the controller (staff-lead) and
   * re-asserted here. For `staff` role the result set is filtered to the
   * agencies the requester is responsible for
   * (`WorkHistoryGovernmentAgencyResponsibility`); admin / super-admin see
   * all. A staff caller responsible for NO agency sees an empty page.
   */
  private async findStaffQueue(
    statusName: string,
    query: ListRevisedEquipmentProjectGroupsQueryDto,
    userId: string,
  ): Promise<{
    items: RevisedEquipmentProjectGroup[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const workHistory = await this.workHistoryLookup.getCurrent(
      this.relpgRepo.manager,
      userId,
    );
    this.workHistoryLookup.assertWorkStatusApproved(workHistory);
    this.assertStaffLead(workHistory);

    const qb = this.relpgRepo
      .createQueryBuilder('relpg')
      .leftJoinAndSelect('relpg.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'createdByAmphoe')
      .leftJoinAndSelect(
        'createdBy.localAdministrativeOrganization',
        'createdByLao',
      )
      .leftJoinAndSelect('relpg.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect(
        'relpg.developmentPlanRevision',
        'developmentPlanRevision',
      )
      .leftJoinAndSelect('relpg.equipmentProjectGroup', 'equipmentProjectGroup')
      .leftJoinAndSelect('relpg.strategy', 'strategy')
      .leftJoinAndSelect('relpg.tactic', 'tactic')
      .leftJoinAndSelect('relpg.plan', 'plan')
      .leftJoinAndSelect('relpg.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('relpg.equipmentCategory', 'equipmentCategory')
      .leftJoinAndSelect('relpg.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('relpg.amphoe', 'amphoe')
      .leftJoinAndSelect('relpg.localAdministrativeOrganization', 'lao')
      .leftJoinAndSelect('relpg.budgets', 'budgets')
      .leftJoinAndSelect('relpg.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .where('relpg.deletedAt IS NULL')
      // Status filter via the LATEST tracking row.
      .andWhere(
        'EXISTS (SELECT 1 FROM tracking_status ts ' +
          ' INNER JOIN status s ON s.id = ts.status_id ' +
          ' WHERE ts.revised_equipment_project_group_id = relpg.id ' +
          '   AND ts.is_latest = true ' +
          '   AND s.name = :statusName)',
        { statusName },
      )
      // เข้าเล่มแล้ว (round booked) → RELPG ออกจากคิวรีวิวของ staff เหมือนฝั่ง
      // โครงการ (revised-project-group ใช้ `dpr.isBooked = false` ทุกคิว). พอ
      // เล่มถูก finalize/booked รายการไม่ควรค้างในหน้า ready-to-approved อีก.
      .andWhere('developmentPlanRevision.isBooked = :dprNotBooked', {
        dprNotBooked: false,
      });

    // §10 scope binding — optional DPR / plan narrowing.
    if (query.developmentPlanRevisionId) {
      qb.andWhere('developmentPlanRevision.id = :dprId', {
        dprId: query.developmentPlanRevisionId,
      });
    }
    if (query.developmentPlanId) {
      qb.andWhere('developmentPlan.id = :planId', {
        planId: query.developmentPlanId,
      });
    }

    // §10 — revision-type scope. Edit vs change RELPGs share a plan; a
    // ready-to-approved page whose round is not currently open passes only
    // the plan id (no DPR id). Without this, the queue would surface the
    // OTHER book type's rows (e.g. an edit-round RELPG appearing on the
    // change page). `revisionType` is joined for filtering only.
    if (query.revisionType) {
      qb.leftJoin(
        'developmentPlanRevision.revisionType',
        'revisionType',
      ).andWhere('revisionType.name = :revType', {
        revType: query.revisionType,
      });
    }

    // Area responsibility for `staff` role — filter to responsible agencies.
    // Admin / super-admin see all.
    if (workHistory.role?.name === 'staff') {
      const responsibleAgencyIds = await this.getStaffResponsibleAgencyIds(
        this.relpgRepo.manager,
        workHistory.id,
      );
      if (responsibleAgencyIds.length === 0) {
        // Responsible for no agency → sees nothing (fail closed).
        return { items: [], total: 0, page, limit };
      }
      qb.andWhere('responsibleAgency.id IN (:...responsibleAgencyIds)', {
        responsibleAgencyIds,
      });
    }

    qb.orderBy('relpg.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();
    await this.maskCreatedByUserOnRelpg(items);
    this.projectLatestStatusOnRelpg(items);
    return { items, total, page, limit };
  }

  // ====================================================================
  //  Private helpers
  // ====================================================================

  /**
   * Staff-Lead gate (§4.1) — `role IN ('staff', 'admin', 'super-admin')`.
   * Layer-1 is the controller's `RolesGuard`; this is the Layer-2 service
   * re-assertion. Deliberately distinct from `assertAgencyWorkHistory`,
   * which MUST NOT be called for staff transitions (§5.3).
   */
  private assertStaffLead(workHistory: WorkHistory): void {
    const role = workHistory.role?.name;
    if (role !== 'staff' && role !== 'admin' && role !== 'super-admin') {
      throw new ForbiddenException(
        'เฉพาะเจ้าหน้าที่ (staff/admin/super-admin) เท่านั้นที่สามารถดำเนินการนี้ได้',
      );
    }
  }

  /**
   * §10 — staff transitions / rollback validate against the RELPG's OWN
   * DPR. Mirrors the RPG staff-transition gate: the DPR must be the latest
   * round and not yet assembled (`isLatest = true`, `isBooked = false`).
   * `isOpen` is NOT a staff gate (an admin may close a round while review
   * is in progress) — parity with the RPG/SPG staff path.
   */
  private assertRevisionActiveForStaff(dpr: DevelopmentPlanRevision): void {
    if (!dpr.isLatest) {
      throw new BadRequestException(
        'รอบการแก้ไข/เปลี่ยนแปลงนี้ไม่ใช่รอบปัจจุบัน ไม่สามารถดำเนินการได้',
      );
    }
    if (dpr.isBooked) {
      throw new BadRequestException(
        'รอบการแก้ไข/เปลี่ยนแปลงถูกรวมเล่มแล้ว ไม่สามารถดำเนินการได้',
      );
    }
  }

  /**
   * Staff area-responsibility check (§3 / STAFF-LED ROLLBACK RULE).
   *
   * For `staff` role the requester MUST be responsible for the RELPG's
   * `responsibleAgency` (via `WorkHistoryGovernmentAgencyResponsibility`).
   * `admin` / `super-admin` bypass. RELPG is agency-origin by construction
   * (§5.1 auto-assign), so `responsibleAgency` should always be set — if it
   * is null the check FAILS CLOSED (deny, log warning); never bypass.
   */
  private async assertStaffAreaResponsibility(
    manager: EntityManager,
    workHistory: WorkHistory,
    relpg: RevisedEquipmentProjectGroup,
  ): Promise<void> {
    if (workHistory.role?.name !== 'staff') {
      return; // admin / super-admin bypass
    }
    const agencyId = relpg.responsibleAgency?.id;
    if (!agencyId) {
      this.logger.warn(
        `RELPG ${relpg.id} has null responsibleAgency — staff area check failing closed for WH=${workHistory.id}`,
      );
      throw new BadRequestException(
        'รายการครุภัณฑ์ (ฉบับแก้ไข) นี้ยังไม่มีหน่วยงานรับผิดชอบ ไม่สามารถตรวจสอบสิทธิ์ได้',
      );
    }
    const hasResponsibility = await manager.findOne(
      WorkHistoryGovernmentAgencyResponsibility,
      {
        where: {
          workHistory: { id: workHistory.id },
          governmentAgency: { id: agencyId },
        },
      },
    );
    if (!hasResponsibility) {
      throw new ForbiddenException(
        'คุณไม่มีสิทธิ์ดำเนินการกับรายการนี้ (ไม่ได้รับผิดชอบหน่วยงานของรายการ)',
      );
    }
  }

  /**
   * Resolve the set of GovernmentAgency ids the staff requester is
   * responsible for (used by the queue finders for the area filter).
   */
  private async getStaffResponsibleAgencyIds(
    manager: EntityManager,
    workHistoryId: string,
  ): Promise<string[]> {
    const rows = await manager.find(WorkHistoryGovernmentAgencyResponsibility, {
      where: { workHistory: { id: workHistoryId } },
      relations: ['governmentAgency'],
    });
    return rows
      .map((r) => r.governmentAgency?.id)
      .filter((v): v is string => !!v);
  }

  /**
   * §1 / §5.3 agency-only gate — Layer-2 (defense-in-depth). Layer-1 is
   * the controller's `AgencyOnlyGuard`. Mirrors
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
   * §4 ownership — compares `relpg.createdBy.id` against `workHistory.id`,
   * NEVER raw `userId`.
   */
  private assertOwnership(
    relpg: RevisedEquipmentProjectGroup,
    workHistory: WorkHistory,
  ): void {
    if (relpg.createdBy?.id !== workHistory.id) {
      throw new ForbiddenException(
        'คุณไม่มีสิทธิ์ดำเนินการกับรายการครุภัณฑ์ (ฉบับแก้ไข) นี้',
      );
    }
  }

  /**
   * §7.2 step 2 — the source EPG must have its latest TrackingStatus =
   * Approved before it can be forked into a revision.
   */
  private async assertEpgApproved(
    manager: EntityManager,
    epgId: string,
  ): Promise<void> {
    const latest = await manager.findOne(TrackingStatus, {
      where: { equipmentProjectGroupId: { id: epgId }, isLatest: true },
      relations: ['statusId'],
    });
    if (!latest || latest.statusId?.name !== STATUS_NAMES.APPROVED) {
      throw new BadRequestException(
        'รายการครุภัณฑ์ต้นฉบับต้องมีสถานะ Approved เท่านั้นจึงจะสามารถยื่นขอแก้ไขหรือเปลี่ยนแปลงได้',
      );
    }
  }

  /**
   * RELPG-source variant of `assertEpgApproved` — the source RELPG tip must be
   * Approved before it can be forked again (§11 equipment-revision; the
   * RELPG→RELPG chain reuses the same versioning rule as EPG→RELPG).
   */
  private async assertRelpgApproved(
    manager: EntityManager,
    relpgId: string,
  ): Promise<void> {
    const latest = await manager.findOne(TrackingStatus, {
      where: { revisedEquipmentProjectGroupId: { id: relpgId }, isLatest: true },
      relations: ['statusId'],
    });
    if (!latest || latest.statusId?.name !== STATUS_NAMES.APPROVED) {
      throw new BadRequestException(
        'รายการครุภัณฑ์ต้นฉบับต้องมีสถานะ Approved เท่านั้นจึงจะสามารถยื่นขอแก้ไขหรือเปลี่ยนแปลงได้',
      );
    }
  }

  /**
   * §9 / §10 — load the DPR and assert `isOpen = true`. Scope is bound to
   * the supplied DPR, never a global latest lookup.
   */
  private async loadOpenRevision(
    manager: EntityManager,
    revisionId: string,
  ): Promise<DevelopmentPlanRevision> {
    const dpr = await manager.findOne(DevelopmentPlanRevision, {
      where: { id: revisionId },
      relations: ['developmentPlan', 'revisionType'],
    });
    if (!dpr) {
      throw new NotFoundException(
        `DevelopmentPlanRevision not found: ${revisionId}`,
      );
    }
    this.assertRevisionOpen(dpr);
    return dpr;
  }

  private assertRevisionOpen(dpr: DevelopmentPlanRevision): void {
    if (!dpr.isOpen) {
      throw new BadRequestException(
        'รอบการแก้ไข/เปลี่ยนแปลงนี้ยังไม่เปิด หรือปิดแล้ว ไม่สามารถดำเนินการได้',
      );
    }
  }

  /**
   * §12 — assert the RELPG's latest TrackingStatus is one of the allowed
   * statuses; returns the current latest row so callers can demote it.
   */
  private async assertLatestStatusIn(
    manager: EntityManager,
    id: string,
    allowed: readonly string[],
  ): Promise<TrackingStatus> {
    const latest = await manager.findOne(TrackingStatus, {
      where: { revisedEquipmentProjectGroupId: { id }, isLatest: true },
      relations: ['statusId'],
    });
    if (!latest) {
      throw new ConflictException(
        `ไม่พบสถานะปัจจุบันของรายการครุภัณฑ์ (ฉบับแก้ไข) ${id}`,
      );
    }
    const name = latest.statusId?.name ?? '';
    if (!allowed.includes(name)) {
      throw new BadRequestException(
        `ไม่สามารถดำเนินการได้จากสถานะปัจจุบัน (${name}) — อนุญาตเฉพาะ: ${allowed.join(', ')}`,
      );
    }
    return latest;
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
   * §16.5 STRATEGY_BASED — assert the `(tactic, plan, equipmentCategory)`
   * triple exists in `equipment_category_scopes`.
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
   * §16.5 ISSUE_BASED — load the issue and assert it belongs to the parent
   * plan.
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
    existing: RevisedEquipmentProjectGroup,
    dto: UpdateRevisedEquipmentProjectGroupDto,
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
      return RevisedEquipmentProjectGroupService.READY_STATUS_ID;
    }
    return this.resolveStatusIdByName(manager, STATUS_NAMES.PENDING);
  }

  private async resolveStatusIdByName(
    manager: EntityManager,
    name: string,
  ): Promise<string> {
    const status = await manager.findOne(Status, { where: { name } });
    if (!status) {
      throw new NotFoundException(
        `ไม่พบสถานะ "${name}" ในระบบ ข้อมูลสถานะอาจไม่สมบูรณ์`,
      );
    }
    return status.id;
  }

  private async assertBudgetYears(
    items: Array<{ year: number }>,
    plan: { startYear: number; endYear: number },
  ): Promise<void> {
    for (const b of items) {
      if (b.year < plan.startYear || b.year > plan.endYear) {
        throw new BadRequestException(
          `ปีงบประมาณต้องอยู่ในช่วง พ.ศ. ${plan.startYear} - ${plan.endYear} (ปีที่ส่งมา: ${b.year})`,
        );
      }
    }
  }

  /**
   * §17.4 — fire a `no-ai-baseline` snapshot for the RELPG. Forwards the
   * outer `EntityManager` so the owner lookup inside
   * `PreSubmitSnapshotService` sees the row inserted in this transaction
   * (READ COMMITTED isolation). The snapshot write itself opens its own
   * inner transaction; any throw propagates and rolls back the caller.
   */
  private async fireBaselineSnapshot(
    manager: EntityManager,
    userId: string,
    relpg: RevisedEquipmentProjectGroup,
    format: ReportFormat,
    classification: {
      strategy: Strategy | null | undefined;
      tactic: Tactic | null | undefined;
      plan: Plan | null | undefined;
      developmentIssue: DevelopmentIssue | null | undefined;
    },
    workHistory: WorkHistory,
    budget?: Array<{ year: number; quantity: number }>,
  ): Promise<void> {
    await this.preSubmitSnapshotService.createSnapshot(
      userId,
      {
        targetKind: 'revised-equipment-project-group',
        targetId: relpg.id,
        // RELPG is a revision-context artifact; 'revision' is the closest
        // existing workflow discriminator on the snapshot DTO.
        workflow: 'revision',
        result: null,
        project: {
          title: relpg.equipmentName ?? null,
          goal: relpg.targetOutput ?? null,
          expected: relpg.expectedResults ?? null,
          // Equipment relaxes the indicator (§16.5); omit on the hash.
          indicator: null,
          startLat: null,
          startLng: null,
          endLat: null,
          endLng: null,
          amphoeId: workHistory.amphoe?.id ?? null,
          localOrganizationId:
            workHistory.localAdministrativeOrganization?.id ?? null,
          budgets: Array.isArray(budget)
            ? budget.map((b) => ({ year: b.year, quantity: b.quantity ?? 0 }))
            : [],
          equipmentCategoryId: relpg.equipmentCategory?.id ?? null,
        },
        classification: {
          reportFormat:
            format === ReportFormat.ISSUE_BASED
              ? 'ISSUE_BASED'
              : 'STRATEGY_BASED',
          strategyName: classification.strategy?.name ?? null,
          tacticName: classification.tactic?.name ?? null,
          planName: classification.plan?.name ?? null,
          developmentIssueName: classification.developmentIssue?.name ?? null,
        },
        attachments: [],
      },
      manager,
    );
  }

  // ====================================================================
  //  VERSION CHAIN ("ประวัติการแก้ไข") — read-only (§17.2)
  // ====================================================================

  /**
   * Equipment-revision lineage chain — the ผ.03 analog of
   * `RevisedProjectGroupService.findAllVersions`.
   *
   * The requested `id` may be EITHER an `EquipmentProjectGroup` (EPG, the
   * lineage root per §14) OR a `RevisedEquipmentProjectGroup` (RELPG). We
   * resolve the EPG root, then walk the `(prevProjectId, prevProjectType)`
   * lineage forward to collect every live RELPG descendant.
   *
   * Lineage edges (§14, Phase 3):
   *   - `prev_project_type = 'equipment'`         → parent is the EPG root
   *   - `prev_project_type = 'revised_equipment'` → parent is another RELPG
   *
   * Read-only — NO writes, NO TrackingStatus, NO status changes. Reads are
   * unrestricted per §5.3 (NO agency-only gate); we still require an
   * `approved` workStatus + an allowed role, mirroring the project method.
   *
   * Return envelope is byte-for-shape identical to the project method so the
   * FE can reuse the same component:
   *   `{ original, current, currentId, revisions: [root, ...oldest→newest] }`
   */
  async findAllVersions(id: string, userId: string): Promise<any> {
    const manager = this.relpgRepo.manager;

    // 1-3. Auth → WorkHistory → workStatus=approved → allowed role.
    const workHistory = await manager.findOne(WorkHistory, {
      where: { user: { id: userId }, isCurrent: true },
      relations: ['workStatus', 'role'],
    });
    if (!workHistory) {
      throw new UnauthorizedException('User not found');
    }
    if (workHistory.workStatus?.name !== 'approved') {
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');
    }
    const allowedRoles = ['user', 'staff', 'admin', 'super-admin', 'c-level'];
    if (!allowedRoles.includes(workHistory.role?.name)) {
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');
    }

    // 4. Resolve the requested row — try EPG (root) first, then RELPG.
    const epgRelations = [
      'createdBy',
      'createdBy.user',
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
      'trackingStatus.comments',
      'trackingStatus.createdBy',
      'trackingStatus.createdBy.user',
    ];
    const relpgRelations = [
      'createdBy',
      'createdBy.user',
      'developmentPlan',
      'developmentPlanRevision',
      'developmentPlanRevision.revisionType',
      'developmentPlanRevision.developmentPlan',
      'equipmentProjectGroup',
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
    ];

    let epgRoot = await manager.findOne(EquipmentProjectGroup, {
      where: { id },
      relations: epgRelations,
    });

    let requestedRelpg: RevisedEquipmentProjectGroup | null = null;
    const requestedIsRoot = !!epgRoot;

    if (!epgRoot) {
      // The requested id is a RELPG — walk BACKWARD to find the EPG root.
      requestedRelpg = await manager.findOne(RevisedEquipmentProjectGroup, {
        where: { id },
        relations: relpgRelations,
      });
      if (!requestedRelpg) {
        throw new NotFoundException('ไม่พบโครงการ');
      }

      let cursor: RevisedEquipmentProjectGroup | null = requestedRelpg;
      const guard = new Set<string>(); // cycle guard
      while (
        cursor &&
        cursor.prevProjectType === PrevEquipmentProjectType.REVISED_EQUIPMENT &&
        cursor.prevProjectId
      ) {
        if (guard.has(cursor.prevProjectId)) break;
        guard.add(cursor.prevProjectId);
        const parent: RevisedEquipmentProjectGroup | null =
          await manager.findOne(RevisedEquipmentProjectGroup, {
            where: { id: cursor.prevProjectId },
            relations: relpgRelations,
          });
        if (!parent) break;
        cursor = parent;
      }

      // `cursor` is now the first-fork RELPG (prevProjectType='equipment').
      const rootEpgId =
        cursor?.prevProjectType === PrevEquipmentProjectType.EQUIPMENT
          ? cursor.prevProjectId
          : cursor?.equipmentProjectGroup?.id ?? null;

      if (rootEpgId) {
        epgRoot = await manager.findOne(EquipmentProjectGroup, {
          where: { id: rootEpgId },
          relations: epgRelations,
        });
      }
      if (!epgRoot) {
        throw new NotFoundException('ไม่พบโครงการต้นฉบับของรายการแก้ไขนี้');
      }
    }

    // 5. Walk FORWARD from the EPG root, collecting live RELPG descendants
    //    in oldest→newest order. Lineage is linear in practice; if multiple
    //    live children exist at a node, pick the earliest by createdAt and
    //    stop (DAG-tolerant per §14.1 — do NOT crash).
    const chainRelpgs: RevisedEquipmentProjectGroup[] = [];
    const visited = new Set<string>();
    let parentId: string = epgRoot.id;
    let parentType: PrevEquipmentProjectType = PrevEquipmentProjectType.EQUIPMENT;

    // Loop: find the earliest live child whose (prevProjectId, prevProjectType)
    // points at the current node.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const children = await manager.find(RevisedEquipmentProjectGroup, {
        where: {
          prevProjectId: parentId,
          prevProjectType: parentType,
        },
        relations: relpgRelations,
        order: { createdAt: 'ASC' },
      });
      // `find` already excludes soft-deleted rows (DeleteDateColumn).
      const next = children[0];
      if (!next || visited.has(next.id)) break;
      visited.add(next.id);
      chainRelpgs.push(next);
      parentId = next.id;
      parentType = PrevEquipmentProjectType.REVISED_EQUIPMENT;
    }

    // 6. PII mask every node BEFORE returning (§ W100 parity).
    await this.maskCreatedByUserOnRelpg(chainRelpgs);
    await this.maskCreatedByUserOnRelpg([epgRoot as any]);
    this.projectLatestStatusOnRelpg(chainRelpgs);
    this.projectLatestStatusOnRelpg([epgRoot as any]);

    // 7. Resolve `current` — either the EPG root or the requested RELPG.
    let current: any;
    if (requestedIsRoot) {
      current = epgRoot;
    } else {
      current = chainRelpgs.find((r) => r.id === id) ?? requestedRelpg;
    }

    // 8. Ordered chain: [EPG root, ...RELPGs oldest→newest].
    const revisions = [epgRoot, ...chainRelpgs];

    return {
      original: epgRoot,
      current,
      currentId: id,
      revisions,
    };
  }

  private async findOneInternal(
    manager: EntityManager,
    id: string,
  ): Promise<RevisedEquipmentProjectGroup> {
    const row = await manager.findOne(RevisedEquipmentProjectGroup, {
      where: { id },
      relations: [
        'createdBy',
        'createdBy.user',
        'developmentPlan',
        'developmentPlanRevision',
        'equipmentProjectGroup',
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
        'trackingStatus.createdBy.amphoe',
        'trackingStatus.createdBy.localAdministrativeOrganization',
      ],
    });
    if (!row) {
      throw new NotFoundException(`RELPG not found: ${id}`);
    }
    await this.maskCreatedByUserOnRelpg([row]);
    this.projectLatestStatusOnRelpg([row]);
    return row;
  }

  /**
   * Project the latest `TrackingStatus` row onto each RELPG as
   * `latestStatus` — the shape the FE list/detail DTOs consume for the
   * status chip (`latestStatus.status.th_name`, W67 source of truth) AND
   * the owner action gating (canSubmit / canPullBack read `latestStatus`).
   *
   * The list/detail queries already eager-load `trackingStatus` +
   * `trackingStatus.statusId`, so this is a pure in-memory fold with NO
   * extra query. Without it, every RELPG row returns `latestStatus =
   * undefined` and the FE renders a blank status + disables all actions.
   * Mirrors the project RPG verify surface, which derives status from the
   * latest tracking row (CLAUDE.md §12).
   */
  private projectLatestStatusOnRelpg(
    items: RevisedEquipmentProjectGroup[],
  ): void {
    for (const item of items) {
      const tracking = (
        item as unknown as {
          trackingStatus?: Array<{
            id?: string;
            isLatest?: boolean;
            comment?: string | null;
            staffRemark?: string | null;
            createAt?: Date | string | null;
            statusId?: {
              id?: string;
              name?: string;
              th_name?: string;
            } | null;
            createdBy?: {
              id?: string;
              createdAt?: Date | string | null;
              user?: {
                id?: string;
                firstname?: string;
                lastname?: string;
                email?: string;
                phone?: string;
                role?: string;
                profileImageUrl?: string;
              } | null;
              amphoe?: { id?: number | string; name?: string } | null;
              localAdministrativeOrganization?: {
                id?: string;
                name?: string;
              } | null;
            } | null;
          }>;
        }
      ).trackingStatus;
      const latest = Array.isArray(tracking)
        ? (tracking.find((t) => t?.isLatest) ?? null)
        : null;
      const status = latest?.statusId ?? null;
      const cb = latest?.createdBy ?? null;
      (item as unknown as { latestStatus: unknown }).latestStatus = latest
        ? {
            id: latest.id,
            isLatest: latest.isLatest,
            comment: latest.comment ?? null,
            staffRemark: latest.staffRemark ?? null,
            createdAt: latest.createAt ?? null,
            status: status
              ? { id: status.id, name: status.name, th_name: status.th_name }
              : null,
            createdBy: cb
              ? {
                  id: cb.id,
                  createdAt: cb.createdAt ?? null,
                  user: cb.user
                    ? {
                        id: cb.user.id,
                        firstname: cb.user.firstname,
                        lastname: cb.user.lastname,
                        email: cb.user.email,
                        phone: cb.user.phone,
                        role: cb.user.role,
                        profileImageUrl: cb.user.profileImageUrl,
                      }
                    : null,
                  amphoe: cb.amphoe
                    ? { id: cb.amphoe.id, name: cb.amphoe.name }
                    : null,
                  localAdministrativeOrganization:
                    cb.localAdministrativeOrganization
                      ? {
                          id: cb.localAdministrativeOrganization.id,
                          name: cb.localAdministrativeOrganization.name,
                        }
                      : null,
                }
              : null,
          }
        : null;
    }
  }

  /**
   * W100 parity — decrypt then mask `createdBy.user` + tracking-comment
   * author PII on every RELPG read surface. Display name preserved; only
   * email / phone / citizenId masked. Idempotent + dedup by User identity.
   * Mirrors `EquipmentProjectGroupService.maskCreatedByUserOnEquipment`.
   */
  private async maskCreatedByUserOnRelpg(
    items: RevisedEquipmentProjectGroup[],
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
}
