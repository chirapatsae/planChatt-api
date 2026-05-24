import {
  Injectable,
  NotFoundException,
  Logger,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  Repository,
  Not,
  SelectQueryBuilder,
} from 'typeorm';
import { CreateSupplementProjectGroupDto } from './dto/create-supplement-project-group.dto';
import { UpdateSupplementProjectGroupDto } from './dto/update-supplement-project-group.dto';
import { SupplementProjectGroup } from './entities/supplement-project-group.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Budget } from 'src/budget/entities/budget.entity';
import { handleException } from 'src/util/handleException';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { Status } from 'src/status/entities/status.entity';
import { ProjectClassificationValidator } from 'src/common/project-classification/project-classification.validator';
import { BookFormatResolver } from 'src/common/project-classification/book-format.resolver';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';
import { ReportFormat } from 'src/development-plan/types/report-format.enum';
import {
  ERROR_CODES,
  ERROR_MESSAGES,
} from 'src/common/project-classification/constants';
import { UsersService } from 'src/users/users.service';
import { maskCreatedByUserOnProjects } from 'src/utils/mask-project-creator.util';
import { WorkHistoryLookupService } from 'src/work-history/work-history-lookup.service';
import { BookLockService } from 'src/common/book-lock/book-lock.service';
import { LineageLockService } from 'src/common/lineage-lock/lineage-lock.service';
import { getAgencyData as sharedGetAgencyData } from 'src/project-groups/util/agency-data.util';
import { assertWizardCompleteness as sharedAssertWizardCompleteness } from 'src/project-groups/util/wizard-completeness.util';
import { SupplementScopeService } from 'src/common/supplement-scope/supplement-scope.service';

/**
 * SUPP-1 BE-01 — SupplementProjectGroupService refactor.
 *
 * NOTE (SUPP-IA-03, 2026-05-12, rev2): SPG re-introduces `Ready` as the
 * entry state, mirroring main-plan PG. `[create POST] → Ready`; the
 * owner explicitly advances `Ready → Pending` via the shared
 * `tracking-status` endpoint. The SUPP-1 cleanup of the `isDraft = true`
 * true-draft path is PRESERVED — `Ready` is a workflow-grade
 * pre-submission state, NOT a draft, and `isDraft` on the entity is a
 * legacy column permanently `false` for every SPG row. The §17.4
 * `no-ai-baseline` write moves with the authoring-time submit and now
 * fires on `Ready → Pending` inside `TrackingStatusService`, not here.
 *
 * Brings SPG to parity with `ProjectGroupsService` (workflow-grade
 * guarantees, minus the draft semantics):
 *   - Resolves Status by canonical name (no hard-coded UUIDs, CLAUDE.md §12 / W67).
 *   - Q1 + Q2 agency-only gate at every write entry point
 *     (LAO callers → 403 `LAO_NOT_ALLOWED_ON_SUPPLEMENT`).
 *   - Scope binding for parent `DevelopmentPlan` + `DevelopmentPlanSupplement`
 *     (`isLatest`, `isOpen`, `isBooked`, `deletedAt`) per workflow §6.
 *   - `responsibleAgency` is NEVER accepted from the client (§5.1, §7.1).
 *   - §15 BookLockService + §14 LineageLockService guards on mutation paths
 *     (§14 is a NO-OP in SUPP-1 — descendants land in SUPP-4).
 *   - Editable / soft-delete allowlist: {Ready, Pull_Back, Returned_For_Revision}
 *     per workflow §10 rev2 (`assertEditableStatus`).
 *   - §17.4 `no-ai-baseline` snapshot moved to `Ready → Pending`
 *     authoring-time submit (in `TrackingStatusService`).
 *   - Every transition writes a `TrackingStatus` audit row (§12).
 */
@Injectable()
export class SupplementProjectGroupService {
  private readonly logger = new Logger(SupplementProjectGroupService.name);

  constructor(
    @InjectRepository(SupplementProjectGroup)
    private readonly supplementProjectGroupRepo: Repository<SupplementProjectGroup>,

    @InjectRepository(DevelopmentPlanSupplement)
    private readonly developmentPlanSupplementRepo: Repository<DevelopmentPlanSupplement>,

    @InjectRepository(DevelopmentPlan)
    private readonly developmentPlanRepo: Repository<DevelopmentPlan>,

    @InjectRepository(Strategy)
    private readonly strategyRepo: Repository<Strategy>,

    @InjectRepository(Tactic)
    private readonly tacticRepo: Repository<Tactic>,

    @InjectRepository(Plan)
    private readonly planRepo: Repository<Plan>,

    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,

    @InjectRepository(Budget)
    private readonly budgetRepo: Repository<Budget>,

    private readonly dataSource: DataSource,
    private readonly classificationValidator: ProjectClassificationValidator,
    private readonly bookFormatResolver: BookFormatResolver,
    private readonly usersService: UsersService,
    private readonly workHistoryLookup: WorkHistoryLookupService,
    private readonly bookLockService: BookLockService,
    private readonly lineageLockService: LineageLockService,
    // SUPP-IA-03 (BE-α, 2026-05-12): `PreSubmitSnapshotService` injection
    // removed — baseline snapshot is now fired by
    // `TrackingStatusService.createBySupplementProjectGroup` at Ready →
    // Pending, not at create-time.
    private readonly supplementScopeService: SupplementScopeService,
  ) {}

  /**
   * W100 PR2 — thin wrapper around the shared
   * `maskCreatedByUserOnProjects` utility (Pattern 3 — decrypt-then-mask).
   */
  private async maskCreatedByUser(items: any): Promise<void> {
    await maskCreatedByUserOnProjects(this.usersService, items);
  }

  // ============================================================
  // PUBLIC — workflow-grade write paths
  // ============================================================

