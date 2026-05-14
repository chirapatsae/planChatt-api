import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PlanPhase, PhaseType } from 'src/plan-phase/entities/plan-phase.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { CreateTrackingStatusDto } from './dto/create-tracking-status.dto';
import { UpdateTrackingStatusDto } from './dto/update-tracking-status.dto';
import { Status } from 'src/status/entities/status.entity';
import { TrackingStatus } from './entities/tracking-status.entity';
import { Comment } from 'src/comments/entities/comment.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
// SUPP-1 / BE-02 — SPG support.
// Mirrors the PG / RPG paths above but uses agency-based responsibility (Q3,
// `WorkHistoryGovernmentAgencyResponsibility`, the RPG pattern) for staff
// transitions and rollback. Pull_Back rules are byte-for-byte identical to PG
// (Q4 verbatim parity). Rollback hard-deletes the SPG row per §14.6, even
// though SPG is a leaf in SUPP-1 — see TODO(SUPP-4) at the delete site.
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { handleException } from 'src/util/handleException';
import { AnnouncementsService } from 'src/announcements/announcements.service';
import { Role } from 'src/roles/entities/role.entity';
import { AnnouncementStatus, NotificationType } from 'src/announcements/entities/announcement.entity';
import { WorkHistoryAmphoeResponsibility } from 'src/work-history-amphoe-responsibility/entities/work-history-amphoe-responsibility.entity';
import { WorkHistoryGovernmentAgencyResponsibility } from 'src/work-history-government-agency-responsibility/entities/work-history-government-agency-responsibility.entity';
import { LineageLockService } from 'src/common/lineage-lock/lineage-lock.service';
import { NotificationsEmailService } from 'src/notifications/email/notifications-email.service';
import { NotificationsLineService } from 'src/notifications/line/notifications-line.service';
import { RecipientResolverService } from 'src/notifications/email/recipient-resolver.service';
import { DigestDispatcherService } from 'src/notifications/digest/digest-dispatcher.service';
import {
  ProjectNotificationEvent,
  ProjectNotificationEventType,
  ProjectNotificationRecipient,
} from 'src/notifications/events/project-notification-event';
import { UsersService } from 'src/users/users.service';
import { maskEmail } from 'src/notifications/email/utils/mask-email.util';
import { User } from 'src/users/entities/user.entity';
// SUPP-IA-03 (BE-β, 2026-05-12) — relocate §17.4 `no-ai-baseline`
// snapshot from `SupplementProjectGroupService.create` to the owner-
// driven Ready → Pending transition. The baseline write is post-commit
// and advisory (§17.2) — failures MUST NOT roll back the workflow
// transition. Wave 10 endpoint-rank idempotency dedupes any same-hash
// repeat fire across resubmission cycles.
import { PreSubmitSnapshotService } from 'src/ai/pre-submit-snapshot.service';
import { Budget } from 'src/budget/entities/budget.entity';
import { ReportFormat } from 'src/development-plan/types/report-format.enum';
import { BookFormatResolver } from 'src/common/project-classification/book-format.resolver';

/**
 * W105-BE-PR1 — sentinel thrown inside a per-project sub-transaction in
 * `bulkSubmit` to roll back ONLY that sub-transaction while preserving the
 * stable error code that the controller surfaces to the client. Caught by
 * the outer loop and converted into a `{ ok: false, errorCode }` row.
 *
 * Not exported — internal to the bulk-submit flow.
 */
class BulkSubmitRowError extends Error {
  constructor(
    public readonly code:
      | 'PROJECT_NOT_FOUND'
      | 'OWNERSHIP_OR_SCOPE_MISMATCH'
      | 'PLAN_NOT_LATEST'
      | 'PLAN_BOOKED'
      | 'PLAN_PHASE_NOT_OPEN'
      | 'WRONG_WORKFLOW'
      | 'STATUS_NOT_READY'
      | 'PROJECT_HAS_DESCENDANT'
      | 'STATUS_LOOKUP_FAILED'
      | 'INTERNAL_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'BulkSubmitRowError';
  }
}

@Injectable()
export class TrackingStatusService {
  private readonly logger = new Logger(TrackingStatusService.name);

  constructor(
    @InjectRepository(TrackingStatus)
    private readonly trackingStatusRepo: Repository<TrackingStatus>,
    @InjectRepository(ProjectGroup)
    private readonly projectGroupRepo: Repository<ProjectGroup>,
    @InjectRepository(RevisedProjectGroup)
    private readonly revisedProjectGroupRepo: Repository<RevisedProjectGroup>,
    // SUPP-1 / BE-02. Injected to participate in the same transaction as the
    // TrackingStatus write. The repo itself is rarely used directly — most
    // SPG reads/writes go through `manager.findOne` / `manager.delete` inside
    // the transactional callback.
    @InjectRepository(SupplementProjectGroup)
    private readonly supplementProjectGroupRepo: Repository<SupplementProjectGroup>,
    @InjectRepository(Status)
    private readonly statusRepo: Repository<Status>,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,
    @InjectRepository(Comment)
    private readonly commentRepo: Repository<Comment>,
    @InjectRepository(WorkHistoryAmphoeResponsibility)
    private readonly amphoeResponsibilityRepo: Repository<WorkHistoryAmphoeResponsibility>,
    @InjectRepository(WorkHistoryGovernmentAgencyResponsibility)
    private readonly agencyResponsibilityRepo: Repository<WorkHistoryGovernmentAgencyResponsibility>,

    private readonly announcementsService: AnnouncementsService,
    private readonly dataSource: DataSource,
    private readonly lineageLockService: LineageLockService,
    // Wave 21 N4 — email notification pipeline. Directly injected (not via
    // EventEmitter2) because the existing codebase has no @OnEvent handlers
    // for notifications and a direct call is simpler for QA to verify.
    // All calls are wrapped in try/catch at the emit site so that an email
    // failure NEVER propagates into the workflow transition path (§4.1,
    // task §7 guardrail: "emit failure must NOT propagate to the transition
    // path"). The call is POST-COMMIT — emitted strictly after the
    // `this.dataSource.transaction(...)` callback has returned successfully.
    private readonly notificationsEmailService: NotificationsEmailService,
    private readonly recipientResolver: RecipientResolverService,
    // W96-TRIGGER-WIRING — independent LINE fanout (Q9). queueLine internally
    // filters by LINE_EVENT_ALLOWLIST (W96-DISPATCH §gate 1) so non-LINE
    // events (e.g. PROJECT_SUBMITTED staff fanout) early-return without
    // queueing. Wrapped in its own try/catch at the call site so a LINE
    // failure does NOT prevent email firing AND does NOT cascade into the
    // workflow caller (§4.1).
    private readonly notificationsLineService: NotificationsLineService,
    // W100 PR3 — Cluster B3 fix. Used by `maskActorUsersOnTracking` to
    // decrypt-then-mask the actor User attached to every TrackingStatus
    // returned by the dedicated `/v1/tracking-status` read endpoints. Per
    // user-confirmed default #1 (audit timeline → mask everywhere) and
    // CLAUDE.md §17.11 (no role exemption), masking is applied uniformly
    // regardless of caller role. Read-only — no §12 audit write impact.
    private readonly usersService: UsersService,
    // W105 BE-PR2 — bulk-submit digest dispatcher. Consumed by `bulkSubmit`
    // post-commit to collapse N per-project notifications into ONE digest
    // job per `(recipientUserId, eventType)` group when group.projects ≥ 2.
    // Single-project (`POST /tracking-status/`) endpoints are NOT routed
    // through this service — they continue to use
    // `dispatchPhaseOneNotification` directly so the existing single-event
    // UX is unchanged. §17.2 advisory only.
    private readonly digestDispatcher: DigestDispatcherService,
    // SUPP-IA-03 (BE-β, 2026-05-12) — relocates the SPG §17.4 baseline
    // snapshot write from `SupplementProjectGroupService.create` to the
    // owner Ready → Pending transition (the authoring-time submit per
    // §17.4 Wave 11). Used ONLY by the SPG branch below; PG and RPG
    // continue to fire their baselines elsewhere (FE-driven for PG,
    // bulk-upload service for batch). Advisory per §17.2 — failures
    // are logged and swallowed post-commit.
    private readonly preSubmitSnapshotService: PreSubmitSnapshotService,
    // SUPP-IA-03 (BE-β) — used to resolve the parent plan's report
    // format for the baseline snapshot's `classification.reportFormat`
    // field. Read-only.
    private readonly bookFormatResolver: BookFormatResolver,
  ) { }

  /**
   * W100 PR3 — Decrypt-then-mask the actor User attached to every
   * TrackingStatus row before it leaves the dedicated tracking endpoints.
   *
   * Pattern 3 (mask everywhere) per user-confirmed default #1 — even
   * super-admin sees masked email on the audit timeline. PDPA-aligned.
   *
   * - email: decrypted, then replaced with `c***@domain.tld` shape
   * - phone: nulled (never surfaced on the timeline)
   * - citizenId: nulled (never surfaced on the timeline)
   *
   * Walks both `createdBy.user` (the actor) and `deletedBy.user` (the
   * staff/admin who soft-deleted the row, surfaced on the restore
   * response). Idempotent — `decryptUserPii` is safe to call on already
   * decrypted users (W89B), and `maskEmail` on a masked address is a
   * no-op-shaped output. WeakSet dedupes repeated User identities so we
   * never decrypt-then-mask the same user twice in one response.
   *
   * §12: this is a READ-side mutation of the in-memory response only;
   * the `tracking_status` table is NEVER written by this helper.
   * §17.3: AI tables untouched — no FK, no audit cross-write.
   * §17.11: no role override — every caller gets the masked shape.
   */
  private async maskActorUsersOnTracking(
    items: TrackingStatus[] | TrackingStatus | null | undefined,
  ): Promise<void> {
    if (!items) return;
    const list = Array.isArray(items) ? items : [items];
    const seen = new WeakSet<object>();
    const visit = async (user: User | null | undefined) => {
      if (!user || seen.has(user)) return;
      seen.add(user);
      await this.usersService.decryptUserPii(user);
      user.email = user.email ? maskEmail(user.email) : (null as unknown as string);
      // Phone and citizenId are NEVER surfaced on the audit timeline —
      // null at the response boundary defends against accidental
      // serialization of either ciphertext or plaintext.
      user.phone = null as unknown as string;
      user.citizenId = null as unknown as string;
    };
    for (const t of list) {
      if (!t) continue;
      await visit(t.createdBy?.user);
      await visit(t.deletedBy?.user);
    }
  }

  /**
   * Wave 21 N4 (refactored W94) — Map a canonical (fromStatus → toStatus)
   * transition into ZERO, ONE, or MORE notification event types. Returns an
   * empty array when the transition is NOT a notification trigger (e.g.
   * Verified → Pending_Approval, Ready → Draft).
   *
   * Multi-event per transition:
   *   - W94 introduces owner-side counterparts to staff-side events. A
   *     single transition may now fan out to BOTH (e.g. Ready → Pending
   *     fires PROJECT_SUBMITTED [staff] AND PROJECT_SUBMITTED_OWNER
   *     [confirmation]). Each call site loops the array.
   *
   * Wave 21 (Phase-1) events — staff/owner per existing semantics:
   *   * → Pending                          → PROJECT_SUBMITTED               (staff)
   *   Pending → Returned_For_Revision      → PROJECT_RETURNED_FOR_REVISION   (owner)
   *   Verified → Returned_For_Revision     → PROJECT_RETURNED_FOR_REVISION   (owner)
   *   Pending_Approval → Approved          → PROJECT_APPROVED                (owner)
   *
   * Wave 91 — owner pull-back:
   *   Pending  → Pull_Back                 → PROJECT_PULLED_BACK             (staff)
   *   Verified → Pull_Back                 → PROJECT_PULLED_BACK             (staff)
   *
   * Wave 94 — owner notification matrix:
   *   * → Pending                          → PROJECT_SUBMITTED_OWNER         (owner; ALONGSIDE staff PROJECT_SUBMITTED)
   *   Pending → Verified                   → PROJECT_VERIFIED_OWNER          (owner; progress update)
   *   * → Rejected                         → PROJECT_REJECTED_OWNER          (owner; final outcome — W67 status)
   */
  private resolveNotificationEventTypes(
    fromStatus: string | undefined,
    toStatus: string,
  ): ProjectNotificationEventType[] {
    const events: ProjectNotificationEventType[] = [];

    if (toStatus === 'Pending') {
      events.push('PROJECT_SUBMITTED');         // W21: staff fanout
      events.push('PROJECT_SUBMITTED_OWNER');   // W94: owner confirmation
      return events;
    }

    if (toStatus === 'Verified' && fromStatus === 'Pending') {
      events.push('PROJECT_VERIFIED_OWNER');    // W94: owner progress
      return events;
    }

    if (toStatus === 'Returned_For_Revision') {
      if (fromStatus === 'Pending' || fromStatus === 'Verified') {
        events.push('PROJECT_RETURNED_FOR_REVISION');
      }
      return events;
    }

    if (toStatus === 'Approved' && fromStatus === 'Pending_Approval') {
      events.push('PROJECT_APPROVED');
      return events;
    }

    if (toStatus === 'Rejected') {
      // W67 introduced 'Rejected' as a workflow exit state. W68 follow-up
      // defines exact valid prior states / who can trigger; until then, fire
      // the email on ANY transition to Rejected (the underlying state machine
      // is the gate — if the transition is invalid it would not happen).
      events.push('PROJECT_REJECTED_OWNER');    // W94: owner final outcome
      return events;
    }

    if (toStatus === 'Pull_Back') {
      // Per CLAUDE.md GLOBAL PULL BACK RULE, pull back is only allowed from
      // Pending or Verified. Defensive gate on fromStatus so we never emit
      // a notification for a malformed transition.
      if (fromStatus === 'Pending' || fromStatus === 'Verified') {
        events.push('PROJECT_PULLED_BACK');
      }
      return events;
    }

    return events;
  }

  /**
   * Wave 21 N4 — POST-COMMIT notification dispatch. Called AFTER the
   * `this.dataSource.transaction(...)` callback returns successfully. Wrapped
   * entirely in try/catch so that ANY failure here — recipient resolution,
   * queue add, template rendering, Redis outage — MUST NOT cascade into the
   * workflow caller (§4.1 + task §7 guardrail).
   *
   * Recipient resolution rules (architecture §2.3):
   *   - PROJECT_SUBMITTED (main plan)   → staff-lead by project.amphoe
   *   - PROJECT_SUBMITTED (revision)    → staff-lead by project.responsibleAgency
   *   - PROJECT_PULLED_BACK (main plan) → staff-lead by project.amphoe (Wave 91)
   *   - PROJECT_PULLED_BACK (revision)  → staff-lead by project.responsibleAgency (Wave 91)
   *   - PROJECT_RETURNED_FOR_REVISION   → project owner (createdBy WorkHistory)
   *   - PROJECT_APPROVED                → project owner (createdBy WorkHistory)
   */
  private async dispatchPhaseOneNotification(args: {
    eventType: ProjectNotificationEventType;
    fromStatus: string;
    toStatus: string;
    projectId: string;
    /**
     * SUPP-3 BE-06 — `'supplement-project-group'` added so SPG transitions
     * dispatch as first-class supplement notifications instead of borrowing
     * the RPG kind (the placeholder from SUPP-1 BE-02). Recipient
     * resolution for SPG mirrors the RPG agency-based pattern (Q3 —
     * `WorkHistoryGovernmentAgencyResponsibility`); the projectKind
     * literal differentiates SPG only on the rendering / deep-link side.
     */
    projectKind:
      | 'project-group'
      | 'revised-project-group'
      | 'supplement-project-group';
    projectTitle: string;
    projectAmphoeId?: string | null;
    projectResponsibleAgencyId?: string | null;
    createdByWorkHistoryId?: string | null;
    reason?: string | null;
    planName?: string | null;
    /**
     * Wave 22 B1 — workflow-actor threading. The user (and their current
     * WorkHistory) who performed the transition. These IDs are persisted
     * onto every resulting `notification_email_logs` row so the
     * super-admin stats surfaces can aggregate by actor. Advisory only
     * (§4.1) — MUST NOT influence recipient resolution or gating.
     */
    actorUserId?: string | null;
    actorWorkHistoryId?: string | null;
  }): Promise<void> {
    try {
      let recipients: ProjectNotificationRecipient[] = [];
      // Wave 91 — PROJECT_PULLED_BACK uses the same staff-lead resolution
      // as PROJECT_SUBMITTED. Owner is intentionally excluded (they
      // performed the action and do not need to be notified about it).
      if (
        args.eventType === 'PROJECT_SUBMITTED' ||
        args.eventType === 'PROJECT_PULLED_BACK'
      ) {
        if (args.projectKind === 'project-group' && args.projectAmphoeId) {
          recipients = await this.recipientResolver.resolveStaffLeadByAmphoe(
            args.projectAmphoeId,
          );
        } else if (
          // SUPP-3 BE-06 — SPG mirrors the RPG agency-responsibility
          // routing (Q3). Both kinds resolve via
          // `WorkHistoryGovernmentAgencyResponsibility` keyed on the
          // project's `responsibleAgency.id`. Defensive guard: if the
          // SPG has a null `responsibleAgency` we skip staff fanout
          // entirely and log — there is no amphoe fallback for SPG
          // (Q3 disallows amphoe-based responsibility for supplement).
          (args.projectKind === 'revised-project-group' ||
            args.projectKind === 'supplement-project-group') &&
          args.projectResponsibleAgencyId
        ) {
          recipients = await this.recipientResolver.resolveStaffLeadByAgency(
            args.projectResponsibleAgencyId,
          );
        }
      } else {
        // PROJECT_RETURNED_FOR_REVISION + PROJECT_APPROVED → owner
        if (args.createdByWorkHistoryId) {
          recipients = await this.recipientResolver.resolveOwner(
            args.createdByWorkHistoryId,
          );
        }
      }

      if (!recipients.length) {
        this.logger.debug(
          `[Notify] no-recipients event=${args.eventType} project=${args.projectId}`,
        );
        return;
      }

      // Wave 92 — resolve Thai status labels from `status.th_name` per CLAUDE.md
      // W67. Lookup is best-effort: a missing row falls back to the canonical
      // English name in `notifications-email.service.ts → templateCtx`. Two
      // queries instead of one IN-clause to keep the result map order-stable.
      const [fromStatusRow, toStatusRow] = await Promise.all([
        this.statusRepo.findOne({
          where: { name: args.fromStatus },
          select: ['name', 'th_name'],
        }),
        this.statusRepo.findOne({
          where: { name: args.toStatus },
          select: ['name', 'th_name'],
        }),
      ]);

      const event: ProjectNotificationEvent =
        this.notificationsEmailService.buildEvent({
          eventType: args.eventType,
          projectId: args.projectId,
          projectName: args.projectTitle,
          fromStatus: args.fromStatus,
          toStatus: args.toStatus,
          fromStatusTh: fromStatusRow?.th_name ?? undefined,
          toStatusTh: toStatusRow?.th_name ?? undefined,
          projectKind: args.projectKind,
          reason: args.reason ?? undefined,
          recipients,
          metadata: {
            kind: args.projectKind,
            planName: args.planName ?? null,
          },
          actorUserId: args.actorUserId ?? undefined,
          actorWorkHistoryId: args.actorWorkHistoryId ?? undefined,
        });

      // queueEmail internally swallows all errors but we still wrap in
      // try/catch as belt-and-braces in case the API contract regresses.
      try {
        await this.notificationsEmailService.queueEmail(event);
      } catch (emailErr) {
        // Email-side isolation — failure MUST NOT prevent LINE fanout
        // (Q9 independent channels) and MUST NOT cascade to workflow caller.
        this.logger.warn(
          `[Notify-email] emit-failed event=${args.eventType} project=${args.projectId} err=${(emailErr as Error).message}`,
        );
      }

      // W96-TRIGGER-WIRING — independent LINE fanout (Q9). queueLine
      // internally honors LINE_EVENT_ALLOWLIST (W96-DISPATCH §gate 1), so
      // calling for ALL events (including staff fanouts) is safe — non-LINE
      // events early-return without queueing. Channel-specific recipient
      // enrichment (LINE bindings) happens inside queueLine. Wrapped in its
      // own try/catch so a LINE failure does NOT cascade.
      try {
        await this.notificationsLineService.queueLine(event);
      } catch (lineErr) {
        this.logger.warn(
          `[Notify-line] emit-failed event=${args.eventType} project=${args.projectId} err=${(lineErr as Error).message}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `[Notify] emit-failed event=${args.eventType} project=${args.projectId} err=${(err as Error).message}`,
      );
    }
  }

  async create(dto: CreateTrackingStatusDto, userId: string): Promise<TrackingStatus> {
    try {
      // Wave 21 N4 — we need context (fromStatus, project amphoe + createdBy)
      // for a POST-COMMIT notification emit. Capture it inside the transaction,
      // return it alongside the saved tracking, then emit AFTER the transaction
      // callback resolves so that the DB write has committed.
      type TxResult = {
        saved: TrackingStatus;
        fromStatus: string;
        toStatus: string;
        project: {
          id: string;
          title: string;
          amphoeId: string | null;
          createdByWorkHistoryId: string | null;
          planName: string | null;
        };
        // Wave 22 B1 — workflow-actor threading (null when userId not found;
        // this cannot happen in practice here because we throw above, but
        // keep nullable for type safety).
        actorUserId: string | null;
        actorWorkHistoryId: string | null;
      };
      const txResult = await this.dataSource.transaction<TxResult>(async (manager) => {
        // 1-3. WorkHistory + workStatus (CLAUDE.md validation order)
        const workHistory = await manager.findOne(WorkHistory, {
          where: { user: { id: userId }, isCurrent: true },
          relations: ['user', 'role', 'workStatus', 'amphoe', 'localAdministrativeOrganization'],
        });
        if (!workHistory) {
          throw new NotFoundException(`WorkHistory for user ${userId} not found`);
        }
        if (workHistory.workStatus?.name !== 'approved') {
          throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)');
        }

        // 4. Load project
        const projectGroup = await manager.findOne(ProjectGroup, {
          where: { id: dto.projectId },
          relations: ['createdBy', 'developmentPlan', 'amphoe'],
        });
        if (!projectGroup) {
          throw new NotFoundException(`ProjectGroup with ID ${dto.projectId} not found`);
        }

        // หา status
        const status = await manager.findOne(Status, {
          where: { id: dto.statusId },
        });
        if (!status) {
          throw new NotFoundException(`Status with ID ${dto.statusId} not found`);
        }

        // --- RBAC & Ownership Check ---
        const allowedRoles = ['staff', 'admin', 'super-admin'];
        const userRole = workHistory.role?.name;

        if (!allowedRoles.includes(userRole)) {
          if (userRole === 'user') {
            // 8-9. Current status validation + allowed transitions for user role
            const currentTracking = await manager.findOne(TrackingStatus, {
              where: { projectGroupId: { id: projectGroup.id }, isLatest: true },
              relations: ['statusId'],
            });
            const currentStatusName: string = currentTracking?.statusId?.name ?? '';

            if (status.name === 'Pull_Back') {
              // 5. Ownership (CLAUDE.md §4): createdBy.id === workHistory.id
              if (projectGroup.createdBy?.id !== workHistory.id) {
                throw new ForbiddenException('คุณไม่มีสิทธิ์ในการเปลี่ยนสถานะโครงการนี้');
              }
              // Pull-back allowed only from Pending or Verified
              if (currentStatusName !== 'Pending' && currentStatusName !== 'Verified') {
                throw new BadRequestException(`ไม่สามารถดึงกลับได้จากสถานะ "${currentStatusName}"`);
              }
              // Scope: DevelopmentPlan must still be active + PlanPhase open
              const dp = projectGroup.developmentPlan;
              if (!dp?.isLatest) throw new BadRequestException('แผนพัฒนาฯ ไม่ใช่แผนปัจจุบัน');
              if (dp?.isBooked) throw new BadRequestException('แผนพัฒนาฯ ถูกรวมเล่มแล้ว');
              const isAgency = workHistory.amphoe?.id === '3001' && workHistory.localAdministrativeOrganization?.id === '3001027';
              const openPhase = await manager.findOne(PlanPhase, {
                where: { developmentPlan: { id: dp.id }, phaseType: isAgency ? PhaseType.AGENCY : PhaseType.LAO, isOpen: true },
              });
              if (!openPhase) throw new BadRequestException('ระยะเวลายื่นโครงการปิดแล้ว ไม่สามารถดึงกลับได้');

            } else if (status.name === 'Pending') {
              // User submission/resubmission to Pending.
              // Allowed source statuses: Ready, Pull_Back, Returned_For_Revision
              // CLAUDE.md §4.2 (Ready → Pending: same-org scope), PERMISSION MODEL,
              // Returned_For_Revision Rule (resubmission after staff rejection)
              const allowedSources = ['Ready', 'Pull_Back', 'Returned_For_Revision'];
              if (!allowedSources.includes(currentStatusName)) {
                throw new BadRequestException(
                  `ไม่สามารถส่งโครงการได้จากสถานะ "${currentStatusName}" ` +
                  `(ต้องอยู่ในสถานะ Ready, Pull_Back หรือ Returned_For_Revision)`,
                );
              }

              if (currentStatusName === 'Ready') {
                // Ready → Pending: same-organization scope per CLAUDE.md §4.2.
                // Ownership is NOT strictly required — authority is granted to users
                // in the same organizational scope as the project.

                // Determine project type from creator's WorkHistory (CLAUDE.md §5)
                const projectCreatorWh = await manager.findOne(WorkHistory, {
                  where: { id: projectGroup.createdBy?.id },
                  relations: ['amphoe', 'localAdministrativeOrganization'],
                });
                if (!projectCreatorWh) {
                  throw new BadRequestException('ไม่พบข้อมูล WorkHistory ของผู้สร้างโครงการ');
                }
                const isProjectAgency =
                  projectCreatorWh.amphoe?.id === '3001' &&
                  projectCreatorWh.localAdministrativeOrganization?.id === '3001027';
                const isRequesterAgency =
                  workHistory.amphoe?.id === '3001' &&
                  workHistory.localAdministrativeOrganization?.id === '3001027';

                if (isProjectAgency) {
                  // Agency-origin project: requester must be in same agency scope
                  if (!isRequesterAgency) {
                    throw new ForbiddenException('คุณไม่มีสิทธิ์ส่งโครงการนี้ (ต้องเป็นผู้ใช้ประเภท Agency เดียวกัน)');
                  }
                } else {
                  // LAO-origin project: requester must have same LAO
                  if (isRequesterAgency) {
                    throw new ForbiddenException('คุณไม่มีสิทธิ์ส่งโครงการนี้ (ต้องเป็นผู้ใช้ประเภท LAO เดียวกัน)');
                  }
                  const requesterLaoId = workHistory.localAdministrativeOrganization?.id;
                  const projectCreatorLaoId = projectCreatorWh.localAdministrativeOrganization?.id;
                  if (!requesterLaoId || !projectCreatorLaoId || requesterLaoId !== projectCreatorLaoId) {
                    throw new ForbiddenException('คุณไม่มีสิทธิ์ส่งโครงการนี้ (ต้องอยู่ในองค์กรปกครองส่วนท้องถิ่นเดียวกัน)');
                  }
                }
              } else {
                // Pull_Back → Pending or Returned_For_Revision → Pending:
                // Strict ownership required (CLAUDE.md §4, PERMISSION MODEL)
                if (projectGroup.createdBy?.id !== workHistory.id) {
                  throw new ForbiddenException('คุณไม่มีสิทธิ์ในการเปลี่ยนสถานะโครงการนี้');
                }
              }

              // Scope: DevelopmentPlan active + PlanPhase open
              // Re-validates scope on every submission/resubmission (RESUBMISSION CONSTRAINT)
              const dp = projectGroup.developmentPlan;
              if (!dp?.isLatest) throw new BadRequestException('แผนพัฒนาฯ ไม่ใช่แผนปัจจุบัน');
              if (dp?.isBooked) throw new BadRequestException('แผนพัฒนาฯ ถูกรวมเล่มแล้ว');
              const isAgency = workHistory.amphoe?.id === '3001' && workHistory.localAdministrativeOrganization?.id === '3001027';
              const openPhase = await manager.findOne(PlanPhase, {
                where: { developmentPlan: { id: dp.id }, phaseType: isAgency ? PhaseType.AGENCY : PhaseType.LAO, isOpen: true },
              });
              if (!openPhase) throw new BadRequestException('ระยะเวลายื่นโครงการปิดแล้ว ไม่สามารถส่งโครงการได้');

            } else {
              throw new ForbiddenException('คุณไม่มีสิทธิ์ในการเปลี่ยนสถานะโครงการนี้ (อนุญาตเฉพาะ Pull_Back และ Pending เท่านั้น)');
            }
          } else {
            throw new ForbiddenException('คุณไม่มีสิทธิ์ในการเปลี่ยนสถานะโครงการ');
          }
        } else {
          // Staff / Admin / Super-Admin branch
          // Per CLAUDE.md §3 + §4.1: staff must validate current status and transition rules.
          // Ownership is NOT required for staff-controlled workflow transitions.
          // Valid staff transitions: Pending → Verified, Pending → Returned_For_Revision,
          //   Verified → Pending_Approval, Verified → Returned_For_Revision,
          //   Pending_Approval → Approved

          // Validate project scope against its own DevelopmentPlan (CLAUDE.md §10: scope binding)
          const dp = projectGroup.developmentPlan;
          if (!dp?.isLatest) {
            throw new ForbiddenException('แผนพัฒนาฯ ที่เชื่อมโยงกับโครงการนี้ไม่ใช่แผนปัจจุบัน ไม่สามารถดำเนินการได้');
          }
          if (dp?.isBooked) {
            throw new ForbiddenException('แผนพัฒนาฯ ที่เชื่อมโยงกับโครงการนี้ถูกรวมเล่มแล้ว ไม่สามารถดำเนินการได้');
          }

          // Area responsibility check for staff role (mirrors rollback pattern in rollbackStatus)
          // Staff must be responsible for the project's amphoe. Admin/super-admin bypass.
          if (userRole === 'staff') {
            const projectAmphoeId = projectGroup.amphoe?.id;
            if (!projectAmphoeId) {
              throw new BadRequestException('โครงการนี้ไม่มีข้อมูลอำเภอ ไม่สามารถตรวจสอบสิทธิ์ได้');
            }
            const hasResponsibility = await manager.findOne(WorkHistoryAmphoeResponsibility, {
              where: {
                workHistory: { id: workHistory.id },
                amphoe: { id: projectAmphoeId },
              },
            });
            if (!hasResponsibility) {
              throw new ForbiddenException('คุณไม่มีสิทธิ์ดำเนินการกับโครงการนี้ (ไม่ได้รับผิดชอบอำเภอของโครงการ)');
            }
          }

          // Load current latest TrackingStatus to enforce transition rules
          const staffCurrentTracking = await manager.findOne(TrackingStatus, {
            where: { projectGroupId: { id: projectGroup.id }, isLatest: true },
            relations: ['statusId'],
          });
          if (!staffCurrentTracking) {
            throw new InternalServerErrorException(
              'ไม่พบสถานะปัจจุบันของโครงการ ข้อมูลสถานะอาจไม่สมบูรณ์',
            );
          }
          const staffCurrentStatusName = staffCurrentTracking.statusId?.name;
          if (!staffCurrentStatusName) {
            throw new InternalServerErrorException(
              'ไม่สามารถอ่านชื่อสถานะปัจจุบันของโครงการได้ ข้อมูล statusId อาจไม่สมบูรณ์',
            );
          }

          // Strict staff transition map: each source may have multiple valid destinations.
          // CLAUDE.md Returned_For_Revision Rule: MUST originate from Pending or Verified.
          const staffAllowedTransitions: Record<string, string[]> = {
            Pending: ['Verified', 'Returned_For_Revision'],
            Verified: ['Pending_Approval', 'Returned_For_Revision'],
            Pending_Approval: ['Approved'],
          };
          const allowedDestinations = staffAllowedTransitions[staffCurrentStatusName];
          if (!allowedDestinations || !allowedDestinations.includes(status.name)) {
            throw new ForbiddenException(
              `ไม่อนุญาตให้เปลี่ยนสถานะจาก "${staffCurrentStatusName}" เป็น "${status.name}" ` +
              `(เส้นทางที่อนุญาต: ${staffCurrentStatusName} → ${allowedDestinations?.join(', ') ?? 'ไม่มี'})`,
            );
          }
        }
        // ------------------------------

        // Wave 21 N4 — capture fromStatus BEFORE the isLatest flip so we can
        // include it in the post-commit notification payload. This is an
        // in-transaction read only (§12 audit: no write); the actual emit
        // happens after the transaction callback returns.
        const emitFromTracking = await manager.findOne(TrackingStatus, {
          where: { projectGroupId: { id: projectGroup.id }, isLatest: true },
          relations: ['statusId'],
        });
        const emitFromStatus = emitFromTracking?.statusId?.name ?? '';

        // 10. Transition + Audit
        await manager.update(TrackingStatus, {
          projectGroupId: { id: projectGroup.id },
        }, {
          isLatest: false,
        });

        // Resolve staffRemark: only staff-lead roles may set this field.
        // User role submissions must have staffRemark stripped to null.
        // CLAUDE.md §3 (Role Responsibilities), §12 (Audit Rule).
        const staffLeadRoles = ['staff', 'admin', 'super-admin'];
        const resolvedStaffRemark = staffLeadRoles.includes(workHistory.role?.name)
          ? (dto.staffRemark ?? null)
          : null;

        const tracking = manager.create(TrackingStatus, {
          createdBy: workHistory,
          projectGroupId: projectGroup,
          comment: dto.comment,
          staffRemark: resolvedStaffRemark,
          statusId: status,
          isLatest: true,
        });
        const savedTracking = await manager.save(TrackingStatus, tracking);

        if (dto.comments?.length) {
          const commentEntities = dto.comments.map((c) =>
            manager.create(Comment, {
              step: c.step,
              detail: c.detail,
              trackingStatusId: savedTracking,
            }),
          );
          await manager.save(Comment, commentEntities);
        }

        if (status.name === 'Pull_Back') {
          try {
            const staffRole = await manager.findOne(Role, { where: { name: 'staff' } });
            if (staffRole) {
              await this.announcementsService.create({
                title: 'มีการขอดึงกลับโครงการ',
                description: `โครงการ "${projectGroup.title}" ขอดึงกลับโดย ${workHistory.user?.firstname} ${workHistory.user?.lastname}`,
                type: NotificationType.PROJECT,
                status: AnnouncementStatus.PUBLISHED,
                roleIds: [staffRole.id],
              }, userId);
            }
          } catch (err) {
            this.logger.error('Failed to send pull back notification', err);
          }
        }

        return {
          saved: savedTracking,
          fromStatus: emitFromStatus,
          toStatus: status.name,
          project: {
            id: projectGroup.id,
            title: projectGroup.title ?? '',
            amphoeId: projectGroup.amphoe?.id ?? null,
            createdByWorkHistoryId: projectGroup.createdBy?.id ?? null,
            planName: projectGroup.developmentPlan?.name ?? null,
          },
          // Wave 22 B1 — workflow-actor threading.
          actorUserId: workHistory.user?.id ?? null,
          actorWorkHistoryId: workHistory.id ?? null,
        };
      });

      // POST-COMMIT emit — strictly after `this.dataSource.transaction(...)`
      // resolves. Any thrown error here is caught INSIDE
      // dispatchPhaseOneNotification so a notification failure can never fail
      // the workflow transition (§4.1, task §7 guardrail).
      // W94 — multi-event per transition. Loop sequentially so one failure
      // does not affect the next (each dispatch is wrapped in try/catch).
      const eventTypes = this.resolveNotificationEventTypes(
        txResult.fromStatus,
        txResult.toStatus,
      );
      for (const eventType of eventTypes) {
        await this.dispatchPhaseOneNotification({
          eventType,
          fromStatus: txResult.fromStatus,
          toStatus: txResult.toStatus,
          projectId: txResult.project.id,
          projectKind: 'project-group',
          projectTitle: txResult.project.title,
          projectAmphoeId: txResult.project.amphoeId,
          createdByWorkHistoryId: txResult.project.createdByWorkHistoryId,
          reason: dto.comment ?? dto.staffRemark ?? null,
          planName: txResult.project.planName,
          actorUserId: txResult.actorUserId,
          actorWorkHistoryId: txResult.actorWorkHistoryId,
        });
      }

      return txResult.saved;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async createMany(dtos: CreateTrackingStatusDto[], userId: string) {
    try {
      const workHistory = await this.workHistoryRepo.findOne({
        where: { user: { id: userId }, isCurrent: true },
        // Wave 22 B1 — eager-load `user` so actorUserId can be threaded onto
        // the post-commit notification emit audit rows.
        relations: ['role', 'workStatus', 'user'],
      });

      if (!workHistory) {
        throw new NotFoundException(`WorkHistory for user ${userId} not found`);
      }
      if (workHistory.workStatus?.name !== 'approved') {
        throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)');
      }

      // Staff-led only: this endpoint is restricted to staff/admin/super-admin
      const allowedRoles = ['staff', 'admin', 'super-admin'];
      const userRole = workHistory.role?.name;
      if (!allowedRoles.includes(userRole)) {
        throw new ForbiddenException('เฉพาะเจ้าหน้าที่ (staff/admin/super-admin) เท่านั้นที่สามารถใช้งาน endpoint นี้ได้');
      }

      // Strict transition map (CLAUDE.md §3, workflow-add-project §STATE TRANSITIONS)
      const staffAllowedTransitions: Record<string, string> = {
        Pending: 'Verified',
        Verified: 'Pending_Approval',
        Pending_Approval: 'Approved',
      };

      // Wave 21 N4 — collect post-commit emit descriptors inside the tx; emit
      // after the transaction callback resolves.
      type BulkEmitCtx = {
        fromStatus: string;
        toStatus: string;
        projectId: string;
        projectTitle: string;
        projectAmphoeId: string | null;
        createdByWorkHistoryId: string | null;
        planName: string | null;
        reason: string | null;
        // Wave 22 B1 — workflow-actor threading. Uniform across the whole
        // bulk call because createMany uses a single caller workHistory.
        actorUserId: string | null;
        actorWorkHistoryId: string | null;
      };
      const bulkEmits: BulkEmitCtx[] = [];

      const results = await this.dataSource.transaction(async (manager) => {
        const inner: TrackingStatus[] = [];

        for (const dto of dtos) {
          const { projectId, statusId } = dto;

          // Load project with DevelopmentPlan scope
          const projectGroup = await manager.findOne(ProjectGroup, {
            where: { id: projectId },
            relations: ['developmentPlan', 'createdBy', 'amphoe'],
          });
          if (!projectGroup) {
            throw new NotFoundException(`ProjectGroup with ID ${projectId} not found`);
          }

          const targetStatus = await manager.findOne(Status, { where: { id: statusId } });
          if (!targetStatus) {
            throw new NotFoundException(`Status with ID ${statusId} not found`);
          }

          // Plan scope binding (CLAUDE.md §10)
          const dp = projectGroup.developmentPlan;
          if (!dp?.isLatest) {
            throw new ForbiddenException(`แผนพัฒนาฯ ที่เชื่อมโยงกับโครงการนี้ไม่ใช่แผนปัจจุบัน (โครงการ ID: ${projectId})`);
          }
          if (dp?.isBooked) {
            throw new ForbiddenException(`แผนพัฒนาฯ ที่เชื่อมโยงกับโครงการนี้ถูกรวมเล่มแล้ว (โครงการ ID: ${projectId})`);
          }

          // Load and validate current TrackingStatus
          const currentTracking = await manager.findOne(TrackingStatus, {
            where: { projectGroupId: { id: projectId }, isLatest: true },
            relations: ['statusId'],
          });
          if (!currentTracking) {
            throw new BadRequestException(`ไม่พบสถานะปัจจุบันของโครงการ ID: ${projectId}`);
          }
          const currentStatusName = currentTracking.statusId?.name;
          if (!currentStatusName) {
            throw new BadRequestException(`ไม่สามารถอ่านสถานะปัจจุบันของโครงการ ID: ${projectId}`);
          }

          // Enforce strict transition map
          const allowedDestination = staffAllowedTransitions[currentStatusName];
          if (!allowedDestination || allowedDestination !== targetStatus.name) {
            throw new ForbiddenException(
              `ไม่อนุญาตให้เปลี่ยนสถานะจาก "${currentStatusName}" เป็น "${targetStatus.name}" ` +
              `(โครงการ ID: ${projectId}, เส้นทางที่อนุญาต: ${currentStatusName} → ${allowedDestination ?? 'ไม่มี'})`,
            );
          }

          // Commit transition
          await manager.update(
            TrackingStatus,
            { projectGroupId: { id: projectId } },
            { isLatest: false },
          );

          // createMany is staff-only (enforced above); staffRemark is always eligible.
          // staffRemark comes from per-dto value (each DTO in the bulk array may carry its own remark).
          const tracking = manager.create(TrackingStatus, {
            createdBy: workHistory,
            projectGroupId: { id: projectId },
            statusId: { id: statusId },
            staffRemark: dto.staffRemark ?? null,
            isLatest: true,
          });

          const savedTracking = await manager.save(TrackingStatus, tracking);
          inner.push(savedTracking);

          // Queue post-commit notification context.
          bulkEmits.push({
            fromStatus: currentStatusName,
            toStatus: targetStatus.name,
            projectId: projectGroup.id,
            projectTitle: projectGroup.title ?? '',
            projectAmphoeId: projectGroup.amphoe?.id ?? null,
            createdByWorkHistoryId: projectGroup.createdBy?.id ?? null,
            planName: projectGroup.developmentPlan?.name ?? null,
            reason: dto.staffRemark ?? null,
            actorUserId: workHistory.user?.id ?? null,
            actorWorkHistoryId: workHistory.id ?? null,
          });
        }

        return inner;
      });

      // POST-COMMIT emits — one call per (bulk item × resolved event).
      // W94: an item may produce multiple events (e.g. SUBMITTED + SUBMITTED_OWNER).
      for (const ctx of bulkEmits) {
        const eventTypes = this.resolveNotificationEventTypes(ctx.fromStatus, ctx.toStatus);
        for (const eventType of eventTypes) {
          await this.dispatchPhaseOneNotification({
            eventType,
            fromStatus: ctx.fromStatus,
            toStatus: ctx.toStatus,
            projectId: ctx.projectId,
            projectKind: 'project-group',
            projectTitle: ctx.projectTitle,
            projectAmphoeId: ctx.projectAmphoeId,
            createdByWorkHistoryId: ctx.createdByWorkHistoryId,
            reason: ctx.reason,
            planName: ctx.planName,
            actorUserId: ctx.actorUserId,
            actorWorkHistoryId: ctx.actorWorkHistoryId,
          });
        }
      }

      return results;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * W105-BE-PR1 — Owner-scoped bulk Ready → Pending transition for
   * MAIN-PLAN ProjectGroup rows.
   *
   * Replaces the N-parallel `POST /tracking-status/` storm produced by
   * `ReadyToSendPage.handleChangeStatusSelect` with a single round-trip
   * that performs per-project validation, partial-success semantics, and
   * collects post-commit notification descriptors (`bulkEmits[]`) for the
   * BE-PR2 digest dispatcher.
   *
   * Validation order per CLAUDE.md VALIDATION ORDER:
   *
   *   GLOBAL (run once before the per-project loop; failure rejects the
   *   ENTIRE request — not a per-row error):
   *     1. Authenticated user resolves
   *     2. Current/latest WorkHistory exists
   *     3. workStatus = approved
   *     4. Resolve submitter classification (agency vs lao) per CLAUDE.md §1
   *
   *   PER-PROJECT (each project runs in its own sub-transaction so a
   *   failure in one DOES NOT roll back successful peers — partial-success):
   *     5.  Load ProjectGroup
   *     6.  Same-org scope (§4.2) — Ready → Pending allows same-org
   *         submission. LAO requester must match project LAO; agency
   *         requester must match agency scope. Owner is always allowed.
   *     7.  Plan scope binding (§10): isLatest, !isBooked, matching open
   *         PlanPhase
   *     8.  Workflow scope: must be a main-plan project (RPG → WRONG_WORKFLOW)
   *         — implicit because we look up via `projectGroupRepo`.
   *     9.  Current latest status === 'Ready'
   *     10. Lineage lock (§14)
   *     11. Insert new TrackingStatus row, flip prior latest
   *     12. Push BulkSubmitEmit
   *
   * Transaction strategy: PER-PROJECT SUB-TRANSACTION (Option B per task
   * §6.3). Each project runs inside its own `dataSource.transaction()`
   * callback so a thrown exception inside one rolls back ONLY that
   * project's work. Rationale: simpler error isolation than savepoint
   * juggling, matches the partial-success contract verbatim, and the
   * per-project tx overhead is acceptable at the array cap of 100 rows.
   *
   * §17.3 — `bulkEmits[]` is in-memory only. The notification dispatch
   * happens AFTER all per-project transactions resolve and is wrapped in
   * try/catch per emit so a notification failure cannot fail the request.
   *
   * §12 — every successful project produces ONE TrackingStatus row with
   * isLatest flip; the digest does NOT touch tracking_status.
   */
  async bulkSubmit(
    actorUserId: string,
    dto: { projectIds: string[] },
  ): Promise<{
    results: Array<
      | { projectId: string; ok: true }
      | { projectId: string; ok: false; error: string; errorCode: string }
    >;
  }> {
    // --- GLOBAL submitter validation (steps 1-4) -----------------------------
    // Failures here reject the ENTIRE request with the appropriate HTTP error,
    // matching CLAUDE.md VALIDATION ORDER + task §6.2.
    const submitterWh = await this.workHistoryRepo.findOne({
      where: { user: { id: actorUserId }, isCurrent: true },
      relations: [
        'user',
        'role',
        'workStatus',
        'amphoe',
        'localAdministrativeOrganization',
      ],
    });
    if (!submitterWh) {
      throw new NotFoundException(
        `WorkHistory for user ${actorUserId} not found`,
      );
    }
    if (submitterWh.workStatus?.name !== 'approved') {
      throw new UnauthorizedException(
        'คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)',
      );
    }

    // Resolve submitter classification (CLAUDE.md §1)
    const isSubmitterAgency =
      submitterWh.amphoe?.id === '3001' &&
      submitterWh.localAdministrativeOrganization?.id === '3001027';

    // --- Duplicate-id dedup at the request edge ------------------------------
    // Per task §6.5 cheap dedup. We reject duplicates with HTTP 400 so the
    // client can correct the payload before retry.
    const seen = new Set<string>();
    for (const id of dto.projectIds) {
      if (seen.has(id)) {
        throw new BadRequestException(
          `DUPLICATE_PROJECT_ID: projectIds must be unique (duplicate: ${id})`,
        );
      }
      seen.add(id);
    }

    // Resolve the canonical 'Pending' status row ONCE for the whole batch.
    // Any failure here is a server misconfiguration, not a per-project error.
    const pendingStatus = await this.statusRepo.findOne({
      where: { name: 'Pending' },
    });
    if (!pendingStatus) {
      throw new InternalServerErrorException(
        'ไม่พบสถานะ "Pending" ในระบบ ข้อมูลสถานะอาจไม่สมบูรณ์',
      );
    }

    // --- Per-project sub-transactions (steps 5-12) ---------------------------
    type Result =
      | { projectId: string; ok: true }
      | { projectId: string; ok: false; error: string; errorCode: string };
    const results: Result[] = [];
    const bulkEmits: Array<{
      projectId: string;
      projectName: string;
      trackingStatusId: string;
      fromStatus: 'Ready';
      toStatus: 'Pending';
      ownerWorkHistoryId: string | null;
      amphoeId: string | null;
      agencyId: string | null;
      projectKind: 'main';
      planName: string | null;
      occurredAt: Date;
      actorUserId: string | null;
      actorWorkHistoryId: string | null;
    }> = [];

    for (const projectId of dto.projectIds) {
      try {
        const emit = await this.dataSource.transaction(async (manager) => {
          // 5. Load target project — main plan (ProjectGroup) only.
          const projectGroup = await manager.findOne(ProjectGroup, {
            where: { id: projectId },
            relations: [
              'createdBy',
              'createdBy.amphoe',
              'createdBy.localAdministrativeOrganization',
              'developmentPlan',
              'amphoe',
            ],
          });
          if (!projectGroup) {
            throw new BulkSubmitRowError(
              'PROJECT_NOT_FOUND',
              `ProjectGroup with ID ${projectId} not found`,
            );
          }

          // 6. Ownership OR §4.2 same-org scope. The original `create()` path
          //    ALSO allows Pull_Back / Returned_For_Revision sources, but the
          //    bulk endpoint is RESTRICTED to Ready → Pending so the same-org
          //    branch is the only relevant one here. Owner is always allowed
          //    (an owner is by definition same-org). Per task §6.2 step 6.
          const projectCreatorWh = projectGroup.createdBy;
          if (!projectCreatorWh) {
            throw new BulkSubmitRowError(
              'OWNERSHIP_OR_SCOPE_MISMATCH',
              'ไม่พบข้อมูล WorkHistory ของผู้สร้างโครงการ',
            );
          }
          const isProjectAgency =
            projectCreatorWh.amphoe?.id === '3001' &&
            projectCreatorWh.localAdministrativeOrganization?.id === '3001027';

          if (isProjectAgency) {
            if (!isSubmitterAgency) {
              throw new BulkSubmitRowError(
                'OWNERSHIP_OR_SCOPE_MISMATCH',
                'คุณไม่มีสิทธิ์ส่งโครงการนี้ (ต้องเป็นผู้ใช้ประเภท Agency เดียวกัน)',
              );
            }
          } else {
            // LAO-origin project — submitter must be LAO + same LAO id.
            if (isSubmitterAgency) {
              throw new BulkSubmitRowError(
                'OWNERSHIP_OR_SCOPE_MISMATCH',
                'คุณไม่มีสิทธิ์ส่งโครงการนี้ (ต้องเป็นผู้ใช้ประเภท LAO เดียวกัน)',
              );
            }
            const requesterLaoId =
              submitterWh.localAdministrativeOrganization?.id;
            const projectCreatorLaoId =
              projectCreatorWh.localAdministrativeOrganization?.id;
            if (
              !requesterLaoId ||
              !projectCreatorLaoId ||
              requesterLaoId !== projectCreatorLaoId
            ) {
              throw new BulkSubmitRowError(
                'OWNERSHIP_OR_SCOPE_MISMATCH',
                'คุณไม่มีสิทธิ์ส่งโครงการนี้ (ต้องอยู่ในองค์กรปกครองส่วนท้องถิ่นเดียวกัน)',
              );
            }
          }

          // 7. Plan scope binding (§10).
          const dp = projectGroup.developmentPlan;
          if (!dp?.isLatest) {
            throw new BulkSubmitRowError(
              'PLAN_NOT_LATEST',
              'แผนพัฒนาฯ ไม่ใช่แผนปัจจุบัน',
            );
          }
          if (dp?.isBooked) {
            throw new BulkSubmitRowError(
              'PLAN_BOOKED',
              'แผนพัฒนาฯ ถูกรวมเล่มแล้ว',
            );
          }
          // PlanPhase open + matches submitter group. We use the SUBMITTER's
          // classification per the existing `create()` behavior (see
          // tracking-status.service.ts:505-509). Same-org scope ensures
          // submitter group matches project group.
          const openPhase = await manager.findOne(PlanPhase, {
            where: {
              developmentPlan: { id: dp.id },
              phaseType: isSubmitterAgency ? PhaseType.AGENCY : PhaseType.LAO,
              isOpen: true,
            },
          });
          if (!openPhase) {
            throw new BulkSubmitRowError(
              'PLAN_PHASE_NOT_OPEN',
              'ระยะเวลายื่นโครงการปิดแล้ว ไม่สามารถส่งโครงการได้',
            );
          }

          // 9. Current latest status MUST be 'Ready'. Re-read inside the
          //    transaction (concurrency rule per task §6.5) — if a peer
          //    actor flipped this row to Pull_Back/Pending between request
          //    arrival and now, this read will surface it.
          const currentTracking = await manager.findOne(TrackingStatus, {
            where: { projectGroupId: { id: projectGroup.id }, isLatest: true },
            relations: ['statusId'],
          });
          const currentStatusName = currentTracking?.statusId?.name ?? '';
          if (currentStatusName !== 'Ready') {
            throw new BulkSubmitRowError(
              'STATUS_NOT_READY',
              `ไม่สามารถส่งโครงการได้จากสถานะ "${currentStatusName}" (ต้องอยู่ในสถานะ Ready)`,
            );
          }

          // 10. Lineage lock (§14). Ready-state projects rarely have
          //     descendants but we enforce uniformly per CLAUDE.md §14.5
          //     (no role exemption) and §14.9 (guard before write).
          await this.lineageLockService.assertEditable(
            projectGroup.id,
            'original',
            manager,
          );

          // 11. Transition + Audit (§12). Flip prior latest, insert new
          //     Pending row marked isLatest=true.
          await manager.update(
            TrackingStatus,
            { projectGroupId: { id: projectGroup.id } },
            { isLatest: false },
          );

          const tracking = manager.create(TrackingStatus, {
            createdBy: submitterWh,
            projectGroupId: projectGroup,
            statusId: pendingStatus,
            // Owner-scoped path — staffRemark is always null per CLAUDE.md §3.
            staffRemark: null,
            isLatest: true,
          });
          const savedTracking = await manager.save(TrackingStatus, tracking);

          // 12. Build BulkSubmitEmit. Pushed by the OUTER `try` after the
          //     sub-tx commits successfully (we return the descriptor so
          //     it is only collected on commit).
          return {
            projectId: projectGroup.id,
            projectName: projectGroup.title ?? '',
            trackingStatusId: savedTracking.id,
            fromStatus: 'Ready' as const,
            toStatus: 'Pending' as const,
            ownerWorkHistoryId: projectGroup.createdBy?.id ?? null,
            amphoeId: projectGroup.amphoe?.id ?? null,
            agencyId: null,
            projectKind: 'main' as const,
            planName: projectGroup.developmentPlan?.name ?? null,
            occurredAt: new Date(),
            actorUserId: submitterWh.user?.id ?? null,
            actorWorkHistoryId: submitterWh.id ?? null,
          };
        });

        bulkEmits.push(emit);
        results.push({ projectId, ok: true });
      } catch (err) {
        if (err instanceof BulkSubmitRowError) {
          results.push({
            projectId,
            ok: false,
            error: err.message,
            errorCode: err.code,
          });
          continue;
        }
        // Lineage lock surfaces ConflictException with PROJECT_HAS_DESCENDANT
        // prefix per CLAUDE.md §14.9. Map to the canonical row error code.
        if (
          err instanceof ConflictException &&
          typeof err.message === 'string' &&
          err.message.includes('PROJECT_HAS_DESCENDANT')
        ) {
          results.push({
            projectId,
            ok: false,
            error: err.message,
            errorCode: 'PROJECT_HAS_DESCENDANT',
          });
          continue;
        }
        // Unknown failure — log and surface a generic INTERNAL_ERROR for the
        // row. We DO NOT rethrow so peers can still complete (partial-success
        // contract). The detailed error is in the server log.
        this.logger.warn(
          `[bulkSubmit] project=${projectId} unexpected-error err=${(err as Error).message}`,
        );
        results.push({
          projectId,
          ok: false,
          error: 'เกิดข้อผิดพลาดภายในระบบ',
          errorCode: 'INTERNAL_ERROR',
        });
      }
    }

    // --- POST-COMMIT notification dispatch -----------------------------------
    // W105 BE-PR2 — delegate to the digest dispatcher. The dispatcher groups
    // emits by `(recipientUserId, eventType)` and:
    //   - emits ONE digest job per group when group.projects.length >= 2
    //   - falls back to per-project events when group.projects.length === 1
    // This collapses the previous N×K×2 fanout into 2K + 2 jobs for the
    // typical bulk submit (K staff-leads + 1 owner). The dispatcher itself
    // is fully try/catch'd so a notification-side failure cannot propagate
    // to this caller (§4.1, §17.2 advisory boundary).
    //
    // Pulling actorUserId / actorWorkHistoryId from the FIRST emit is
    // safe — `bulkSubmit` runs all per-project sub-transactions under the
    // same submitter WorkHistory, so the actor is uniform across emits.
    if (bulkEmits.length > 0) {
      const actorUserId = bulkEmits[0].actorUserId;
      const actorWorkHistoryId = bulkEmits[0].actorWorkHistoryId;
      await this.digestDispatcher.dispatchBulkSubmitNotifications({
        emits: bulkEmits,
        projectKind: 'project-group',
        actorUserId,
        actorWorkHistoryId,
      });
    }

    return { results };
  }

  async createManyRevisedProjectGroup(dtos: CreateTrackingStatusDto[], userId: string) {
    try {
      const workHistory = await this.workHistoryRepo.findOne({
        where: { user: { id: userId }, isCurrent: true },
        // Wave 22 B1 — eager-load `user` so actorUserId can be threaded onto
        // the post-commit notification emit audit rows.
        relations: ['role', 'workStatus', 'user'],
      });

      if (!workHistory) {
        throw new NotFoundException(`WorkHistory for user ${userId} not found`);
      }
      if (workHistory.workStatus?.name !== 'approved') {
        throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)');
      }

      // Staff-led only: this endpoint is restricted to staff/admin/super-admin
      const allowedRoles = ['staff', 'admin', 'super-admin'];
      const userRole = workHistory.role?.name;
      if (!allowedRoles.includes(userRole)) {
        throw new ForbiddenException('เฉพาะเจ้าหน้าที่ (staff/admin/super-admin) เท่านั้นที่สามารถใช้งาน endpoint นี้ได้');
      }

      // Strict transition map (CLAUDE.md §3)
      const staffAllowedTransitions: Record<string, string> = {
        Pending: 'Verified',
        Verified: 'Pending_Approval',
        Pending_Approval: 'Approved',
      };

      // Wave 21 N4 — collect post-commit emit descriptors for RPG bulk.
      type BulkRpgEmitCtx = {
        fromStatus: string;
        toStatus: string;
        projectId: string;
        projectTitle: string;
        responsibleAgencyId: string | null;
        createdByWorkHistoryId: string | null;
        planName: string | null;
        reason: string | null;
        // Wave 22 B1 — workflow-actor threading.
        actorUserId: string | null;
        actorWorkHistoryId: string | null;
      };
      const bulkRpgEmits: BulkRpgEmitCtx[] = [];

      const results = await this.dataSource.transaction(async (manager) => {
        const inner: TrackingStatus[] = [];

        for (const dto of dtos) {
          const { projectId, statusId } = dto;

          // Load RPG with DPR + parent DPlan scope
          const revisedProjectGroup = await manager.findOne(RevisedProjectGroup, {
            where: { id: projectId },
            relations: [
              'developmentPlanRevision',
              'developmentPlanRevision.developmentPlan',
              'createdBy',
              'responsibleAgency',
            ],
          });
          if (!revisedProjectGroup) {
            throw new NotFoundException(`RevisedProjectGroup with ID ${projectId} not found`);
          }

          const targetStatus = await manager.findOne(Status, { where: { id: statusId } });
          if (!targetStatus) {
            throw new NotFoundException(`Status with ID ${statusId} not found`);
          }

          const dpr = revisedProjectGroup.developmentPlanRevision;

          // Validate DPR scope: DPR must be latest and not yet assembled (staff bulk transition)
          // DPR.isOpen is NOT a gate for staff. DevelopmentPlan.isBooked is NOT a gate for staff.
          if (!dpr?.isLatest) {
            throw new ForbiddenException(`รอบการแก้ไข/เปลี่ยนแปลงนี้ไม่ใช่รอบปัจจุบัน (โครงการ ID: ${projectId})`);
          }
          if (dpr?.isBooked) {
            throw new ForbiddenException(`รอบการแก้ไข/เปลี่ยนแปลงถูกรวมเล่มแล้ว (โครงการ ID: ${projectId})`);
          }

          // Load and validate current TrackingStatus
          const currentTracking = await manager.findOne(TrackingStatus, {
            where: { revisedProjectGroupId: { id: projectId }, isLatest: true },
            relations: ['statusId'],
          });
          if (!currentTracking) {
            throw new BadRequestException(`ไม่พบสถานะปัจจุบันของโครงการ ID: ${projectId}`);
          }
          const currentStatusName = currentTracking.statusId?.name;
          if (!currentStatusName) {
            throw new BadRequestException(`ไม่สามารถอ่านสถานะปัจจุบันของโครงการ ID: ${projectId}`);
          }

          // Enforce strict transition map
          const allowedDestination = staffAllowedTransitions[currentStatusName];
          if (!allowedDestination || allowedDestination !== targetStatus.name) {
            throw new ForbiddenException(
              `ไม่อนุญาตให้เปลี่ยนสถานะจาก "${currentStatusName}" เป็น "${targetStatus.name}" ` +
              `(โครงการ ID: ${projectId}, เส้นทางที่อนุญาต: ${currentStatusName} → ${allowedDestination ?? 'ไม่มี'})`,
            );
          }

          // Commit transition
          await manager.update(
            TrackingStatus,
            { revisedProjectGroupId: { id: projectId } },
            { isLatest: false },
          );

          // createManyRevisedProjectGroup is staff-only (enforced above); staffRemark is always eligible.
          const tracking = manager.create(TrackingStatus, {
            createdBy: workHistory,
            revisedProjectGroupId: { id: projectId },
            statusId: { id: statusId },
            staffRemark: dto.staffRemark ?? null,
            isLatest: true,
          });

          const savedTracking = await manager.save(TrackingStatus, tracking);
          inner.push(savedTracking);

          bulkRpgEmits.push({
            fromStatus: currentStatusName,
            toStatus: targetStatus.name,
            projectId: revisedProjectGroup.id,
            projectTitle: revisedProjectGroup.title ?? '',
            responsibleAgencyId: revisedProjectGroup.responsibleAgency?.id ?? null,
            createdByWorkHistoryId: revisedProjectGroup.createdBy?.id ?? null,
            planName: dpr?.developmentPlan?.name ?? null,
            reason: dto.staffRemark ?? null,
            actorUserId: workHistory.user?.id ?? null,
            actorWorkHistoryId: workHistory.id ?? null,
          });
        }

        return inner;
      });

      // POST-COMMIT emits — RPG bulk. W94: multi-event per transition.
      for (const ctx of bulkRpgEmits) {
        const eventTypes = this.resolveNotificationEventTypes(ctx.fromStatus, ctx.toStatus);
        for (const eventType of eventTypes) {
          await this.dispatchPhaseOneNotification({
            eventType,
            fromStatus: ctx.fromStatus,
            toStatus: ctx.toStatus,
            projectId: ctx.projectId,
            projectKind: 'revised-project-group',
            projectTitle: ctx.projectTitle,
            projectResponsibleAgencyId: ctx.responsibleAgencyId,
            createdByWorkHistoryId: ctx.createdByWorkHistoryId,
            reason: ctx.reason,
            planName: ctx.planName,
            actorUserId: ctx.actorUserId,
            actorWorkHistoryId: ctx.actorWorkHistoryId,
          });
        }
      }

      return results;
    } catch (error) {
      handleException(this.logger, error);
    }
  }


  async findAll(): Promise<TrackingStatus[]> {
    try {
      const rows = await this.trackingStatusRepo.find({
        relations: [
          'createdBy',
          // W100 PR3 — load actor User so it can be decrypt-then-masked at
          // the response boundary. Without `createdBy.user` the FE has no
          // actor identity to render; with it, ciphertext would otherwise
          // leak (§17.11 forbids reveal here — Pattern 3 mask everywhere).
          'createdBy.user',
          'deletedBy',
          'deletedBy.user',
          'projectGroupId',
          'statusId',
          'comments',
        ],
      });
      await this.maskActorUsersOnTracking(rows);
      return rows;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<TrackingStatus> {
    try {
      const tracking = await this.trackingStatusRepo.findOne({
        where: { id },
        relations: [
          'createdBy',
          // W100 PR3 — see findAll() comment on actor User loading.
          'createdBy.user',
          'deletedBy',
          'deletedBy.user',
          'projectGroupId',
          'statusId',
          'comments',
        ],
      });
      if (!tracking) {
        throw new NotFoundException(`Tracking status with ID ${id} not found`);
      }
      await this.maskActorUsersOnTracking(tracking);
      return tracking;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(
    id: string,
    dto: UpdateTrackingStatusDto,
    userId: string,
  ): Promise<{ message: string; data: TrackingStatus }> {
    try {
      const workHistory = await this.workHistoryRepo.findOne({
        where: { user: { id: userId }, isCurrent: true },
        relations: ['role', 'workStatus'],
      });
      if (!workHistory) throw new NotFoundException('WorkHistory not found');
      if (workHistory.workStatus?.name !== 'approved') {
        throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)');
      }
      if (!['admin', 'super-admin'].includes(workHistory.role?.name)) {
        throw new ForbiddenException('เฉพาะ admin หรือ super-admin เท่านั้นที่สามารถแก้ไข TrackingStatus ได้');
      }

      const tracking = await this.trackingStatusRepo.findOne({ where: { id } });
      if (!tracking) {
        throw new NotFoundException(`Tracking status with ID ${id} not found`);
      }
      if (dto.statusId) {
        const status = await this.statusRepo.findOne({
          where: { id: dto.statusId },
        });
        if (!status)
          throw new NotFoundException(
            `Status with ID ${dto.statusId} not found`,
          );
        tracking.statusId = status;
      }
      // staffRemark is write-once: it MUST NOT be mutated after creation.
      // Explicitly ignore any staffRemark value from the update DTO.
      // CLAUDE.md §12 (Audit Rule): audit fields must remain immutable after recording.
      const updated = await this.trackingStatusRepo.save(tracking);
      return {
        message: 'Tracking status updated successfully',
        data: updated,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async softRemove(id: string, userId: string): Promise<{ message: string }> {
    try {
      const workHistory = await this.workHistoryRepo.findOne({
        where: { user: { id: userId }, isCurrent: true },
        relations: ['role', 'workStatus'],
      });
      if (!workHistory) throw new NotFoundException('WorkHistory not found');
      if (workHistory.workStatus?.name !== 'approved') {
        throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)');
      }
      if (!['admin', 'super-admin'].includes(workHistory.role?.name)) {
        throw new ForbiddenException('เฉพาะ admin หรือ super-admin เท่านั้นที่สามารถลบ TrackingStatus ได้');
      }

      const tracking = await this.trackingStatusRepo.findOne({ where: { id } });
      if (!tracking) {
        throw new NotFoundException(`Tracking status with ID ${id} not found`);
      }
      tracking.deletedBy = workHistory;
      await this.trackingStatusRepo.save(tracking);
      await this.trackingStatusRepo.softRemove(tracking);
      return {
        message: `Tracking status ${id} removed successfully`,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async restore(
    id: string,
    userId: string,
  ): Promise<{ message: string; data: TrackingStatus }> {
    try {
      const workHistory = await this.workHistoryRepo.findOne({
        where: { user: { id: userId }, isCurrent: true },
        relations: ['role', 'workStatus'],
      });
      if (!workHistory) throw new NotFoundException('WorkHistory not found');
      if (workHistory.workStatus?.name !== 'approved') {
        throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)');
      }
      if (!['admin', 'super-admin'].includes(workHistory.role?.name)) {
        throw new ForbiddenException('เฉพาะ admin หรือ super-admin เท่านั้นที่สามารถกู้คืน TrackingStatus ได้');
      }

      await this.trackingStatusRepo.restore(id);
      const restoredTracking = await this.trackingStatusRepo.findOne({
        where: { id },
        relations: [
          'createdBy',
          // W100 PR3 — Cluster B3 also covers the restore response.
          // Load actor User chain so masking can run before return.
          'createdBy.user',
          'deletedBy',
          'deletedBy.user',
          'projectGroupId',
          'statusId',
          'comments',
        ],
      });
      if (!restoredTracking) {
        throw new NotFoundException(
          `Tracking status with ID ${id} not found after restore`,
        );
      }
      await this.maskActorUsersOnTracking(restoredTracking);
      return {
        message: `Tracking status ${id} restored successfully`,
        data: restoredTracking,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async createByRevisedProjectGroup(dto: CreateTrackingStatusDto, userId: string): Promise<TrackingStatus> {
    try {
      // Wave 21 N4 — capture context for post-commit notification emit (see
      // the equivalent block in create() above for the rationale).
      type TxResult = {
        saved: TrackingStatus;
        fromStatus: string;
        toStatus: string;
        project: {
          id: string;
          title: string;
          responsibleAgencyId: string | null;
          createdByWorkHistoryId: string | null;
          planName: string | null;
        };
        // Wave 22 B1 — workflow-actor threading.
        actorUserId: string | null;
        actorWorkHistoryId: string | null;
      };
      const txResult = await this.dataSource.transaction<TxResult>(async (manager) => {
        // 1-3. WorkHistory + workStatus
        const workHistory = await manager.findOne(WorkHistory, {
          where: { user: { id: userId }, isCurrent: true },
          relations: ['user', 'role', 'workStatus', 'amphoe', 'localAdministrativeOrganization'],
        });
        if (!workHistory) {
          throw new NotFoundException(`WorkHistory for user ${userId} not found`);
        }
        if (workHistory.workStatus?.name !== 'approved') {
          throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)');
        }

        // 4. Load RevisedProjectGroup with revision scope
        const revisedProjectGroup = await manager.findOne(RevisedProjectGroup, {
          where: { id: dto.projectId },
          relations: ['createdBy', 'developmentPlanRevision', 'developmentPlanRevision.developmentPlan', 'responsibleAgency'],
        });
        if (!revisedProjectGroup) {
          throw new NotFoundException(`RevisedProjectGroup with ID ${dto.projectId} not found`);
        }

        // หา status
        const status = await manager.findOne(Status, {
          where: { id: dto.statusId },
        });
        if (!status) {
          throw new NotFoundException(`Status with ID ${dto.statusId} not found`);
        }

        // --- RBAC & Ownership Check ---
        const allowedRoles = ['staff', 'admin', 'super-admin'];
        const userRole = workHistory.role?.name;

        if (!allowedRoles.includes(userRole)) {
          if (userRole === 'user') {
            // 5. Ownership (CLAUDE.md §4)
            if (revisedProjectGroup.createdBy?.id !== workHistory.id) {
              throw new ForbiddenException('คุณไม่มีสิทธิ์ในการเปลี่ยนสถานะโครงการนี้');
            }

            // Agency classification: only agency users may perform revision/change workflow actions
            // per CLAUDE.md §3, workflow-revision §User Constraint, workflow-change §User Constraint
            const isAgency = workHistory.amphoe?.id === '3001' && workHistory.localAdministrativeOrganization?.id === '3001027';
            if (!isAgency) {
              throw new ForbiddenException('เฉพาะผู้ใช้ประเภท Agency เท่านั้นที่สามารถดำเนินการในขั้นตอนการแก้ไข/เปลี่ยนแปลงได้');
            }

            // 7. Revision scope: DPR must be open
            const dpr = revisedProjectGroup.developmentPlanRevision;
            if (!dpr?.isOpen) {
              throw new BadRequestException('รอบการแก้ไข/เปลี่ยนแปลงปิดแล้ว ไม่สามารถดำเนินการได้');
            }

            // DPR parent DevelopmentPlan scope (CLAUDE.md §10, workflow-revision §Workflow Scope Validation)
            const dprDp = dpr.developmentPlan;
            if (!dprDp?.isLatest) {
              throw new BadRequestException('แผนพัฒนาฯ ที่อ้างอิงโดยรอบการแก้ไขไม่ใช่แผนปัจจุบัน ไม่สามารถดำเนินการได้');
            }
            if (dprDp?.isBooked) {
              throw new BadRequestException('แผนพัฒนาฯ ที่อ้างอิงโดยรอบการแก้ไขถูกรวมเล่มแล้ว ไม่สามารถดำเนินการได้');
            }

            // 8-9. Current status + allowed transitions
            const currentTracking = await manager.findOne(TrackingStatus, {
              where: { revisedProjectGroupId: { id: revisedProjectGroup.id }, isLatest: true },
              relations: ['statusId'],
            });
            const currentStatusName = currentTracking?.statusId?.name;

            if (status.name === 'Pull_Back') {
              if (currentStatusName !== 'Pending' && currentStatusName !== 'Verified') {
                throw new BadRequestException(`ไม่สามารถดึงกลับได้จากสถานะ "${currentStatusName}"`);
              }
            } else if (status.name === 'Pending') {
              // Resubmit allowed from Pull_Back or Returned_For_Revision (CLAUDE.md §Returned_For_Revision Rule, task §7.1)
              if (currentStatusName !== 'Pull_Back' && currentStatusName !== 'Returned_For_Revision') {
                throw new BadRequestException(`ไม่สามารถส่งใหม่ได้จากสถานะ "${currentStatusName}" (ต้องอยู่ในสถานะ Pull_Back หรือ Returned_For_Revision)`);
              }
            } else {
              throw new ForbiddenException('คุณไม่มีสิทธิ์ในการเปลี่ยนสถานะโครงการนี้ (อนุญาตเฉพาะ Pull_Back และ Pending เท่านั้น)');
            }
          } else {
            throw new ForbiddenException('คุณไม่มีสิทธิ์ในการเปลี่ยนสถานะโครงการ');
          }
        } else {
          // Staff / Admin / Super-Admin branch for RevisedProjectGroup
          // Per CLAUDE.md §3 + §4.1: staff must validate current status and transition rules.
          // Ownership is NOT required for staff-controlled workflow transitions.
          // Valid staff transitions: Pending → Verified/Returned_For_Revision,
          //   Verified → Pending_Approval/Returned_For_Revision, Pending_Approval → Approved

          // Validate DPR scope: DPR must be latest and not yet assembled
          // Per corrected domain: staff transitions are gated by DPR.isLatest + DPR.isBooked only.
          // DPR.isOpen is NOT a gate for staff (staff may review after submission window closes).
          // DevelopmentPlan.isBooked is NOT a gate for staff (main plan being booked is expected).
          const staffDpr = revisedProjectGroup.developmentPlanRevision;
          if (!staffDpr?.isLatest) {
            throw new ForbiddenException('รอบการแก้ไข/เปลี่ยนแปลงนี้ไม่ใช่รอบปัจจุบัน ไม่สามารถดำเนินการได้');
          }
          if (staffDpr?.isBooked) {
            throw new ForbiddenException('รอบการแก้ไข/เปลี่ยนแปลงถูกรวมเล่มแล้ว ไม่สามารถดำเนินการได้');
          }

          // Area responsibility check for staff role (CLAUDE.md STAFF-LED ROLLBACK RULE §Area Responsibility)
          // Staff must be responsible for the responsibleAgency of the revised project.
          // Admin and super-admin bypass this check.
          if (userRole === 'staff') {
            const projectAgencyId = revisedProjectGroup.responsibleAgency?.id;
            if (!projectAgencyId) {
              throw new BadRequestException('โครงการนี้ยังไม่มีการกำหนดหน่วยงานรับผิดชอบ ไม่สามารถตรวจสอบสิทธิ์ได้');
            }
            const hasResponsibility = await manager.findOne(WorkHistoryGovernmentAgencyResponsibility, {
              where: {
                workHistory: { id: workHistory.id },
                governmentAgency: { id: projectAgencyId },
              },
            });
            if (!hasResponsibility) {
              throw new ForbiddenException('คุณไม่มีสิทธิ์ดำเนินการกับโครงการนี้ (ไม่ได้รับผิดชอบหน่วยงานของโครงการ)');
            }
          }

          // Load current latest TrackingStatus to enforce transition rules
          const staffCurrentTracking = await manager.findOne(TrackingStatus, {
            where: { revisedProjectGroupId: { id: revisedProjectGroup.id }, isLatest: true },
            relations: ['statusId'],
          });
          if (!staffCurrentTracking) {
            throw new InternalServerErrorException(
              'ไม่พบสถานะปัจจุบันของโครงการ ข้อมูลสถานะอาจไม่สมบูรณ์',
            );
          }
          const staffCurrentStatusName = staffCurrentTracking.statusId?.name;
          if (!staffCurrentStatusName) {
            throw new InternalServerErrorException(
              'ไม่สามารถอ่านชื่อสถานะปัจจุบันของโครงการได้ ข้อมูล statusId อาจไม่สมบูรณ์',
            );
          }

          // Strict staff transition map: array-valued to support multiple destinations
          // Pending/Verified may go to Returned_For_Revision (CLAUDE.md §Returned_For_Revision Rule)
          const staffAllowedTransitions: Record<string, string[]> = {
            Pending: ['Verified', 'Returned_For_Revision'],
            Verified: ['Pending_Approval', 'Returned_For_Revision'],
            Pending_Approval: ['Approved'],
          };
          const allowedDestinations = staffAllowedTransitions[staffCurrentStatusName];
          if (!allowedDestinations || !allowedDestinations.includes(status.name)) {
            throw new ForbiddenException(
              `ไม่อนุญาตให้เปลี่ยนสถานะจาก "${staffCurrentStatusName}" เป็น "${status.name}" ` +
              `(เส้นทางที่อนุญาต: ${staffCurrentStatusName} → ${allowedDestinations?.join(', ') ?? 'ไม่มี'})`,
            );
          }
        }
        // ------------------------------

        // อัปเดต oldAdditionDetail ใน RevisedProjectGroup ถ้ามีการส่งมา
        if (dto.oldAdditionDetail !== undefined) {
          revisedProjectGroup.oldAdditionDetail = dto.oldAdditionDetail;
          await manager.save(RevisedProjectGroup, revisedProjectGroup);
        }

        // Wave 21 N4 — capture fromStatus BEFORE flipping isLatest for the
        // post-commit notification emit.
        const emitFromTrackingRpg = await manager.findOne(TrackingStatus, {
          where: { revisedProjectGroupId: { id: revisedProjectGroup.id }, isLatest: true },
          relations: ['statusId'],
        });
        const emitFromStatusRpg = emitFromTrackingRpg?.statusId?.name ?? '';

        // อัปเดต TrackingStatus ตัวเก่าให้ isLatest = false
        await manager.update(TrackingStatus, {
          revisedProjectGroupId: { id: revisedProjectGroup.id },
        }, {
          isLatest: false,
        });

        // Resolve staffRemark for createByRevisedProjectGroup.
        // Only staff-lead roles may set this field; user role submissions are stripped to null.
        // CLAUDE.md §3 (Role Responsibilities), §12 (Audit Rule).
        const staffLeadRolesRpg = ['staff', 'admin', 'super-admin'];
        const resolvedStaffRemarkRpg = staffLeadRolesRpg.includes(workHistory.role?.name)
          ? (dto.staffRemark ?? null)
          : null;

        // สร้าง TrackingStatus ใหม่
        const tracking = manager.create(TrackingStatus, {
          createdBy: workHistory,
          revisedProjectGroupId: revisedProjectGroup,
          statusId: status,
          isLatest: true,
          comment: dto.comment,
          staffRemark: resolvedStaffRemarkRpg,
        });
        const savedTracking = await manager.save(TrackingStatus, tracking);

        if (dto.comments?.length) {
          const commentEntities = dto.comments.map((c) =>
            manager.create(Comment, {
              step: c.step,
              detail: c.detail,
              trackingStatusId: savedTracking,
            }),
          );
          await manager.save(Comment, commentEntities);
        }

        return {
          saved: savedTracking,
          fromStatus: emitFromStatusRpg,
          toStatus: status.name,
          project: {
            id: revisedProjectGroup.id,
            title: revisedProjectGroup.title ?? '',
            responsibleAgencyId: revisedProjectGroup.responsibleAgency?.id ?? null,
            createdByWorkHistoryId: revisedProjectGroup.createdBy?.id ?? null,
            planName:
              revisedProjectGroup.developmentPlanRevision?.developmentPlan?.name ?? null,
          },
          // Wave 22 B1 — workflow-actor threading.
          actorUserId: workHistory.user?.id ?? null,
          actorWorkHistoryId: workHistory.id ?? null,
        };
      });

      // POST-COMMIT Phase-1 notification emit (§4.1 guardrail). See create()
      // for the same pattern and rationale. W94: multi-event per transition.
      const eventTypes = this.resolveNotificationEventTypes(
        txResult.fromStatus,
        txResult.toStatus,
      );
      for (const eventType of eventTypes) {
        await this.dispatchPhaseOneNotification({
          eventType,
          fromStatus: txResult.fromStatus,
          toStatus: txResult.toStatus,
          projectId: txResult.project.id,
          projectKind: 'revised-project-group',
          projectTitle: txResult.project.title,
          projectResponsibleAgencyId: txResult.project.responsibleAgencyId,
          createdByWorkHistoryId: txResult.project.createdByWorkHistoryId,
          reason: dto.comment ?? dto.staffRemark ?? null,
          planName: txResult.project.planName,
          actorUserId: txResult.actorUserId,
          actorWorkHistoryId: txResult.actorWorkHistoryId,
        });
      }

      return txResult.saved;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async rollbackStatus(projectGroupId: string, userId: string, clearResponsibleAgency?: boolean): Promise<{ message: string; status: string }> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        // 1-2. Load WorkHistory + validate workStatus
        const workHistory = await manager.findOne(WorkHistory, {
          where: { user: { id: userId }, isCurrent: true },
          relations: ['role', 'workStatus', 'amphoe', 'localAdministrativeOrganization'],
        });
        if (!workHistory) throw new NotFoundException(`WorkHistory for user ${userId} not found`);
        if (workHistory.workStatus?.name !== 'approved') {
          throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)');
        }

        // 3. RBAC: Only staff / admin / super-admin may perform staff-led rollback (CLAUDE.md §4.1)
        const allowedRoles = ['staff', 'admin', 'super-admin'];
        const userRole = workHistory.role?.name;
        if (!allowedRoles.includes(userRole)) {
          throw new ForbiddenException('เฉพาะเจ้าหน้าที่ (staff/admin/super-admin) เท่านั้นที่สามารถดึงกลับโครงการได้');
        }

        // 4. Load project
        const projectGroup = await manager.findOne(ProjectGroup, {
          where: { id: projectGroupId },
          relations: ['createdBy', 'developmentPlan', 'responsibleAgency', 'amphoe'],
        });
        if (!projectGroup) throw new NotFoundException(`ProjectGroup with ID ${projectGroupId} not found`);

        // NOTE: responsibleAgency is eagerly loaded above for clearResponsibleAgency check

        // 5. Staff district (Amphoe) responsibility check
        //    Staff must be responsible for the project's Amphoe.
        //    Admin and super-admin bypass this check.
        if (userRole === 'staff') {
          const projectAmphoeId = projectGroup.amphoe?.id;
          if (!projectAmphoeId) {
            throw new BadRequestException('โครงการนี้ไม่มีข้อมูลอำเภอ ไม่สามารถตรวจสอบสิทธิ์ได้');
          }
          const hasResponsibility = await manager.findOne(WorkHistoryAmphoeResponsibility, {
            where: {
              workHistory: { id: workHistory.id },
              amphoe: { id: projectAmphoeId },
            },
          });
          if (!hasResponsibility) {
            throw new ForbiddenException('คุณไม่มีสิทธิ์ดึงกลับโครงการนี้ (ไม่ได้รับผิดชอบอำเภอของโครงการ)');
          }
        }

        // 6. Plan scope validation
        const dp = projectGroup.developmentPlan;
        if (!dp?.isLatest) throw new BadRequestException('แผนพัฒนาฯ ไม่ใช่แผนปัจจุบัน');
        if (dp?.isBooked) throw new BadRequestException('แผนพัฒนาฯ ถูกรวมเล่มแล้ว');

        // 6.5 CLAUDE.md §14 — Version Lineage Immutability.
        // A main-plan ProjectGroup that already has a non-deleted
        // RevisedProjectGroup descendant (prev_project_type = 'original')
        // cannot be rolled back. The guard rejects a non-leaf lineage.
        // Because BE-04 now physically hard-deletes the rolled-back row at
        // the end of this transaction, we must guarantee upstream that the
        // row has no descendants at all.
        await this.lineageLockService.assertDeletable(projectGroupId, 'original', manager);

        // 7. Status constraint — cannot rollback from Pull_Back or Ready
        const currentTracking = await manager.findOne(TrackingStatus, {
          where: { projectGroupId: { id: projectGroupId }, isLatest: true },
          relations: ['statusId'],
        });
        if (!currentTracking) throw new NotFoundException('ไม่พบสถานะปัจจุบันของโครงการ');
        const currentStatusName = currentTracking.statusId?.name;
        const disallowedStatuses = ['Pull_Back', 'Ready'];
        if (disallowedStatuses.includes(currentStatusName)) {
          throw new BadRequestException(`ไม่สามารถดึงกลับได้จากสถานะ "${currentStatusName}"`);
        }

        // 8. Optional: clear responsibleAgency — LAO-origin projects only (CLAUDE.md §7.1, §7.2, §7.3)
        // Agency projects MUST NOT have this field cleared (CLAUDE.md §7.1).
        if (clearResponsibleAgency === true) {
          // R5-H2: Clearing is allowed ONLY when current status is Pending_Approval (CLAUDE.md §7.4)
          if (currentStatusName !== 'Pending_Approval') {
            throw new ForbiddenException('การล้างหน่วยงานรับผิดชอบทำได้เฉพาะเมื่อโครงการอยู่ในสถานะ Pending_Approval เท่านั้น (CLAUDE.md §7.4)');
          }

          const projectCreatorWorkHistory = await manager.findOne(WorkHistory, {
            where: { id: projectGroup.createdBy?.id },
            relations: ['amphoe', 'localAdministrativeOrganization'],
          });
          const isAgencyProject =
            projectCreatorWorkHistory?.amphoe?.id === '3001' &&
            projectCreatorWorkHistory?.localAdministrativeOrganization?.id === '3001027';
          if (isAgencyProject) {
            throw new ForbiddenException('ไม่สามารถล้าง responsibleAgency ของโครงการประเภท Agency ได้ (CLAUDE.md §7.1)');
          }
          if (projectGroup.responsibleAgency) {
            await manager.update(ProjectGroup, { id: projectGroupId }, { responsibleAgency: null as any });
          }
        }

        // 9. Find the previous status (most recent non-latest) — true rollback
        const previousTracking = await manager.findOne(TrackingStatus, {
          where: { projectGroupId: { id: projectGroupId }, isLatest: false },
          relations: ['statusId'],
          order: { createAt: 'DESC' },
        });
        if (!previousTracking?.statusId) {
          throw new BadRequestException('ไม่พบสถานะก่อนหน้า ไม่สามารถย้อนกลับได้');
        }

        // 10. True rollback: hard-delete current record, restore previous to latest
        await manager.delete(TrackingStatus, { id: currentTracking.id });
        await manager.update(TrackingStatus, { id: previousTracking.id }, { isLatest: true });

        // 11. CLAUDE.md §14.6 — Rollback Ghost-Descendant Fix (BEHAVIORAL CHANGE).
        // Hard-delete the rolled-back row itself so any upstream parent
        // unlocks automatically under §14. After this line completes, no
        // row in revised_project_groups may reference this projectGroupId
        // via (prev_project_id, prev_project_type) — the lineage-lock guard
        // above already confirmed no non-deleted descendants exist.
        //
        // The cascade FK on tracking_status.project_group_id will remove any
        // remaining tracking history rows (older non-latest entries). This is
        // the intentional rollback audit exception documented in §12 and the
        // STAFF-LED ROLLBACK RULE.
        await manager.delete(ProjectGroup, { id: projectGroupId });

        return { message: `ย้อนสถานะสำเร็จ (กลับไปเป็น "${previousTracking.statusId.name}")`, status: 'success' };
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async rollbackRevisionProjectGroupStatus(revisionProjectGroupId: string, userId: string, clearResponsibleAgency?: boolean): Promise<{ message: string; status: string }> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        // 1-2. Load WorkHistory + validate workStatus
        const workHistory = await manager.findOne(WorkHistory, {
          where: { user: { id: userId }, isCurrent: true },
          relations: ['role', 'workStatus', 'amphoe', 'localAdministrativeOrganization'],
        });
        if (!workHistory) throw new NotFoundException(`WorkHistory for user ${userId} not found`);
        if (workHistory.workStatus?.name !== 'approved') {
          throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)');
        }

        // 3. RBAC: Only staff / admin / super-admin may perform staff-led rollback (CLAUDE.md §4.1)
        const allowedRoles = ['staff', 'admin', 'super-admin'];
        const userRole = workHistory.role?.name;
        if (!allowedRoles.includes(userRole)) {
          throw new ForbiddenException('เฉพาะเจ้าหน้าที่ (staff/admin/super-admin) เท่านั้นที่สามารถดึงกลับโครงการได้');
        }

        // 4. Load RevisedProjectGroup with DPR scope (including parent DPlan for R5-H1)
        const revisionProjectGroup = await manager.findOne(RevisedProjectGroup, {
          where: { id: revisionProjectGroupId },
          relations: ['createdBy', 'developmentPlanRevision', 'developmentPlanRevision.developmentPlan', 'responsibleAgency'],
        });
        if (!revisionProjectGroup) {
          throw new NotFoundException(`RevisedProjectGroup with ID ${revisionProjectGroupId} not found`);
        }

        // 5. Staff government agency responsibility check
        //    Staff must be responsible for the responsibleAgency of the revised project.
        //    Admin and super-admin bypass this check.
        if (userRole === 'staff') {
          const projectAgencyId = revisionProjectGroup.responsibleAgency?.id;
          if (!projectAgencyId) {
            throw new BadRequestException('โครงการนี้ยังไม่มีการกำหนดหน่วยงานรับผิดชอบ ไม่สามารถตรวจสอบสิทธิ์ได้');
          }
          const hasResponsibility = await manager.findOne(WorkHistoryGovernmentAgencyResponsibility, {
            where: {
              workHistory: { id: workHistory.id },
              governmentAgency: { id: projectAgencyId },
            },
          });
          if (!hasResponsibility) {
            throw new ForbiddenException('คุณไม่มีสิทธิ์ดึงกลับโครงการนี้ (ไม่ได้รับผิดชอบหน่วยงานของโครงการ)');
          }
        }

        // 6. Validate DPR scope: DPR must be latest and not yet assembled (staff-led rollback)
        // DPR.isOpen is NOT a gate for staff rollback. DevelopmentPlan.isBooked is NOT a gate for staff.
        const dpr = revisionProjectGroup.developmentPlanRevision;
        if (!dpr?.isLatest) {
          throw new BadRequestException('รอบการแก้ไข/เปลี่ยนแปลงนี้ไม่ใช่รอบปัจจุบัน ไม่สามารถดึงกลับได้');
        }
        if (dpr?.isBooked) {
          throw new BadRequestException('รอบการแก้ไข/เปลี่ยนแปลงถูกรวมเล่มแล้ว ไม่สามารถดึงกลับได้');
        }

        // 6.5 CLAUDE.md §14 — Version Lineage Immutability.
        // A RevisedProjectGroup that already has a non-deleted child
        // RevisedProjectGroup descendant (prev_project_type = 'revised')
        // cannot be rolled back. This replaces the former inline
        // `manager.exists(RevisedProjectGroup, ...)` check and delegates to
        // LineageLockService per §14.8.
        await this.lineageLockService.assertDeletable(revisionProjectGroupId, 'revised', manager);

        // 7. Status constraint — cannot rollback from Pull_Back or Ready
        const currentTracking = await manager.findOne(TrackingStatus, {
          where: { revisedProjectGroupId: { id: revisionProjectGroupId }, isLatest: true },
          relations: ['statusId'],
        });
        if (!currentTracking) throw new NotFoundException('ไม่พบสถานะปัจจุบันของโครงการ');
        const currentStatusName = currentTracking.statusId?.name;
        const disallowedStatuses = ['Pull_Back', 'Ready'];
        if (disallowedStatuses.includes(currentStatusName)) {
          throw new BadRequestException(`ไม่สามารถดึงกลับได้จากสถานะ "${currentStatusName}"`);
        }

        // 8. Optional: clear responsibleAgency for LAO-origin revised projects only (CLAUDE.md §7)
        if (clearResponsibleAgency === true) {
          // R5-H2: Clearing is allowed ONLY when current status is Pending_Approval (CLAUDE.md §7.4)
          if (currentStatusName !== 'Pending_Approval') {
            throw new ForbiddenException('การล้างหน่วยงานรับผิดชอบทำได้เฉพาะเมื่อโครงการอยู่ในสถานะ Pending_Approval เท่านั้น (CLAUDE.md §7.4)');
          }

          const projectCreatorWorkHistory = await manager.findOne(WorkHistory, {
            where: { id: revisionProjectGroup.createdBy?.id },
            relations: ['amphoe', 'localAdministrativeOrganization'],
          });
          const isAgencyProject =
            projectCreatorWorkHistory?.amphoe?.id === '3001' &&
            projectCreatorWorkHistory?.localAdministrativeOrganization?.id === '3001027';
          if (isAgencyProject) {
            throw new ForbiddenException('ไม่สามารถล้าง responsibleAgency ของโครงการประเภท Agency ได้ (CLAUDE.md §7.1)');
          }
          if (revisionProjectGroup.responsibleAgency) {
            await manager.update(RevisedProjectGroup, { id: revisionProjectGroupId }, { responsibleAgency: null as any });
          }
        }

        // 9. Find the previous status (most recent non-latest) — true rollback
        const previousTracking = await manager.findOne(TrackingStatus, {
          where: { revisedProjectGroupId: { id: revisionProjectGroupId }, isLatest: false },
          relations: ['statusId'],
          order: { createAt: 'DESC' },
        });
        if (!previousTracking?.statusId) {
          throw new BadRequestException('ไม่พบสถานะก่อนหน้า ไม่สามารถย้อนกลับได้');
        }

        // 10. True rollback: hard-delete current record, restore previous to latest
        await manager.delete(TrackingStatus, { id: currentTracking.id });
        await manager.update(TrackingStatus, { id: previousTracking.id }, { isLatest: true });

        // 11. CLAUDE.md §14.6 — Rollback Ghost-Descendant Fix (BEHAVIORAL CHANGE).
        // Hard-delete the rolled-back RevisedProjectGroup row itself so the
        // upstream parent (either a ProjectGroup or a previous
        // RevisedProjectGroup in the chain) unlocks automatically under §14.
        // The lineage-lock guard at step 6.5 already confirmed this row has
        // no non-deleted child descendants. The cascade FK on
        // tracking_status.revised_project_group_id removes any remaining
        // older tracking rows as part of the same transaction — the
        // intentional rollback audit exception (§12 + STAFF-LED ROLLBACK RULE).
        await manager.delete(RevisedProjectGroup, { id: revisionProjectGroupId });

        return { message: `ย้อนสถานะสำเร็จ (กลับไปเป็น "${previousTracking.statusId.name}")`, status: 'success' };
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  // ===========================================================================
  // SUPP-1 / BE-02 — SupplementProjectGroup (SPG) transition support.
  //
  // Mirrors the PG (`create`) and RPG (`createByRevisedProjectGroup`) shapes
  // above, with TWO structural differences:
  //   1. Scope binding (§6 of `workflow-add-project-supplement.md`):
  //        - parent DevelopmentPlan: isLatest=true, isBooked=false
  //        - DevelopmentPlanSupplement: isLatest=true, isOpen=true, isBooked=false
  //      Replaces the main-plan PlanPhase-open gate.
  //   2. Staff responsibility (Q3): AGENCY-BASED via
  //      WorkHistoryGovernmentAgencyResponsibility, NOT amphoe-based. Mirrors
  //      the RPG pattern.
  //
  // Pull_Back rules are Q4 verbatim parity with PG: allowed only from
  // `Pending` / `Verified`, owner-only against `workHistory.id`, no
  // responsibleAgency clearing (SPG is agency-origin → §7.1 + §9 of the
  // supplement workflow doc).
  //
  // Notifications are best-effort. SUPP-3 BE-06 wired SPG as a first-class
  // `projectKind = 'supplement-project-group'` discriminator; recipient
  // resolution still uses the RPG agency-based axis (Q3 —
  // `WorkHistoryGovernmentAgencyResponsibility`), and Thai copy reuses
  // PG/RPG templates with the head-noun substitution
  // ("โครงการ" → "โครงการเพิ่มเติม") per Q7. Failures NEVER block the
  // transaction (§4.1, §17.2).
  // ===========================================================================

  async createBySupplementProjectGroup(
    dto: CreateTrackingStatusDto,
    userId: string,
  ): Promise<TrackingStatus> {
    try {
      // Allow callers to supply the SPG id via the explicit
      // `supplementProjectGroupId` field OR via the legacy `projectId` mirror
      // (matches the RPG endpoint shape). Prefer explicit when both present.
      const spgId = dto.supplementProjectGroupId ?? dto.projectId;
      if (!spgId) {
        throw new BadRequestException(
          'ต้องระบุ supplementProjectGroupId หรือ projectId',
        );
      }

      type TxResult = {
        saved: TrackingStatus;
        fromStatus: string;
        toStatus: string;
        project: {
          id: string;
          title: string;
          responsibleAgencyId: string | null;
          createdByWorkHistoryId: string | null;
          planName: string | null;
        };
        actorUserId: string | null;
        actorWorkHistoryId: string | null;
      };

      const txResult = await this.dataSource.transaction<TxResult>(async (manager) => {
        // 1-3. WorkHistory + workStatus (CLAUDE.md validation order)
        const workHistory = await manager.findOne(WorkHistory, {
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
          throw new NotFoundException(`WorkHistory for user ${userId} not found`);
        }
        if (workHistory.workStatus?.name !== 'approved') {
          throw new UnauthorizedException(
            'คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)',
          );
        }

        // 4. Load target SPG with full scope chain.
        const spg = await manager.findOne(SupplementProjectGroup, {
          where: { id: spgId },
          relations: [
            'createdBy',
            'developmentPlanSupplement',
            'developmentPlanSupplement.developmentPlan',
            'responsibleAgency',
          ],
        });
        if (!spg) {
          throw new NotFoundException(
            `SupplementProjectGroup with ID ${spgId} not found`,
          );
        }

        // Resolve target Status.
        const status = await manager.findOne(Status, {
          where: { id: dto.statusId },
        });
        if (!status) {
          throw new NotFoundException(`Status with ID ${dto.statusId} not found`);
        }

        // --- RBAC & Ownership Check ---
        const allowedRoles = ['staff', 'admin', 'super-admin'];
        const userRole = workHistory.role?.name;

        if (!allowedRoles.includes(userRole)) {
          if (userRole === 'user') {
            // Current latest status — needed for both Pull_Back and Pending paths.
            const currentTracking = await manager.findOne(TrackingStatus, {
              where: {
                supplementProjectGroupId: { id: spg.id },
                isLatest: true,
              },
              relations: ['statusId'],
            });
            const currentStatusName: string =
              currentTracking?.statusId?.name ?? '';

            if (status.name === 'Pull_Back') {
              // Q4 — verbatim PG parity.
              // 5. Ownership against workHistory.id (CLAUDE.md §4).
              if (spg.createdBy?.id !== workHistory.id) {
                throw new ForbiddenException(
                  'คุณไม่มีสิทธิ์ในการเปลี่ยนสถานะโครงการนี้',
                );
              }
              // Pull_Back allowed only from Pending or Verified.
              if (
                currentStatusName !== 'Pending' &&
                currentStatusName !== 'Verified'
              ) {
                throw new BadRequestException(
                  `ไม่สามารถดึงกลับได้จากสถานะ "${currentStatusName}"`,
                );
              }
              // Scope: parent DevelopmentPlan + DevelopmentPlanSupplement
              // must be active and the supplement round must be OPEN.
              const dps = spg.developmentPlanSupplement;
              if (!dps) {
                throw new BadRequestException(
                  'ไม่พบรอบเพิ่มเติม (DevelopmentPlanSupplement) ของโครงการ',
                );
              }
              const dp = dps.developmentPlan;
              if (!dp?.isLatest) {
                throw new BadRequestException(
                  'แผนพัฒนาฯ ไม่ใช่แผนปัจจุบัน',
                );
              }
              // 2026-05-12 — DevelopmentPlan.isBooked is NOT a gate for
              // supplement actions; parent plan being booked is the
              // EXPECTED state for the supplement workflow (mirrors the
              // existing revision/change rationale).
              if (!dps.isLatest) {
                throw new BadRequestException(
                  'รอบเพิ่มเติมนี้ไม่ใช่รอบปัจจุบัน',
                );
              }
              if (dps.isBooked) {
                throw new BadRequestException(
                  'รอบเพิ่มเติมถูกรวมเล่มแล้ว',
                );
              }
              if (!dps.isOpen) {
                throw new BadRequestException(
                  'รอบเพิ่มเติมปิดแล้ว ไม่สามารถดึงกลับได้',
                );
              }
            } else if (status.name === 'Pending') {
              // Owner submission / resubmission to Pending.
              // Allowed source statuses match the PG path: Ready,
              // Pull_Back, Returned_For_Revision.
              const allowedSources = [
                'Ready',
                'Pull_Back',
                'Returned_For_Revision',
              ];
              if (!allowedSources.includes(currentStatusName)) {
                throw new BadRequestException(
                  `ไม่สามารถส่งโครงการได้จากสถานะ "${currentStatusName}" ` +
                    `(ต้องอยู่ในสถานะ Ready, Pull_Back หรือ Returned_For_Revision)`,
                );
              }

              // Ownership: SPG creator must match acting WorkHistory. SPG is
              // agency-origin only (§4.2 of supplement workflow), so the
              // PG-style "same-org" relaxation is not strictly needed; we
              // still enforce strict ownership for ALL resubmission sources
              // here for safety.
              if (spg.createdBy?.id !== workHistory.id) {
                throw new ForbiddenException(
                  'คุณไม่มีสิทธิ์ในการเปลี่ยนสถานะโครงการนี้',
                );
              }

              // Scope: parent plan + supplement round.
              const dps = spg.developmentPlanSupplement;
              if (!dps) {
                throw new BadRequestException(
                  'ไม่พบรอบเพิ่มเติม (DevelopmentPlanSupplement) ของโครงการ',
                );
              }
              const dp = dps.developmentPlan;
              if (!dp?.isLatest) {
                throw new BadRequestException(
                  'แผนพัฒนาฯ ไม่ใช่แผนปัจจุบัน',
                );
              }
              // 2026-05-12 — DevelopmentPlan.isBooked is NOT a gate for
              // supplement actions; parent plan being booked is the
              // EXPECTED state for the supplement workflow.
              if (!dps.isLatest) {
                throw new BadRequestException(
                  'รอบเพิ่มเติมนี้ไม่ใช่รอบปัจจุบัน',
                );
              }
              if (dps.isBooked) {
                throw new BadRequestException(
                  'รอบเพิ่มเติมถูกรวมเล่มแล้ว',
                );
              }
              if (!dps.isOpen) {
                throw new BadRequestException(
                  'รอบเพิ่มเติมปิดแล้ว ไม่สามารถส่งโครงการได้',
                );
              }
            } else {
              throw new ForbiddenException(
                'คุณไม่มีสิทธิ์ในการเปลี่ยนสถานะโครงการนี้ ' +
                  '(อนุญาตเฉพาะ Pull_Back และ Pending เท่านั้น)',
              );
            }
          } else {
            throw new ForbiddenException(
              'คุณไม่มีสิทธิ์ในการเปลี่ยนสถานะโครงการ',
            );
          }
        } else {
          // ----- Staff / Admin / Super-Admin branch (Q3) ------------------
          // Per CLAUDE.md §3 + §4.1 + supplement workflow §12: staff must
          // validate current status and transition rules; ownership is NOT
          // required.

          // Scope binding: parent plan + supplement round.
          const dps = spg.developmentPlanSupplement;
          if (!dps) {
            throw new ForbiddenException(
              'ไม่พบรอบเพิ่มเติมของโครงการ ไม่สามารถดำเนินการได้',
            );
          }
          const dp = dps.developmentPlan;
          if (!dp?.isLatest) {
            throw new ForbiddenException(
              'แผนพัฒนาฯ ที่เชื่อมโยงกับโครงการนี้ไม่ใช่แผนปัจจุบัน ไม่สามารถดำเนินการได้',
            );
          }
          // 2026-05-12 — DevelopmentPlan.isBooked is NOT a gate for
          // supplement actions; parent plan being booked is the EXPECTED
          // state for the supplement workflow (mirrors the existing
          // revision/change rationale).
          if (!dps.isLatest) {
            throw new ForbiddenException(
              'รอบเพิ่มเติมนี้ไม่ใช่รอบปัจจุบัน ไม่สามารถดำเนินการได้',
            );
          }
          if (dps.isBooked) {
            throw new ForbiddenException(
              'รอบเพิ่มเติมถูกรวมเล่มแล้ว ไม่สามารถดำเนินการได้',
            );
          }

          // Q3 — AGENCY-BASED responsibility check (mirrors RPG, NOT amphoe).
          // Admin and super-admin bypass.
          if (userRole === 'staff') {
            const projectAgencyId = spg.responsibleAgency?.id;
            if (!projectAgencyId) {
              throw new BadRequestException(
                'โครงการนี้ยังไม่มีการกำหนดหน่วยงานรับผิดชอบ ไม่สามารถตรวจสอบสิทธิ์ได้',
              );
            }
            const hasResponsibility = await manager.findOne(
              WorkHistoryGovernmentAgencyResponsibility,
              {
                where: {
                  workHistory: { id: workHistory.id },
                  governmentAgency: { id: projectAgencyId },
                },
              },
            );
            if (!hasResponsibility) {
              throw new ForbiddenException(
                'คุณไม่มีสิทธิ์ดำเนินการกับโครงการนี้ (ไม่ได้รับผิดชอบหน่วยงานของโครงการ)',
              );
            }
          }

          // Current latest TrackingStatus + strict transition map.
          const staffCurrentTracking = await manager.findOne(TrackingStatus, {
            where: {
              supplementProjectGroupId: { id: spg.id },
              isLatest: true,
            },
            relations: ['statusId'],
          });
          if (!staffCurrentTracking) {
            throw new InternalServerErrorException(
              'ไม่พบสถานะปัจจุบันของโครงการ ข้อมูลสถานะอาจไม่สมบูรณ์',
            );
          }
          const staffCurrentStatusName = staffCurrentTracking.statusId?.name;
          if (!staffCurrentStatusName) {
            throw new InternalServerErrorException(
              'ไม่สามารถอ่านชื่อสถานะปัจจุบันของโครงการได้ ข้อมูล statusId อาจไม่สมบูรณ์',
            );
          }

          // Same strict map as PG / RPG. Returned_For_Revision only from
          // Pending or Verified (CLAUDE.md §Returned_For_Revision Rule).
          const staffAllowedTransitions: Record<string, string[]> = {
            Pending: ['Verified', 'Returned_For_Revision'],
            Verified: ['Pending_Approval', 'Returned_For_Revision'],
            Pending_Approval: ['Approved'],
          };
          const allowedDestinations =
            staffAllowedTransitions[staffCurrentStatusName];
          if (
            !allowedDestinations ||
            !allowedDestinations.includes(status.name)
          ) {
            throw new ForbiddenException(
              `ไม่อนุญาตให้เปลี่ยนสถานะจาก "${staffCurrentStatusName}" เป็น "${status.name}" ` +
                `(เส้นทางที่อนุญาต: ${staffCurrentStatusName} → ${allowedDestinations?.join(', ') ?? 'ไม่มี'})`,
            );
          }
        }

        // Capture fromStatus BEFORE flipping isLatest for the post-commit
        // notification emit.
        const emitFromTracking = await manager.findOne(TrackingStatus, {
          where: {
            supplementProjectGroupId: { id: spg.id },
            isLatest: true,
          },
          relations: ['statusId'],
        });
        const emitFromStatus = emitFromTracking?.statusId?.name ?? '';

        // Transition + Audit (§12). Flip prior latest, insert new row.
        await manager.update(
          TrackingStatus,
          { supplementProjectGroupId: { id: spg.id } },
          { isLatest: false },
        );

        // Only staff-lead may set staffRemark. User submissions strip to null.
        const staffLeadRoles = ['staff', 'admin', 'super-admin'];
        const resolvedStaffRemark = staffLeadRoles.includes(
          workHistory.role?.name,
        )
          ? (dto.staffRemark ?? null)
          : null;

        const tracking = manager.create(TrackingStatus, {
          createdBy: workHistory,
          supplementProjectGroupId: spg,
          comment: dto.comment,
          staffRemark: resolvedStaffRemark,
          statusId: status,
          isLatest: true,
        });
        const savedTracking = await manager.save(TrackingStatus, tracking);

        if (dto.comments?.length) {
          const commentEntities = dto.comments.map((c) =>
            manager.create(Comment, {
              step: c.step,
              detail: c.detail,
              trackingStatusId: savedTracking,
            }),
          );
          await manager.save(Comment, commentEntities);
        }

        // Pull_Back announcement (reuse the existing announcement template;
        // notification copy substitution per Q7 happens at presentation time).
        if (status.name === 'Pull_Back') {
          try {
            const staffRole = await manager.findOne(Role, {
              where: { name: 'staff' },
            });
            if (staffRole) {
              await this.announcementsService.create(
                {
                  title: 'มีการขอดึงกลับโครงการเพิ่มเติม',
                  description:
                    `โครงการเพิ่มเติม "${spg.title}" ขอดึงกลับโดย ` +
                    `${workHistory.user?.firstname} ${workHistory.user?.lastname}`,
                  type: NotificationType.PROJECT,
                  status: AnnouncementStatus.PUBLISHED,
                  roleIds: [staffRole.id],
                },
                userId,
              );
            }
          } catch (err) {
            this.logger.error(
              'Failed to send SPG pull back announcement',
              err,
            );
          }
        }

        return {
          saved: savedTracking,
          fromStatus: emitFromStatus,
          toStatus: status.name,
          project: {
            id: spg.id,
            title: spg.title ?? '',
            responsibleAgencyId: spg.responsibleAgency?.id ?? null,
            createdByWorkHistoryId: spg.createdBy?.id ?? null,
            planName:
              spg.developmentPlanSupplement?.developmentPlan?.name ?? null,
          },
          actorUserId: workHistory.user?.id ?? null,
          actorWorkHistoryId: workHistory.id ?? null,
        };
      });

      // POST-COMMIT notification dispatch. Best-effort — wrapped in try/catch
      // inside `dispatchPhaseOneNotification`; a failure here MUST NOT
      // cascade into the workflow caller (§4.1, §17.2).
      //
      // SUPP-3 BE-06 — `projectKind: 'supplement-project-group'` replaces the
      // SUPP-1 BE-02 placeholder (`'revised-project-group'`). Recipient
      // resolution still routes through `resolveStaffLeadByAgency` (Q3 —
      // SPG staff responsibility is agency-based, same axis as RPG); the
      // kind discriminator drives the per-kind subject / altText
      // substitution ("โครงการเพิ่มเติม") and the supplement deep-link
      // (`/project/supplement/<id>`) per Q7 reuse-with-substitution. No new
      // notification template is registered (per §14 of the supplement
      // workflow doc).
      const eventTypes = this.resolveNotificationEventTypes(
        txResult.fromStatus,
        txResult.toStatus,
      );
      for (const eventType of eventTypes) {
        await this.dispatchPhaseOneNotification({
          eventType,
          fromStatus: txResult.fromStatus,
          toStatus: txResult.toStatus,
          projectId: txResult.project.id,
          // SUPP-3 BE-06 — first-class supplement kind. Replaces the
          // SUPP-1 BE-02 placeholder. See dispatch fn comment above.
          projectKind: 'supplement-project-group',
          projectTitle: txResult.project.title,
          projectResponsibleAgencyId: txResult.project.responsibleAgencyId,
          createdByWorkHistoryId: txResult.project.createdByWorkHistoryId,
          reason: dto.comment ?? dto.staffRemark ?? null,
          planName: txResult.project.planName,
          actorUserId: txResult.actorUserId,
          actorWorkHistoryId: txResult.actorWorkHistoryId,
        });
      }

      // SUPP-IA-03 (BE-β, 2026-05-12) — §17.4 baseline snapshot on
      // owner-driven submission. Any path that lands the SPG at
      // `Pending` from the owner court (Ready, Pull_Back, or
      // Returned_For_Revision) is an authoring-time submit per §17.4
      // Wave 11. Same-hash idempotency (Wave 10) collapses repeat fires
      // across resubmission cycles into a no-op. Best-effort + advisory
      // (§17.2): a snapshot failure logs and is swallowed; it MUST NOT
      // roll back the workflow transition (the tracking row has already
      // been committed at this point).
      if (txResult.toStatus === 'Pending') {
        await this.fireSpgBaselineSnapshot(userId, txResult.project.id);
      }

      return txResult.saved;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * SUPP-IA-03 (BE-β, 2026-05-12) — fire a §17.4 `no-ai-baseline`
   * snapshot for the SPG transitioning to `Pending` from the owner
   * court. Reads the saved SPG (with budgets + classification) from the
   * default manager and forwards to `PreSubmitSnapshotService` with
   * `result: null` (which forces the snapshot service to write the
   * baseline row).
   *
   * Contract:
   *   - `endpoint='no-ai-baseline'`, `staleness_policy='snapshot-only'`
   *   - `target_kind='supplement-project-group'`, `target_id=spg.id`
   *   - `workflow='add'`
   *   - Idempotency by `(target_kind, target_id, content_hash)` per
   *     Wave 10. A repeat fire with the same hash short-circuits in
   *     `PreSubmitSnapshotService.createSnapshot`.
   *
   * §17.2 advisory-only — a failure here is logged and swallowed. The
   * caller has already committed the tracking row; rolling back the
   * workflow transition because of an AI-table write failure would
   * violate §17.2.
   *
   * §17.3 audit separation — the snapshot row has no FK to SPG.
   */
  private async fireSpgBaselineSnapshot(
    userId: string,
    spgId: string,
  ): Promise<void> {
    try {
      const spg = await this.supplementProjectGroupRepo.findOne({
        where: { id: spgId },
        relations: [
          'developmentPlanSupplement',
          'developmentPlanSupplement.developmentPlan',
          'strategy',
          'tactic',
          'plan',
          'developmentIssue',
          'createdBy',
          'createdBy.amphoe',
          'createdBy.localAdministrativeOrganization',
        ],
      });
      if (!spg) {
        this.logger.warn(
          `[SUPP-IA-03 baseline] SPG ${spgId} not found post-commit; skipping snapshot.`,
        );
        return;
      }

      const budgets = await this.dataSource.getRepository(Budget).find({
        where: { supplementProjectGroupId: { id: spgId } as any },
      });

      // §16 — resolve the parent plan's format. Read-only.
      let reportFormat: ReportFormat;
      try {
        reportFormat =
          await this.bookFormatResolver.resolveBySupplementProjectGroup(
            spgId,
            this.dataSource.manager,
          );
      } catch (e) {
        // Defensive fallback — if format resolution fails, infer from
        // the row shape (§16.5). The snapshot is advisory either way.
        reportFormat = spg.developmentIssue
          ? ReportFormat.ISSUE_BASED
          : ReportFormat.STRATEGY_BASED;
        this.logger.warn(
          `[SUPP-IA-03 baseline] format resolve failed spgId=${spgId} ` +
            `fallback=${reportFormat} err=${(e as Error)?.message ?? 'unknown'}`,
        );
      }

      await this.preSubmitSnapshotService.createSnapshot(userId, {
        targetKind: 'supplement-project-group',
        targetId: spgId,
        workflow: 'add',
        // Null `result` → snapshot service writes the audit-baseline
        // row (no live AI invocation, no quota deduction).
        result: null,
        project: {
          title: spg.title ?? null,
          objective: spg.objective ?? null,
          goal: spg.goal ?? null,
          expected: spg.expected ?? null,
          indicator: spg.indicator ?? null,
          startLat: spg.startLat ?? null,
          startLng: spg.startLng ?? null,
          endLat: spg.endLat ?? null,
          endLng: spg.endLng ?? null,
          amphoeId: spg.createdBy?.amphoe?.id ?? null,
          localOrganizationId:
            spg.createdBy?.localAdministrativeOrganization?.id ?? null,
          budgets: budgets.map((b) => ({
            year: b.year,
            quantity: b.quantity ?? 0,
          })),
        },
        classification: {
          reportFormat:
            reportFormat === ReportFormat.ISSUE_BASED
              ? 'ISSUE_BASED'
              : 'STRATEGY_BASED',
          strategyName: spg.strategy?.name ?? null,
          tacticName: spg.tactic?.name ?? null,
          planName: spg.plan?.name ?? null,
          developmentIssueName: spg.developmentIssue?.name ?? null,
        },
        attachments: [],
      });
    } catch (err) {
      // §17.2 advisory — log and continue.
      this.logger.error(
        `[SUPP-IA-03 baseline] snapshot write failed spgId=${spgId} ` +
          `err=${(err as Error)?.message ?? 'unknown'}`,
      );
    }
  }

  /**
   * SUPP-1 / BE-02 — Staff-led rollback for SupplementProjectGroup.
   *
   * Mirrors `rollbackRevisionProjectGroupStatus` with two differences:
   *   1. Scope is the SPG's supplement chain (parent DevelopmentPlan +
   *      DevelopmentPlanSupplement), not a DevelopmentPlanRevision.
   *   2. Responsibility check is AGENCY-BASED (Q3, mirror of RPG).
   *
   * Per §14.6 the rolled-back SPG row is hard-deleted as the FINAL step of
   * the transaction. In SUPP-1 SPG is a leaf (no descendants possible
   * because `revised_project_groups.prev_project_type` enum lacks
   * `'supplement'`), so this is functionally a no-op for upstream unlock —
   * but the invariant is implemented now so SUPP-4 inherits a correct
   * foundation. See the TODO(SUPP-4) marker at the delete site.
   *
   * The `clearResponsibleAgency` flag is inapplicable to SPG because every
   * SPG is agency-origin (§9 of the supplement workflow). We silently
   * ignore it here (chosen branch — see workflow doc §12). A future
   * tightening could throw on `clearResponsibleAgency=true`; the silent
   * ignore preserves backward compatibility with shared client code.
   */
  async rollbackSupplementProjectGroupStatus(
    supplementProjectGroupId: string,
    userId: string,
    _clearResponsibleAgency?: boolean,
  ): Promise<{ message: string; status: string }> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        // 1-2. WorkHistory + workStatus.
        const workHistory = await manager.findOne(WorkHistory, {
          where: { user: { id: userId }, isCurrent: true },
          relations: ['role', 'workStatus'],
        });
        if (!workHistory) {
          throw new NotFoundException(
            `WorkHistory for user ${userId} not found`,
          );
        }
        if (workHistory.workStatus?.name !== 'approved') {
          throw new UnauthorizedException(
            'คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)',
          );
        }

        // 3. RBAC — staff-lead only.
        const allowedRoles = ['staff', 'admin', 'super-admin'];
        const userRole = workHistory.role?.name;
        if (!allowedRoles.includes(userRole)) {
          throw new ForbiddenException(
            'เฉพาะเจ้าหน้าที่ (staff/admin/super-admin) เท่านั้นที่สามารถดึงกลับโครงการได้',
          );
        }

        // 4. Load SPG with scope chain.
        const spg = await manager.findOne(SupplementProjectGroup, {
          where: { id: supplementProjectGroupId },
          relations: [
            'createdBy',
            'developmentPlanSupplement',
            'developmentPlanSupplement.developmentPlan',
            'responsibleAgency',
          ],
        });
        if (!spg) {
          throw new NotFoundException(
            `SupplementProjectGroup with ID ${supplementProjectGroupId} not found`,
          );
        }

        // 5. Q3 — AGENCY-BASED staff responsibility check. Admin/super-admin
        //    bypass.
        if (userRole === 'staff') {
          const projectAgencyId = spg.responsibleAgency?.id;
          if (!projectAgencyId) {
            throw new BadRequestException(
              'โครงการนี้ยังไม่มีการกำหนดหน่วยงานรับผิดชอบ ไม่สามารถตรวจสอบสิทธิ์ได้',
            );
          }
          const hasResponsibility = await manager.findOne(
            WorkHistoryGovernmentAgencyResponsibility,
            {
              where: {
                workHistory: { id: workHistory.id },
                governmentAgency: { id: projectAgencyId },
              },
            },
          );
          if (!hasResponsibility) {
            throw new ForbiddenException(
              'คุณไม่มีสิทธิ์ดึงกลับโครงการนี้ (ไม่ได้รับผิดชอบหน่วยงานของโครงการ)',
            );
          }
        }

        // 6. Scope binding — parent plan + supplement round must be active.
        //    Mirrors the RPG rollback gate (staff-led rollback does NOT gate
        //    on `isOpen`; supplement closure does not block staff data
        //    correction).
        const dps = spg.developmentPlanSupplement;
        if (!dps) {
          throw new BadRequestException(
            'ไม่พบรอบเพิ่มเติมของโครงการ ไม่สามารถดึงกลับได้',
          );
        }
        if (!dps.isLatest) {
          throw new BadRequestException(
            'รอบเพิ่มเติมนี้ไม่ใช่รอบปัจจุบัน ไม่สามารถดึงกลับได้',
          );
        }
        if (dps.isBooked) {
          throw new BadRequestException(
            'รอบเพิ่มเติมถูกรวมเล่มแล้ว ไม่สามารถดึงกลับได้',
          );
        }

        // 6.5 CLAUDE.md §14 — Version Lineage Immutability.
        // SUPP-1 leaf-case: SPG cannot have descendants today because
        // `revised_project_groups.prev_project_type` does not yet include
        // `'supplement'` (deferred to SUPP-4). LineageLockService therefore
        // has no `'supplement'` LineageProjectType — calling it would be a
        // type error. The guard is intentionally OMITTED here for SUPP-1
        // and MUST be added back in SUPP-4 once the enum is extended.
        // The rollback hard-delete below proceeds because no descendants
        // can exist.

        // 7. Status constraint — cannot rollback from Pull_Back or Ready.
        const currentTracking = await manager.findOne(TrackingStatus, {
          where: {
            supplementProjectGroupId: { id: supplementProjectGroupId },
            isLatest: true,
          },
          relations: ['statusId'],
        });
        if (!currentTracking) {
          throw new NotFoundException('ไม่พบสถานะปัจจุบันของโครงการ');
        }
        const currentStatusName = currentTracking.statusId?.name;
        const disallowedStatuses = ['Pull_Back', 'Ready'];
        if (disallowedStatuses.includes(currentStatusName)) {
          throw new BadRequestException(
            `ไม่สามารถดึงกลับได้จากสถานะ "${currentStatusName}"`,
          );
        }

        // 8. clearResponsibleAgency is inapplicable to SPG — every SPG is
        //    agency-origin (§9 of supplement workflow). The flag is silently
        //    ignored. Per §7.1 we MUST NOT clear the field on agency
        //    projects, so even if a future caller set the flag we will not
        //    act on it.
        void _clearResponsibleAgency;

        // 9. Find previous status (most recent non-latest).
        const previousTracking = await manager.findOne(TrackingStatus, {
          where: {
            supplementProjectGroupId: { id: supplementProjectGroupId },
            isLatest: false,
          },
          relations: ['statusId'],
          order: { createAt: 'DESC' },
        });
        if (!previousTracking?.statusId) {
          throw new BadRequestException(
            'ไม่พบสถานะก่อนหน้า ไม่สามารถย้อนกลับได้',
          );
        }

        // 10. True rollback — hard-delete current latest TrackingStatus,
        //     restore previous to isLatest=true. §12 audit exception.
        await manager.delete(TrackingStatus, { id: currentTracking.id });
        await manager.update(
          TrackingStatus,
          { id: previousTracking.id },
          { isLatest: true },
        );

        // 11. CLAUDE.md §14.6 — Rollback Ghost-Descendant Fix.
        // Hard-delete the rolled-back SPG row itself as the final step of
        // the transaction.
        //
        // TODO(SUPP-4): once SUPP-4 lands and
        // `revised_project_groups.prev_project_type='supplement'` becomes a
        // valid enum value, this hard-delete will also unlock upstream
        // supplement-rooted RPGs via the existing §14 lineage lock
        // semantics. In SUPP-1 through SUPP-3 SPG is a leaf (no
        // descendants possible), so the upstream-unlock effect is a
        // functional no-op — but the invariant is implemented now so the
        // SUPP-4 activation is a zero-code-change event. DO NOT remove
        // this delete as dead code.
        //
        // The cascade FK on tracking_status.supplement_project_group_id
        // removes any remaining older tracking rows as part of the same
        // transaction — the intentional rollback audit exception
        // documented in §12 and the STAFF-LED ROLLBACK RULE.
        await manager.delete(SupplementProjectGroup, {
          id: supplementProjectGroupId,
        });

        return {
          message: `ย้อนสถานะสำเร็จ (กลับไปเป็น "${previousTracking.statusId.name}")`,
          status: 'success',
        };
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}