  /**
   * Create-path. Writes a `Ready` TrackingStatus row and returns the
   * saved SPG. Owner explicitly advances Ready → Pending afterwards via
   * the shared tracking-status endpoint (mirrors main-plan PG).
   *
   * SUPP-IA-03 (BE-α, 2026-05-12): the §17.4 baseline snapshot is NO
   * LONGER fired here — it is fired by
   * `TrackingStatusService.createBySupplementProjectGroup` on the
   * authoring-time submit (Ready → Pending). See workflow doc §10/§15.
   */
  async create(
    dto: CreateSupplementProjectGroupDto,
    userId: string,
  ): Promise<SupplementProjectGroup> {
    try {
      // Reject client-supplied responsibleAgency BEFORE the transaction.
      // §5.1 / §7.1: SPG is agency-origin → responsibleAgency is derived
      // from the creator's WorkHistory, never from the request body.
      this.assertNoClientResponsibleAgency(dto);

      const savedId = await this.dataSource.transaction(async (manager) => {
        // 1-3. WorkHistory + workStatus
        const workHistory = await this.getWorkHistory(manager, userId);
        this.assertWorkStatusApproved(workHistory);

        // 4. Q1+Q2 agency-classification gate (workflow §4.2).
        this.supplementScopeService.assertSupplementOwnerScope(workHistory);

        // 5. Wizard completeness (publish floor).
        sharedAssertWizardCompleteness({
          title: dto.title,
          objective: dto.objective ?? null,
          goal: dto.goal ?? null,
          startLat: dto.startLat ?? null,
          startLng: dto.startLng ?? null,
          expected: dto.expected ?? null,
          strategyId: dto.strategyId ?? null,
          tacticId: dto.tacticId ?? null,
          planId: dto.planId ?? null,
          developmentIssueId: dto.developmentIssueId ?? null,
          budget: dto.budget,
        });

        await this.ensureNoDuplicateTitle(
          manager,
          dto.title,
          workHistory.id,
          undefined,
        );

        // 6. §16.5 classification shape (resolved from the supplement chain).
        const format = await this.bookFormatResolver.resolveBySupplement(
          dto.developmentPlanSupplementId,
          manager,
        );
        this.classificationValidator.validate(format, {
          strategyId: dto.strategyId,
          tacticId: dto.tacticId,
          planId: dto.planId,
          developmentIssueId: dto.developmentIssueId,
          indicator: dto.indicator,
        });

        // 7. Validate FK + scope (parent plan + supplement open/latest/booked).
        const { supplement, developmentPlan, strategy, tactic, plan } =
          await this.validateForeignKeysAndScope(
            manager,
            dto.developmentPlanSupplementId,
            {
              strategyId: dto.strategyId,
              tacticId: dto.tacticId,
              planId: dto.planId,
            },
            format,
          );

        // §16.6 ISSUE_BASED — resolve the issue and verify plan binding.
        let developmentIssue: DevelopmentIssue | null = null;
        if (format === ReportFormat.ISSUE_BASED) {
          developmentIssue = await this.resolveAndAssertIssue(
            manager,
            dto.developmentIssueId!,
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
                strategy: strategy as Strategy,
                tactic: tactic as Tactic,
                plan: plan as Plan,
                indicator: dto.indicator,
                developmentIssue: null,
              };

        // §5.1 — derive responsibleAgency from WorkHistory. Agency-only
        // gate means this always lands on the agency branch.
        const agencyData = sharedGetAgencyData(workHistory);

        const supplementProjectGroup = manager.create(SupplementProjectGroup, {
          developmentPlanSupplement: supplement as any,
          title: dto.title,
          objective: dto.objective,
          goal: dto.goal,
          startLat: dto.startLat,
          startLng: dto.startLng,
          endLat: dto.endLat,
          endLng: dto.endLng,
          expected: dto.expected,
          projectYear: dto.projectYear,
          isDraft: false,
          ...classificationColumns,
          createdBy: workHistory,
          // 2026-05-12 (bug fix): SPG.amphoe was never being persisted
          // on create — the `amphoe_id` column on the row was always
          // NULL. Mirrors the canonical PG create at
          // `project-groups.service.ts:302` which writes the creator's
          // amphoe FK. For agency callers (Q1+Q2 supplement gate) this
          // is always อบจ.นม amphoe (`'3001'`), but the assignment is
          // shape-symmetric with PG/RPG and enables the §13 geo
          // aggregation / executive amphoe rollup paths that consume
          // SPG.amphoe directly (W55-BE-04 +
          // unified-projects executive list).
          amphoe: workHistory.amphoe
            ? ({ id: workHistory.amphoe.id } as any)
            : null,
          // Task `SUPP_SPG_LAO_COLUMN` (2026-05-12) — denormalized
          // creator-LAO column for shape-symmetry with PG / RPG. For
          // the current Q1+Q2 supplement gate (agency-only) this is
          // always `'3001027'` (อบจ.นม), but we populate it
          // unconditionally so aggregator / filter queries can match
          // on the column directly instead of JOINing through
          // `createdBy.workHistory`. Future scope-widening (e.g.
          // coordinated LAOs admitted into the supplement gate) will
          // get correct values without a follow-up schema change.
          // §5 immutable — set at INSERT only, never mutated on update.
          localAdministrativeOrganization: workHistory.localAdministrativeOrganization
            ? ({ id: workHistory.localAdministrativeOrganization.id } as any)
            : null,
          // originAgencyId — agency-origin: null unless the workHistory
          // unexpectedly carries a non-อบจ lao (guarded above).
          originAgencyId:
            workHistory.localAdministrativeOrganization?.id === '3001027'
              ? null
              : ({ id: workHistory.localAdministrativeOrganization?.id } as any),
          additionalDetail: dto.additionalDetail,
          isLatest: true,
          ...(agencyData as any),
        } as any);

        const savedProject = await manager.save(supplementProjectGroup);

        // §12 audit — write the initial `Ready` TrackingStatus row.
        // SUPP-IA-03 (BE-α, 2026-05-12): SPG now enters the workflow at
        // `Ready` mirroring main-plan PG. Owner explicitly advances
        // Ready → Pending via the shared tracking-status endpoint
        // (handled in `TrackingStatusService.createBySupplementProjectGroup`
        // per BE-β below).
        const readyStatusId = await this.resolveStatusId(manager, 'Ready');
        const trackingStatus = manager.create(TrackingStatus, {
          supplementProjectGroupId: savedProject,
          statusId: { id: readyStatusId } as any,
          createdBy: workHistory,
          isLatest: true,
        });
        await manager.save(trackingStatus);

        // Budgets (publish path requires non-empty + positive — enforced
        // by `assertWizardCompleteness` above).
        await this.persistBudgets(
          manager,
          savedProject.id,
          dto.budget,
          developmentPlan,
        );

        return savedProject.id;
      });

      // §17.4 — baseline snapshot is NOT fired at create. SUPP-IA-03 (BE-α,
      // 2026-05-12): the trigger is relocated to the owner Ready → Pending
      // transition in `TrackingStatusService.createBySupplementProjectGroup`
      // (BE-β), mirroring main-plan PG and the §17.4 Wave 11 authoring-vs-
      // workflow-only rule. `[create POST] → Ready` is a pre-submission
      // state and does NOT count as the authoring-time submit.

      // Refetch with relations so the API contract matches existing
      // controller consumers.
      return await this.findOne(savedId);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  // ============================================================
  // PUBLIC — read paths (unchanged from prior implementation)
  // ============================================================

  async findAll(): Promise<SupplementProjectGroup[]> {
    try {
      const rows = await this.supplementProjectGroupRepo.find({
        relations: [
          'developmentPlanSupplement',
          'strategy',
          'tactic',
          'plan',
          'createdBy',
          'createdBy.user',
          'budgets',
        ],
        order: { createdAt: 'DESC' },
      });
      await this.maskCreatedByUser(rows);
      return rows;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findBySupplement(
    supplementId: string,
  ): Promise<SupplementProjectGroup[]> {
    try {
      const rows = await this.supplementProjectGroupRepo.find({
        where: { developmentPlanSupplement: { id: supplementId } },
        relations: [
          'developmentPlanSupplement',
          'strategy',
          'tactic',
          'plan',
          'createdBy',
          'createdBy.user',
          'budgets',
        ],
        order: { createdAt: 'DESC' },
      });
      await this.maskCreatedByUser(rows);
      return rows;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Detail endpoint. SUPP-1 BE-03 — gated by role + ownership.
   *
   * - `staff` / `admin` / `super-admin` / `c-level` — any non-soft-deleted SPG.
   * - `user` role — only their own SPG (ownership via WorkHistory id, §4).
   *   LAO-classified users have no SPGs by construction (Q2) and are
   *   rejected via `SupplementScopeService.assertSupplementOwnerScope`.
   *
   * `userId` is optional only for legacy call sites that already perform
   * their own authorization (e.g. `create` re-fetching after commit).
   * Controller routes MUST pass the authenticated `userId`.
   */
  async findOne(
    id: string,
    userId?: string,
  ): Promise<SupplementProjectGroup> {
    try {
      const row = await this.supplementProjectGroupRepo.findOne({
        where: { id },
        relations: [
          'developmentPlanSupplement',
          'developmentPlanSupplement.developmentPlan',
          'strategy',
          'tactic',
          'plan',
          'developmentIssue',
          'createdBy',
          'createdBy.user',
          'responsibleAgency',
          'originAgencyId',
          'budgets',
          'trackingStatus',
          'trackingStatus.statusId',
          'trackingStatus.createdBy',
          'trackingStatus.createdBy.user',
          // BUGFIX 2026-05-16 — `trackingStatus.comments` was missing
          // from `findOne` relations (same root-cause pattern as the
          // `attachments` 2026-05-15 fix). The SupplementEdit page reuses
          // `ProjectForm` which renders the staff "Returned_For_Revision"
          // comment bubble at lines 643-694 of ProjectForm.tsx, iterating
          // `status?.comments`. Without this relation the bubble fell
          // back to free-text `status.comment` only, and the per-step
          // clickable links (which read `c.step`) never rendered.
          'trackingStatus.comments',
          // BUGFIX 2026-05-15 — `attachments` was missing from this relations
          // list, so `SupplementDetailWithComment` modal (staff review surface)
          // never received the file list even though DB had rows. SPG entity
          // declares the OneToMany at line 224-232. FE expects `project.attachments`
          // for both the inline file row block AND the SplitView "โหมดตรวจสอบเอกสาร"
          // trigger button (visible only when ≥1 non-deleted attachment exists).
          // §17.3 audit safety: AttachmentSupplementProjectGroup has its own
          // soft-delete column; the deletedAt filter happens at the FE rendering
          // layer (`.filter(f => !f.deletedAt)`).
          'attachments',
        ],
      });
      if (!row) {
        throw new NotFoundException(
          `SupplementProjectGroup with ID ${id} not found`,
        );
      }

      // Authorization. Skip only when no userId provided (internal callers).
      if (userId) {
        await this.assertReadAuthorized(row, userId);
      }

      await this.maskCreatedByUser(row);
      return row;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * SUPP-1 BE-03 — Owner "my SPGs" endpoint.
   *
   * Returns SPGs owned by the calling user's current WorkHistory
   * (`createdBy.id = currentWorkHistory.id`). LAO callers are rejected
   * by `SupplementScopeService.assertSupplementOwnerScope` (Q2) —
   * which is correct: LAO has no SPGs to list.
   *
   * Optional filters:
   *   - `statusId`   — UUID of a `Status` row.
   *   - `statusName` — canonical name (e.g. `Pending`, `Approved`).
   * Both filter on the latest `TrackingStatus` row.
   *
   * Soft-deleted rows excluded (TypeORM default for `@DeleteDateColumn`).
   */
  async findMine(
    userId: string,
    opts: { statusId?: string; statusName?: string } = {},
  ): Promise<SupplementProjectGroup[]> {
    try {
      const workHistory = await this.workHistoryLookup.getCurrent(
        this.dataSource.manager,
        userId,
      );
      // §1 + §2 owner-scope gate. Throws 403 for LAO / non-agency callers.
      this.supplementScopeService.assertSupplementOwnerScope(workHistory);

      const qb = this.buildBaseSpgListQuery().where(
        'createdBy.id = :workHistoryId',
        { workHistoryId: workHistory.id },
      );

      this.applyLatestStatusFilter(qb, opts);

      const results = await qb.orderBy('spg.created_at', 'DESC').getMany();
      await this.maskCreatedByUser(results);
      return results;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * SUPPLEMENT_SIDEBAR_BADGES BE-OWNER-COUNTS — Owner-scoped SPG count
   * envelope powering the 4 sidebar badges for
   * `/project/supplement/{ready-to-send,verify,edit,pullback}`.
   *
   * Predicates (FROZEN per task §7):
   *   - `ready`    — own SPGs whose latest status is `Ready`
   *   - `verify`   — own SPGs whose latest status ∈
   *                  {`Pending`, `Verified`, `Pending_Approval`}
   *   - `edit`     — own SPGs whose latest status is
   *                  `Returned_For_Revision` ONLY (narrowed 2026-05-12 —
   *                  does NOT include `Pull_Back`)
   *   - `pullBack` — own SPGs whose latest status is `Pull_Back`
   *
   * Authority:
   *   - §4 ownership filter uses `currentWorkHistory.id` — NOT raw `userId`.
   *   - LAO / non-agency callers receive `{ ready: 0, verify: 0, edit: 0,
   *     pullBack: 0 }` with HTTP 200 instead of 403 (per umbrella §9 —
   *     prevents sidebar fetch noise; the sidebar entries are also hidden
   *     by `onlyLaoIds` on the FE).
   *   - §2 `workStatus = approved` still applies (delegated to
   *     `WorkHistoryLookupService.assertWorkStatusApproved` via
   *     `getCurrent`).
   *
   * Compliance:
   *   - §17.2 advisory-only — output MUST NOT gate any workflow.
   *   - §17.3 audit separation — this method is READ-ONLY. DO NOT add any
   *     `TrackingStatus` write here under any circumstance.
   *
   * Implementation: ONE SQL round-trip using Postgres `COUNT(*) FILTER
   * (WHERE …)` aggregation. Reuses the same ownership predicate as
   * `findMine` (`createdBy.id = :workHistoryId` + `spg.deleted_at IS NULL`
   * + `is_latest = true`) so count and list cannot drift.
   */
  async findMineCounts(
    userId: string,
  ): Promise<{
    ready: number;
    verify: number;
    edit: number;
    pullBack: number;
  }> {
    try {
      const workHistory = await this.workHistoryLookup.getCurrent(
        this.dataSource.manager,
        userId,
      );
      // §2 workStatus gate. Mirrors `findMine`. Throws 401 on non-approved.
      this.workHistoryLookup.assertWorkStatusApproved(workHistory);

      // §1 classification gate — LAO / malformed callers get zeros, NOT
      // 403. This is the deliberate divergence from `findMine`: the
      // sidebar fetches this on every layout render and a 403 would
      // surface as a console error noise loop for LAO users who can
      // see the sidebar entries by other roles' mis-mounting.
      const amphoeId = workHistory.amphoe?.id;
      const laoId = workHistory.localAdministrativeOrganization?.id;
      const isAgency = amphoeId === '3001' && laoId === '3001027';
      if (!isAgency) {
        return { ready: 0, verify: 0, edit: 0, pullBack: 0 };
      }

      // ONE round-trip — Postgres `COUNT(*) FILTER (WHERE …)` aggregation.
      // The JOIN topology mirrors `findMine` / `buildBaseSpgListQuery`
      // exactly (same `is_latest = true` filter, same soft-delete
      // exclusion, same ownership predicate) so badge count and page
      // list cannot drift (§17.2 advisory parity).
      const row = await this.supplementProjectGroupRepo
        .createQueryBuilder('spg')
        .innerJoin('spg.createdBy', 'createdBy')
        .innerJoin(
          'spg.trackingStatus',
          'latestTracking',
          'latestTracking.isLatest = :isLatest',
          { isLatest: true },
        )
        .innerJoin('latestTracking.statusId', 'latestStatus')
        .where('createdBy.id = :workHistoryId', {
          workHistoryId: workHistory.id,
        })
        .andWhere('spg.deleted_at IS NULL')
        // Lowercase aliases — Postgres folds unquoted identifiers to
        // lowercase, so we keep the SQL aliases lowercase and map to the
        // camelCase response keys explicitly below. This avoids any
        // ambiguity between TypeORM versions / drivers.
        .select(
          `COUNT(*) FILTER (WHERE "latestStatus"."name" = 'Ready')`,
          'ready_count',
        )
        .addSelect(
          `COUNT(*) FILTER (WHERE "latestStatus"."name" IN ('Pending','Verified','Pending_Approval'))`,
          'verify_count',
        )
        .addSelect(
          `COUNT(*) FILTER (WHERE "latestStatus"."name" = 'Returned_For_Revision')`,
          'edit_count',
        )
        .addSelect(
          `COUNT(*) FILTER (WHERE "latestStatus"."name" = 'Pull_Back')`,
          'pullback_count',
        )
        .getRawOne<{
          ready_count: string | number | null;
          verify_count: string | number | null;
          edit_count: string | number | null;
          pullback_count: string | number | null;
        }>();

      // `pg` driver returns COUNT as string; coerce defensively. `null`
      // is impossible here (FILTER aggregates always return 0 on empty)
      // but guard anyway.
      const toInt = (v: string | number | null | undefined): number => {
        if (v === null || v === undefined) return 0;
        const n = typeof v === 'number' ? v : parseInt(v, 10);
        return Number.isFinite(n) ? n : 0;
      };

      return {
        ready: toInt(row?.ready_count),
        verify: toInt(row?.verify_count),
        edit: toInt(row?.edit_count),
        pullBack: toInt(row?.pullback_count),
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * SUPP-1 BE-03 — Staff review queue endpoint.
   *
   * Returns SPGs whose latest `TrackingStatus.status.name` is in
   * { `Pending`, `Verified`, `Pending_Approval` }, filtered by
   * `WorkHistoryGovernmentAgencyResponsibility` (Q3 — AGENCY-BASED,
   * RPG-style, NOT amphoe-based).
   *
   * Role gating (mirrors RPG `findPendingRevisionProjects`):
   *   - `admin` / `super-admin` / `c-level` — see ALL in-flight SPGs.
   *   - `staff` — only SPGs whose `responsibleAgency.id` ∈ caller's
   *     `workHistoryResponsibleGovernmentAgency` set. A staff with NO
   *     agency responsibility entries gets an empty list.
   *   - any other role (incl. `user`) — 403.
   *
   * Workflow doc §13 / task spec §7: SPGs whose `responsibleAgency`
   * is null MUST NOT appear (defensive — SPG.responsibleAgency is
   * auto-assigned at create per Q1+Q2). Enforced by an inner-join
   * style `IS NOT NULL` clause.
   */
  async findPendingReview(
    userId: string,
  ): Promise<SupplementProjectGroup[]> {
    try {
      const workHistory = await this.workHistoryRepo.findOne({
        where: { user: { id: userId }, isCurrent: true },
        relations: [
          'user',
          'role',
          'workStatus',
          'workHistoryResponsibleGovernmentAgency',
          'workHistoryResponsibleGovernmentAgency.governmentAgency',
        ],
      });
      if (!workHistory) {
        throw new NotFoundException('Work history not found');
      }
      // §2 — workStatus gate. Reuse the shared helper (throws 401).
      this.workHistoryLookup.assertWorkStatusApproved(workHistory);

      const role = workHistory.role?.name;
      if (
        role !== 'staff' &&
        role !== 'admin' &&
        role !== 'super-admin' &&
        role !== 'c-level'
      ) {
        throw new ForbiddenException(
          'คุณไม่มีสิทธิ์เข้าถึงคิวตรวจสอบโครงการเพิ่มเติม',
        );
      }

      const qb = this.buildBaseSpgListQuery();

      // Workflow §13 — in-flight statuses for the review queue.
      qb.andWhere('latestStatus.name IN (:...queueStatuses)', {
        queueStatuses: ['Pending', 'Verified', 'Pending_Approval'],
      });

      // Defensive: SPG.responsibleAgency is auto-assigned at create per
      // Q1+Q2; a null value indicates a data bug and MUST be excluded.
      qb.andWhere('responsibleAgency.id IS NOT NULL');

      if (role === 'staff') {
        const responsibleAgencyIds = (
          workHistory.workHistoryResponsibleGovernmentAgency ?? []
        )
          .map((r) => r.governmentAgency?.id)
          .filter((id): id is string => !!id);
        if (responsibleAgencyIds.length === 0) {
          // No agency responsibility → empty queue (correct behavior).
          return [];
        }
        qb.andWhere(
          'responsibleAgency.id IN (:...responsibleAgencyIds)',
          { responsibleAgencyIds },
        );
      }
      // admin / super-admin / c-level — bypass the agency filter.

      const results = await qb.orderBy('spg.created_at', 'DESC').getMany();
      await this.maskCreatedByUser(results);
      return results;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * SUPP_STAFF_BE_01 — Status-segmented staff queue.
   *
   * Returns SPGs whose latest TrackingStatus matches a single canonical
   * status name, filtered for the calling staff member's agency
   * responsibility set (Q3 — AGENCY-BASED, RPG-style; same rule as
   * `findPendingReview`). `admin` / `super-admin` / `c-level` bypass the
   * responsibility filter; `user` → 403.
   *
   * Shared helper invoked by the four thin controller wrappers
   * (`by-status-{pending,verified,pending-approval,approved}-supplement`).
   * Centralises the JOIN topology, role gate, agency-responsibility join,
   * status filter, optional plan/supplement filters, PII masking, and
   * `countOnly` shaping in ONE place to avoid the 4× copy-paste.
   *
   * Defensive constraints (mirroring `findPendingReview`):
   *   - SPG.responsibleAgency IS NOT NULL (auto-assigned at create per
   *     Q1+Q2; null indicates a data bug).
   *   - Soft-deleted SPGs excluded by `buildBaseSpgListQuery`.
   *   - Empty staff agency-responsibility set → `[]` (or `{ count: 0 }`).
   *
   * Returns:
   *   - `countOnly = true`  → `{ count: number }`
   *   - `countOnly = false` → `SupplementProjectGroup[]` (PII masked)
   */
  async findByStatusForStaff(
    statusName: 'Pending' | 'Verified' | 'Pending_Approval' | 'Approved',
    opts: {
      userId: string;
      countOnly?: boolean;
      developmentPlanId?: string;
      developmentPlanSupplementId?: string;
    },
  ): Promise<SupplementProjectGroup[] | { count: number }> {
    try {
      const workHistory = await this.workHistoryRepo.findOne({
        where: { user: { id: opts.userId }, isCurrent: true },
        relations: [
          'user',
          'role',
          'workStatus',
          'workHistoryResponsibleGovernmentAgency',
          'workHistoryResponsibleGovernmentAgency.governmentAgency',
        ],
      });
      if (!workHistory) {
        throw new NotFoundException('Work history not found');
      }
      // §2 — workStatus gate.
      this.workHistoryLookup.assertWorkStatusApproved(workHistory);

      // Role gate — same allowlist as `findPendingReview`.
      const role = workHistory.role?.name;
      if (
        role !== 'staff' &&
        role !== 'admin' &&
        role !== 'super-admin' &&
        role !== 'c-level'
      ) {
        throw new ForbiddenException(
          'คุณไม่มีสิทธิ์เข้าถึงคิวโครงการเพิ่มเติม',
        );
      }

      const qb = this.buildBaseSpgListQuery();

      // Latest-status filter — single canonical name.
      qb.andWhere('latestStatus.name = :statusName', { statusName });

      // Defensive — exclude rows with no responsibleAgency.
      qb.andWhere('responsibleAgency.id IS NOT NULL');

      // Optional scope filters.
      if (opts.developmentPlanId) {
        qb.andWhere('developmentPlan.id = :developmentPlanId', {
          developmentPlanId: opts.developmentPlanId,
        });
      }
      if (opts.developmentPlanSupplementId) {
        qb.andWhere('supplement.id = :developmentPlanSupplementId', {
          developmentPlanSupplementId: opts.developmentPlanSupplementId,
        });
      }

      // Staff agency-responsibility filter — admin/super-admin/c-level bypass.
      if (role === 'staff') {
        const responsibleAgencyIds = (
          workHistory.workHistoryResponsibleGovernmentAgency ?? []
        )
          .map((r) => r.governmentAgency?.id)
          .filter((id): id is string => !!id);
        if (responsibleAgencyIds.length === 0) {
          // No agency responsibility → empty queue.
          return opts.countOnly ? { count: 0 } : [];
        }
        qb.andWhere(
          'responsibleAgency.id IN (:...responsibleAgencyIds)',
          { responsibleAgencyIds },
        );
      }

      if (opts.countOnly) {
        const count = await qb.getCount();
        return { count };
      }

      const results = await qb.orderBy('spg.created_at', 'DESC').getMany();
      await this.maskCreatedByUser(results);
      return results;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Direct update path (non-draft). Used by `AdditionalBook` admin UI
   * and existing book-management surfaces. Owner ownership check, §15
   * BookLockService guard, §14 lineage stub.
   *
   * The status transition path lives in `TrackingStatusService` (BE-02).
   */
  async update(
    id: string,
    dto: UpdateSupplementProjectGroupDto,
    userId: string,
  ): Promise<SupplementProjectGroup> {
    try {
      // §5.1 / §7.1 — clients cannot reassign responsibleAgency through
      // a generic update either; reuse the same defensive 400.
      this.assertNoClientResponsibleAgency(dto);

      return await this.dataSource.transaction(async (manager) => {
        const workHistory = await this.getWorkHistory(manager, userId);
        this.assertWorkStatusApproved(workHistory);
        this.supplementScopeService.assertSupplementOwnerScope(workHistory);

        const existing = await manager.findOne(SupplementProjectGroup, {
          where: { id },
          relations: [
            'developmentPlanSupplement',
            'developmentPlanSupplement.developmentPlan',
            'strategy',
            'tactic',
            'plan',
            'developmentIssue',
            'createdBy',
          ],
        });

        if (!existing) {
          throw new NotFoundException(
            `SupplementProjectGroup with ID ${id} not found`,
          );
        }

        // Ownership — edit is owner-scoped per CLAUDE.md §4 / workflow §8.
        if (existing.createdBy?.id !== workHistory.id) {
          throw new ForbiddenException(
            'คุณไม่มีสิทธิ์ดำเนินการกับโครงการนี้',
          );
        }

        // SUPP-IA-03 (BE-γ, 2026-05-12) — editable-state allowlist.
        // Per workflow §10 (rev2): SPG may be edited by the owner only
        // when the latest tracking status is one of
        // {Ready, Pull_Back, Returned_For_Revision}.
        await this.assertEditableStatus(manager, id);

        // §15 + §14 guards BEFORE any mutation.
        await this.bookLockService.assertEditable(
          id,
          'development_plan_supplement',
          manager,
        );
        // §14 — Wave SUPP-4: SPG can now be a parent of an RPG
        // (prev_project_type = 'supplement'). Reject mutation if any live
        // RPG descendant exists.
        await this.assertNoSupplementDescendant(id, manager);

        // §16.5 classification shape against the parent plan resolved
        // through the supplement chain.
        const format =
          await this.bookFormatResolver.resolveBySupplementProjectGroup(
            id,
            manager,
          );
        this.classificationValidator.validate(format, {
          strategyId: dto.strategyId ?? existing.strategy?.id ?? null,
          tacticId: dto.tacticId ?? existing.tactic?.id ?? null,
          planId: dto.planId ?? existing.plan?.id ?? null,
          developmentIssueId:
            dto.developmentIssueId ??
            existing.developmentIssue?.id ??
            null,
          indicator: dto.indicator ?? existing.indicator,
        });

        // Scope re-check — the supplement+plan window must still be
        // open. If the DTO supplies a different supplement, validate
        // that one too; otherwise validate the existing one.
        const supplementId =
          dto.developmentPlanSupplementId ??
          existing.developmentPlanSupplement?.id;
        const { supplement, developmentPlan, strategy, tactic, plan } =
          await this.validateForeignKeysAndScope(
            manager,
            supplementId!,
            {
              strategyId: dto.strategyId ?? undefined,
              tacticId: dto.tacticId ?? undefined,
              planId: dto.planId ?? undefined,
            },
            format,
          );

        let resolvedIssue: DevelopmentIssue | null | undefined;
        if (dto.developmentIssueId !== undefined) {
          if (dto.developmentIssueId === null) {
            resolvedIssue = null;
          } else {
            resolvedIssue = await this.resolveAndAssertIssue(
              manager,
              dto.developmentIssueId,
              developmentPlan.id,
            );
          }
        }

        // Apply mutations.
        if (supplement) existing.developmentPlanSupplement = supplement;
        if (dto.title !== undefined) existing.title = dto.title;
        if (dto.objective !== undefined) existing.objective = dto.objective;
        if (dto.goal !== undefined) existing.goal = dto.goal;
        if (dto.startLat !== undefined) existing.startLat = dto.startLat;
        if (dto.startLng !== undefined) existing.startLng = dto.startLng;
        if (dto.endLat !== undefined) existing.endLat = dto.endLat;
        if (dto.endLng !== undefined) existing.endLng = dto.endLng;
        if (dto.expected !== undefined) existing.expected = dto.expected;
        if (dto.projectYear !== undefined) existing.projectYear = dto.projectYear;
        // SUPP-1 followup (2026-05-12): SPG has no draft state.
        // `isDraft` is a legacy column permanently `false`; callers
        // MUST NOT be able to flip it via update.
        if (dto.additionalDetail !== undefined) {
          existing.additionalDetail = dto.additionalDetail;
        }

        if (format === ReportFormat.ISSUE_BASED) {
          existing.strategy = null;
          existing.tactic = null;
          existing.plan = null;
          existing.indicator = null;
          if (resolvedIssue !== undefined) {
            existing.developmentIssue = resolvedIssue;
          }
        } else {
          if (strategy) existing.strategy = strategy;
          if (tactic) existing.tactic = tactic;
          if (plan) existing.plan = plan;
          if (dto.indicator !== undefined) existing.indicator = dto.indicator;
          existing.developmentIssue = null;
        }

        // §5.1 / §7.1 — originAgencyId is part of project identity and
        // is NOT mutable via this generic update. Ignored even if
        // present on the DTO.

        if (dto.budget && dto.budget.length > 0) {
          for (const budgetItem of dto.budget) {
            if (
              budgetItem.year < developmentPlan.startYear ||
              budgetItem.year > developmentPlan.endYear
            ) {
              throw new BadRequestException(
                `ปีงบประมาณต้องอยู่ในช่วง พ.ศ. ${developmentPlan.startYear} - ${developmentPlan.endYear} (ปีที่ส่งมา: ${budgetItem.year})`,
              );
            }
          }

          await manager.delete(Budget, {
            supplementProjectGroupId: { id: existing.id } as any,
          });

          const budgets = dto.budget.map((b) =>
            manager.create(Budget, {
              supplementProjectGroupId: { id: existing.id } as any,
              year: b.year,
              quantity: b.quantity,
            }),
          );
          await manager.save(budgets);
        }

        return await manager.save(existing);
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Soft-remove an SPG. Owner-scoped. §15 + §14 guards apply.
   *
   * Replaces the prior hard-delete `remove`. The §12 audit trail (and
   * any SUPP-2 status-change history) is preserved on a `deletedAt`
   * flip — hard-delete would destroy the audit chain.
   */
  async softRemove(id: string, userId: string): Promise<{ message: string }> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const workHistory = await this.getWorkHistory(manager, userId);
        this.assertWorkStatusApproved(workHistory);
        this.supplementScopeService.assertSupplementOwnerScope(workHistory);

        const existing = await manager.findOne(SupplementProjectGroup, {
          where: { id },
          relations: ['createdBy'],
        });
        if (!existing) {
          throw new NotFoundException(
            `SupplementProjectGroup with ID ${id} not found`,
          );
        }
        if (existing.createdBy?.id !== workHistory.id) {
          throw new ForbiddenException(
            'คุณไม่มีสิทธิ์ดำเนินการกับโครงการนี้',
          );
        }

        // SUPP-IA-03 (BE-δ, 2026-05-12) — soft-delete allowlist.
        // Per workflow §10 (rev2): SPG may be soft-deleted by the owner
        // only when the latest tracking status is one of
        // {Ready, Pull_Back, Returned_For_Revision}.
        await this.assertEditableStatus(manager, id);

        await this.bookLockService.assertDeletable(
          id,
          'development_plan_supplement',
          manager,
        );
        // §14 — Wave SUPP-4: SPG soft-delete is rejected when any live RPG
        // descendant references this SPG via prev_project_type='supplement'.
        await this.assertNoSupplementDescendant(id, manager);

        const result = await manager.softDelete(SupplementProjectGroup, id);
        if (result.affected === 0) {
          throw new NotFoundException(
            `SupplementProjectGroup with ID ${id} not found`,
          );
        }
        return {
          message: `SupplementProjectGroup with ID ${id} has been soft-removed.`,
        };
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Backward-compatible alias. Existing controller route still hits
   * `remove`; we route it through `softRemove` so the audit-preserving
   * behavior applies uniformly. Hard-delete is intentionally NOT
   * exposed to controllers any more (§12 / §18 — audit history must
   * be preserved; orphan cleanup is the only path that ever flips
   * `deletedAt`).
   */
  async remove(id: string, userId: string): Promise<{ message: string }> {
    return this.softRemove(id, userId);
  }

  // ============================================================
  // PRIVATE — helpers
  // ============================================================

  /**
   * SUPP-1 BE-03 — Shared query shape for owner-list and staff-queue
   * endpoints.
   *
   * Centralises the JOIN topology so `findMine` and `findPendingReview`
   * produce identical response shapes for downstream consumers
   * (Wave SUPP-2 FE list pages). Includes the latest-tracking-status
   * inner-join so consumers can dispatch on `status.name` without a
   * second round-trip and so the staff queue can filter by status name.
   *
   * TypeORM's `@DeleteDateColumn` already filters soft-deleted rows
   * from `find` queries; for `createQueryBuilder` we add an explicit
   * `deleted_at IS NULL` clause to be defensive across TypeORM versions.
   */
  private buildBaseSpgListQuery(): SelectQueryBuilder<SupplementProjectGroup> {
    return this.supplementProjectGroupRepo
      .createQueryBuilder('spg')
      .leftJoinAndSelect('spg.developmentPlanSupplement', 'supplement')
      .leftJoinAndSelect('supplement.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('spg.strategy', 'strategy')
      .leftJoinAndSelect('spg.tactic', 'tactic')
      .leftJoinAndSelect('spg.plan', 'plan')
      .leftJoinAndSelect('spg.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('spg.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'createdByAmphoe')
      .leftJoinAndSelect(
        'createdBy.localAdministrativeOrganization',
        'createdByLao',
      )
      .leftJoinAndSelect('createdBy.governmentAgencies', 'createdByAgency')
      .leftJoinAndSelect('spg.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('spg.originAgencyId', 'originAgency')
      .leftJoinAndSelect('spg.budgets', 'budgets')
      // Inner-join the latest tracking row + its status so downstream
      // consumers always receive the canonical status name. The full
      // tracking history is exposed via a separate left-join so the
      // detail-style relations on the response shape remain intact.
      .innerJoin(
        'spg.trackingStatus',
        'latestTracking',
        'latestTracking.isLatest = :isLatest',
        { isLatest: true },
      )
      .innerJoinAndSelect('latestTracking.statusId', 'latestStatus')
      .leftJoinAndSelect('spg.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('trackingStatus.createdBy', 'trackingStatusCreatedBy')
      .leftJoinAndSelect(
        'trackingStatusCreatedBy.user',
        'trackingStatusCreatedByUser',
      )
      // 2026-05-16 — join the structured `comments` array on each tracking
      // row so the FE owner-list page (`SupplementEditList`) can render
      // staff "ส่งกลับแก้ไข" comments as clickable per-step NavLinks.
      // Mirrors the main-plan list relations. Without this, the FE comment
      // column collapses to either `latest.comment` (free-text fallback)
      // or "—" (no comments at all).
      .leftJoinAndSelect('trackingStatus.comments', 'trackingStatusComments')
      .where('spg.deleted_at IS NULL');
  }

  /**
   * Apply optional latest-status filter (by id or by canonical name).
   * Used by the owner-list endpoint. Mutates the QB in place.
   */
  private applyLatestStatusFilter(
    qb: SelectQueryBuilder<SupplementProjectGroup>,
    opts: { statusId?: string; statusName?: string },
  ): void {
    if (opts.statusId) {
      qb.andWhere('latestStatus.id = :statusId', { statusId: opts.statusId });
    }
    if (opts.statusName) {
      qb.andWhere('latestStatus.name = :statusName', {
        statusName: opts.statusName,
      });
    }
  }

  /**
   * Detail-endpoint authorization (SUPP-1 BE-03).
   *
   * Resolves the caller's current WorkHistory and applies:
   *   - workStatus = approved (§2)
   *   - role-based gate:
   *       staff / admin / super-admin / c-level → any SPG
   *       user → must own the SPG (createdBy.id === workHistory.id)
   *       any other role → 401
   *   - LAO classification fail-fast — SPGs are agency-origin by Q1+Q2,
   *     so a LAO caller has no legitimate read path. Reuse the canonical
   *     SupplementScopeService error envelope (403
   *     LAO_NOT_ALLOWED_ON_SUPPLEMENT).
   */
  private async assertReadAuthorized(
    row: SupplementProjectGroup,
    userId: string,
  ): Promise<void> {
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: [
        'user',
        'role',
        'workStatus',
        'amphoe',
        'localAdministrativeOrganization',
      ],
    });
    if (!workHistory) {
      throw new NotFoundException('Work history not found');
    }
    this.workHistoryLookup.assertWorkStatusApproved(workHistory);

    const role = workHistory.role?.name;
    if (
      role === 'staff' ||
      role === 'admin' ||
      role === 'super-admin' ||
      role === 'c-level'
    ) {
      // Staff-tier roles read any SPG. Workflow doc §13 narrows the
      // staff QUEUE by agency responsibility; detail reads are open
      // for staff so they can audit cross-agency context.
      return;
    }

    if (role === 'user') {
      // LAO callers are rejected before ownership — Q2.
      this.supplementScopeService.assertSupplementOwnerScope(workHistory);
      if (row.createdBy?.id !== workHistory.id) {
        throw new ForbiddenException(
          'คุณไม่มีสิทธิ์ในการเข้าถึงข้อมูลโครงการนี้',
        );
      }
      return;
    }

    throw new UnauthorizedException(
      'คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล',
    );
  }

  /**
   * §5.1 / §7.1 — `responsibleAgency` MUST be derived from the
   * creator's WorkHistory. Any client-supplied value is rejected.
   */
  private assertNoClientResponsibleAgency(
    dto:
      | CreateSupplementProjectGroupDto
      | UpdateSupplementProjectGroupDto,
  ): void {
    if (
      (dto as any).responsibleAgency !== undefined &&
      (dto as any).responsibleAgency !== null
    ) {
      throw new BadRequestException(
        'SPG_RESPONSIBLE_AGENCY_NOT_ALLOWED: ห้ามระบุ responsibleAgency ' +
          'จากฝั่ง client (ระบบกำหนดอัตโนมัติจาก WorkHistory)',
      );
    }
  }

  /**
   * §14 Version Lineage Immutability — SPG branch (Wave SUPP-4).
   *
   * Once an RPG references this SPG via `(prev_project_id = spg.id,
   * prev_project_type = 'supplement')` AND that RPG is not soft-deleted,
   * the SPG row is LOCKED for mutation / deletion per §14.2. The guard
   * MUST run BEFORE any repository write (§14.9) and MUST share the
   * caller's `EntityManager` so it participates in the same transaction.
   *
   * Wave SUPP-1..3 left this as a no-op stub because the
   * `prev_project_type` enum lacked `'supplement'`. DB-01 widened the
   * enum and BE-01 extended `LineageLockService.LineageProjectType` to
   * include `'supplement'`, so the call is now live.
   */
  private async assertNoSupplementDescendant(
    id: string,
    manager: EntityManager,
  ): Promise<void> {
    // §14.3 — both update and soft-delete share the same "no descendant"
    // invariant for SPG; use assertEditable so the thrown message reads
    // naturally for the mutation paths that call this helper (update,
    // softRemove). For pure-delete paths, the error semantics are
    // identical (`PROJECT_HAS_DESCENDANT`).
    await this.lineageLockService.assertEditable(id, 'supplement', manager);
  }

  /**
   * SUPP-IA-03 (BE-γ / BE-δ, 2026-05-12) — owner edit / soft-delete
   * status gate. Per workflow §10 (rev2), the SPG row is mutable by
   * its owner only when the current latest TrackingStatus is one of
   * `{Ready, Pull_Back, Returned_For_Revision}`. This is the SPG
   * analogue of the PG "editable states" gate.
   *
   * Reads the latest TrackingStatus row via `manager` so the check
   * runs inside the caller's transaction. Throws `ForbiddenException`
   * with a clear Thai message when the status is not in the allowlist.
   *
   * NOTE: this gate is INDEPENDENT of the §15 BookLockService and §14
   * LineageLockService guards. Each addresses a different invariant —
   * editable status (this gate), book lineage immutability (§15), and
   * project lineage immutability (§14, vacuous in SUPP-1/2/3).
   */
  private async assertEditableStatus(
    manager: EntityManager,
    spgId: string,
  ): Promise<void> {
    const latest = await manager.findOne(TrackingStatus, {
      where: {
        supplementProjectGroupId: { id: spgId } as any,
        isLatest: true,
      },
      relations: ['statusId'],
    });
    const currentName = latest?.statusId?.name ?? '';
    const allowed = new Set(['Ready', 'Pull_Back', 'Returned_For_Revision']);
    if (!allowed.has(currentName)) {
      throw new ForbiddenException(
        `ไม่สามารถดำเนินการกับโครงการในสถานะ "${currentName}" ได้ ` +
          '(อนุญาตเฉพาะ Ready, Pull_Back หรือ Returned_For_Revision)',
      );
    }
  }

  /**
   * §12 / W67 — resolve a Status row by canonical name. The legacy
   * hard-coded UUID (`96be5646-...`) is gone. Every SPG transition site
   * (create, future BE-02 status moves) MUST resolve
   * status ids via this helper.
   */
  private async resolveStatusId(
    manager: EntityManager,
    name: string,
  ): Promise<string> {
    const status = await manager.findOne(Status, { where: { name } });
    if (!status) {
      throw new NotFoundException(
        `Status "${name}" not found in system status table`,
      );
    }
    return status.id;
  }

  private async getWorkHistory(
    manager: EntityManager,
    userId: string,
  ): Promise<WorkHistory> {
    return this.workHistoryLookup.getCurrent(manager, userId);
  }

  private assertWorkStatusApproved(workHistory: WorkHistory): void {
    this.workHistoryLookup.assertWorkStatusApproved(workHistory);
  }

  /**
   * Duplicate-title guard (per-creator, per-workflow). Mirrors PG
   * `ensureNoDuplicateTitle` so behavior is consistent across project
   * kinds.
   */
  private async ensureNoDuplicateTitle(
    manager: EntityManager,
    title: string,
    workHistoryId: string,
    excludeId?: string,
  ): Promise<void> {
    const where: any = {
      title,
      createdBy: { id: workHistoryId },
      isDraft: false,
    };
    if (excludeId) {
      where.id = Not(excludeId);
    }
    const existing = await manager.findOne(SupplementProjectGroup, { where });
    if (existing) {
      throw new ConflictException('ชื่อโครงการดังกล่าวมีผู้ใช้แล้ว');
    }
  }

  /**
   * Validate the supplement chain + classification FKs and enforce
   * the scope binding from workflow §6:
   *   - parent `DevelopmentPlan.isLatest = true`
   *   - parent `DevelopmentPlan.deletedAt IS NULL`
   *   - `DevelopmentPlanSupplement.isLatest = true`
   *   - `DevelopmentPlanSupplement.isOpen = true`
   *   - `DevelopmentPlanSupplement.isBooked = false`
   *   - `DevelopmentPlanSupplement.deletedAt IS NULL`
   *
   * 2026-05-12 — `parent DevelopmentPlan.isBooked = false` REMOVED.
   * Supplement rounds are authored on top of a FINALIZED main plan
   * (the whole purpose of "เพิ่มเติมแผน"). The frontend round-creation
   * form (`AdditionalForm`) already requires `isPlanMerged === true`
   * before opening a round, so by the time SPG create lands here the
   * parent plan is — and must be — `isBooked = true`. The previous
   * guard contradicted the actual product flow and surfaced as
   * "แผนพัฒนาฯ ต้นทางถูกรวมเล่มแล้ว" on every create. The CLAUDE.md §8
   * `isBooked = false` rule applies to MAIN-PLAN project actions only;
   * supplement is its own workflow lane.
   *
   * Returns the loaded foreign keys for the caller to use.
   */
  private async validateForeignKeysAndScope(
    manager: EntityManager,
    supplementId: string | undefined,
    classification: {
      strategyId?: string;
      tacticId?: string;
      planId?: string;
    },
    format: ReportFormat,
  ): Promise<{
    supplement: DevelopmentPlanSupplement;
    developmentPlan: DevelopmentPlan;
    strategy: Strategy | null;
    tactic: Tactic | null;
    plan: Plan | null;
  }> {
    if (!supplementId) {
      throw new BadRequestException(
        'developmentPlanSupplementId is required',
      );
    }

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
    // 2026-05-12 — parent `isBooked = true` is the EXPECTED state for
    // the supplement workflow (supplements are added to a finalized
    // plan). The guard was removed; see method JSDoc above.

    // §16.5 — only STRATEGY_BASED requires the classification triple.
    if (format === ReportFormat.ISSUE_BASED) {
      return {
        supplement,
        developmentPlan,
        strategy: null,
        tactic: null,
        plan: null,
      };
    }

    const [strategy, tactic, plan] = await Promise.all([
      classification.strategyId
        ? manager.findOne(Strategy, { where: { id: classification.strategyId } })
        : null,
      classification.tacticId
        ? manager.findOne(Tactic, { where: { id: classification.tacticId } })
        : null,
      classification.planId
        ? manager.findOne(Plan, { where: { id: classification.planId } })
        : null,
    ]);

    if (classification.strategyId && !strategy) {
      throw new NotFoundException(
        `Strategy with ID ${classification.strategyId} not found`,
      );
    }
    if (classification.tacticId && !tactic) {
      throw new NotFoundException(
        `Tactic with ID ${classification.tacticId} not found`,
      );
    }
    if (classification.planId && !plan) {
      throw new NotFoundException(
        `Plan with ID ${classification.planId} not found`,
      );
    }

    return { supplement, developmentPlan, strategy, tactic, plan };
  }

  /**
   * §16.6 — DevelopmentIssue must exist AND belong to the same parent
   * plan as the supplement. Plan-mismatch is rejected with the
   * canonical `DEVELOPMENT_ISSUE_PLAN_MISMATCH` error.
   */
  private async resolveAndAssertIssue(
    manager: EntityManager,
    issueId: string,
    expectedPlanId: string,
  ): Promise<DevelopmentIssue> {
    if (!issueId) {
      throw new BadRequestException(
        `${ERROR_CODES.PROJECT_CLASSIFICATION_SHAPE_MISMATCH}: ${ERROR_MESSAGES.ISSUE_BASED_REQUIRES_ISSUE}`,
      );
    }
    const issue = await manager.findOne(DevelopmentIssue, {
      where: { id: issueId },
      relations: ['developmentPlan'],
    });
    if (!issue) {
      throw new NotFoundException(
        `${ERROR_CODES.DEVELOPMENT_ISSUE_NOT_FOUND}: ${ERROR_MESSAGES.DEVELOPMENT_ISSUE_NOT_FOUND}`,
      );
    }
    if (issue.developmentPlan?.id !== expectedPlanId) {
      throw new BadRequestException(
        `${ERROR_CODES.DEVELOPMENT_ISSUE_PLAN_MISMATCH}: ${ERROR_MESSAGES.DEVELOPMENT_ISSUE_PLAN_MISMATCH}`,
      );
    }
    return issue;
  }

  /**
   * Persist budgets for an SPG. Used by `create`.
   * Enforces the parent plan's `startYear`/`endYear` window matching
   * the existing behavior.
   */
  private async persistBudgets(
    manager: EntityManager,
    spgId: string,
    budgets: CreateSupplementProjectGroupDto['budget'],
    developmentPlan: DevelopmentPlan,
  ): Promise<void> {
    if (!Array.isArray(budgets) || budgets.length === 0) return;

    for (const budgetItem of budgets) {
      if (
        budgetItem.year < developmentPlan.startYear ||
        budgetItem.year > developmentPlan.endYear
      ) {
        throw new BadRequestException(
          `ปีงบประมาณต้องอยู่ในช่วง พ.ศ. ${developmentPlan.startYear} - ${developmentPlan.endYear} (ปีที่ส่งมา: ${budgetItem.year})`,
        );
      }
    }

    const rows = budgets.map((b) =>
      manager.create(Budget, {
        supplementProjectGroupId: { id: spgId } as any,
        year: b.year,
        quantity: b.quantity,
      }),
    );
    await manager.save(rows);
  }

  // SUPP-IA-03 (BE-α, 2026-05-12): the `fireBaselineSnapshot` helper
  // previously fired at create-time has been REMOVED. The §17.4
  // `no-ai-baseline` write is now performed by
  // `TrackingStatusService.createBySupplementProjectGroup` at the
  // owner-driven `Ready → Pending` transition (the authoring-time
  // submit per §17.4 Wave 11). See the SPG branch of that service for
  // the relocated call.
}
