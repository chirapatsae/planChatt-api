import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import * as crypto from 'crypto';

import { User } from 'src/users/entities/user.entity';
import { LineUserBinding } from 'src/line/entities/line-user-binding.entity';
import { LineMessagingService } from 'src/line/line-messaging.service';

import {
  LINE_EVENT_ALLOWLIST,
  LineNotificationJobPayload,
  ProjectNotificationEvent,
  ProjectNotificationLineRecipient,
} from '../events/project-notification-event';
import { NotificationLineLog } from '../entities/notification-line-log.entity';
import { NotificationSettingsService } from '../email/notification-settings.service';
import { RecipientResolverService } from '../email/recipient-resolver.service';
import {
  FlexRenderContext,
  FlexTemplateNotFoundError,
  FlexTemplateRendererService,
} from './flex-template-renderer.service';
import { DigestFlexBuilderService } from './digest-flex-builder.service';

export const NOTIFICATIONS_LINE_QUEUE = 'notifications-line';
export const NOTIFICATIONS_LINE_JOB = 'line';

/**
 * Bull job options — parity with email pipeline (architecture §2.2).
 *   - 5 attempts, exponential backoff 2s base
 *   - keep last 100 completed for audit tail
 *   - retain failed jobs for DLQ inspection
 *   - 30s timeout
 */
const JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 } as const,
  removeOnComplete: 100,
  removeOnFail: false,
  timeout: 30_000,
};

/**
 * NotificationsLineService — Wave 96 LINE push pipeline.
 *
 * Mirror of `NotificationsEmailService.queueEmail` but for the LINE
 * channel. Enforces the 5-layer defense:
 *
 *   1. Allowlist gate         — `LINE_EVENT_ALLOWLIST.has(eventType)`
 *      (skipped silently if event type is staff-side / not LINE-eligible)
 *   2. Kill-switch             — `notificationSettingsService.isLineEnabled()`
 *      (per-channel, fail-closed, 5s cache)
 *   3. Preference 1st-pass     — `users.allowLineNotification = true`
 *      AND active `line_user_bindings` row
 *      (delegated to `RecipientResolverService.enrichWithLineBindings`)
 *   4. Preference 2nd-pass     — re-checked at processor time
 *      (`sendPreparedJob`) to catch flips during transit.
 *   5. Unlinked 2nd-pass       — re-query `line_user_bindings` at
 *      processor time; binding may have been removed mid-transit.
 *
 * Design rules (CRITICAL — see CLAUDE.md):
 *   - §4.1 — channel failure MUST NOT fail any workflow transition.
 *     Every public method swallows errors at the boundary.
 *   - §12  — NEVER writes to `tracking_status`. Audit lands in
 *     `notification_line_logs` only.
 *   - §17.2 — advisory only; no path to gate any workflow action.
 *   - §17.3 — `notification_line_logs` has NO FK to project tables.
 *   - §17.11 — no role can bypass the kill-switch or allowlist.
 *   - W83  — `lineUserId` always masked via `shortHash` in log lines.
 *   - W90  — sandbox guard already lives inside `LineMessagingService.pushMessage`;
 *     this service does NOT duplicate it.
 *   - W93  — `actionLink` is HMAC-signed by upstream trigger-wiring; this
 *     service just renders the link into the Flex template.
 */
@Injectable()
export class NotificationsLineService {
  private readonly logger = new Logger(NotificationsLineService.name);

  constructor(
    @InjectQueue(NOTIFICATIONS_LINE_QUEUE)
    private readonly queue: Queue,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(LineUserBinding)
    private readonly lineBindingRepo: Repository<LineUserBinding>,
    @InjectRepository(NotificationLineLog)
    private readonly auditLogRepo: Repository<NotificationLineLog>,
    private readonly notificationSettingsService: NotificationSettingsService,
    private readonly recipientResolver: RecipientResolverService,
    private readonly flexRenderer: FlexTemplateRendererService,
    private readonly lineMessagingService: LineMessagingService,
    // W105 BE-PR2 — digest carousel builder. Used in `sendPreparedJob`
    // when the payload's eventType is one of the digest variants, where
    // we bypass the static template walker (which does not understand
    // arrays / repetition).
    private readonly digestFlexBuilder: DigestFlexBuilderService,
  ) {}

  /**
   * Queue one LINE push job per LINE-linked recipient. Applies the
   * allowlist + kill-switch + preference + binding gates at enqueue time.
   * Swallows ALL errors — the workflow caller MUST never see a thrown
   * exception from this service (§4.1 parity with email).
   */
  async queueLine(event: ProjectNotificationEvent): Promise<void> {
    try {
      // Gate 1 — Allowlist. Defensive belt-and-braces; the upstream
      // trigger-wiring filters by Q2 logic before calling, but a
      // misconfiguration must not result in a staff-side LINE blast.
      if (!event || !LINE_EVENT_ALLOWLIST.has(event.eventType)) {
        this.logger.debug(
          `[NotifyLine] skipped-at-queue: not-line-eligible event=${event?.eventType ?? 'UNKNOWN'} project=${event?.projectId ?? '-'}`,
        );
        const targetKindEarly = this.extractTargetKind(event?.metadata);
        for (const recipient of event?.recipients ?? []) {
          this.writeAuditLog({
            eventType: event?.eventType ?? 'UNKNOWN',
            targetId: event?.projectId ?? '',
            targetKind: targetKindEarly,
            recipientUserId: recipient?.userId ?? null,
            recipientLineUserId: '',
            status: 'skipped-allowlist',
            actorUserId: event?.actorUserId ?? null,
            actorWorkHistoryId: event?.actorWorkHistoryId ?? null,
          });
        }
        return;
      }

      // Gate 2 — Kill-switch (per-channel). Fail-closed: DB error → OFF.
      const lineEnabled =
        await this.notificationSettingsService.isLineEnabled();
      if (!lineEnabled) {
        const killTargetKind = this.extractTargetKind(event.metadata);
        for (const recipient of event.recipients ?? []) {
          this.writeAuditLog({
            eventType: event.eventType,
            targetId: event.projectId,
            targetKind: killTargetKind,
            recipientUserId: recipient.userId ?? null,
            recipientLineUserId: '',
            status: 'skipped-killswitch',
            actorUserId: event.actorUserId ?? null,
            actorWorkHistoryId: event.actorWorkHistoryId ?? null,
          });
        }
        this.logger.log(
          `[NotifyLine kill-switch] OFF — skipped ${event.recipients?.length ?? 0} recipient(s) for event=${event.eventType}`,
        );
        return;
      }

      if (!event.recipients || event.recipients.length === 0) {
        this.logger.debug(
          `[NotifyLine] skipped-at-queue: no-recipients event=${event.eventType} project=${event.projectId}`,
        );
        return;
      }

      const targetKind = this.extractTargetKind(event.metadata);

      // Gate 3 — Preference + active-binding (1st pass). Delegated to the
      // shared resolver which performs ONE batched SQL roundtrip per
      // user-pref + ONE batched roundtrip per active binding lookup.
      // Recipients without an active binding (or with allowLineNotification
      // = false) are dropped. We compute the drop set ourselves so we can
      // audit each one with the appropriate status.
      const linkedRecipients =
        await this.recipientResolver.enrichWithLineBindings(event.recipients);
      const linkedByUserId = new Map<
        string,
        ProjectNotificationLineRecipient
      >();
      for (const r of linkedRecipients) {
        linkedByUserId.set(r.userId, r);
      }

      // Audit drops at the 1st-pass binding/preference gate. We re-query
      // the user pref individually only when we need to disambiguate
      // 'skipped-preference' vs 'skipped-not-linked'. Both are advisory;
      // the audit row preserves the operator's view of recipient counts.
      for (const recipient of event.recipients) {
        if (linkedByUserId.has(recipient.userId)) continue;
        const status = await this.classifyDropReason(recipient.userId);
        this.writeAuditLog({
          eventType: event.eventType,
          targetId: event.projectId,
          targetKind,
          recipientUserId: recipient.userId ?? null,
          recipientLineUserId: '',
          status,
          actorUserId: event.actorUserId ?? null,
          actorWorkHistoryId: event.actorWorkHistoryId ?? null,
        });
      }

      // Enqueue surviving recipients.
      for (const recipient of linkedRecipients) {
        const payload: LineNotificationJobPayload = {
          eventType: event.eventType,
          projectId: event.projectId,
          projectName: event.projectName,
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          fromStatusTh: event.fromStatusTh,
          toStatusTh: event.toStatusTh,
          reason: event.reason,
          actionLink: event.actionLink,
          recipient: {
            userId: recipient.userId,
            lineUserId: recipient.lineUserId,
            workHistoryId: recipient.workHistoryId,
          },
          metadata: event.metadata,
          actorUserId: event.actorUserId,
          actorWorkHistoryId: event.actorWorkHistoryId,
        };

        try {
          await this.queue.add(NOTIFICATIONS_LINE_JOB, payload, JOB_OPTIONS);
          this.logger.log(
            `[NotifyLineQueue] enqueued event=${event.eventType} project=${event.projectId} recipient=${this.shortHash(recipient.lineUserId)}`,
          );
          this.writeAuditLog({
            eventType: event.eventType,
            targetId: event.projectId,
            targetKind,
            recipientUserId: recipient.userId,
            recipientLineUserId: recipient.lineUserId,
            status: 'queued',
            actorUserId: event.actorUserId ?? null,
            actorWorkHistoryId: event.actorWorkHistoryId ?? null,
          });
        } catch (err) {
          // Redis down / queue unreachable — never re-throw (§4.1).
          this.logger.error(
            `[NotifyLineQueue] unavailable event=${event.eventType} project=${event.projectId} recipient=${this.shortHash(recipient.lineUserId)}: ${(err as Error).message}`,
          );
          this.writeAuditLog({
            eventType: event.eventType,
            targetId: event.projectId,
            targetKind,
            recipientUserId: recipient.userId,
            recipientLineUserId: recipient.lineUserId,
            status: 'failed',
            errorMessage: this.truncateError(
              `queue-unavailable: ${(err as Error).message}`,
            ),
            actorUserId: event.actorUserId ?? null,
            actorWorkHistoryId: event.actorWorkHistoryId ?? null,
          });
        }
      }
    } catch (outerErr) {
      // Belt-and-braces — any unexpected throw from gate evaluation,
      // payload build, etc. MUST NOT cascade into the workflow caller.
      this.logger.error(
        `[NotifyLine] queueLine unexpected-error event=${event?.eventType} project=${event?.projectId}: ${(outerErr as Error).message}`,
      );
    }
  }

  /**
   * Processor-side send. Re-checks BOTH `users.allowLineNotification`
   * (Gate 4) AND active `line_user_bindings` row (Gate 5) — the binding
   * may have been removed during transit. Then renders the Flex bubble
   * and pushes via `LineMessagingService.pushMessage`.
   *
   * Returns:
   *   - success: true                — pushed (or sandboxed). No retry needed.
   *   - success: true, skipped: ...  — gate flipped between enqueue and
   *                                     dispatch. No retry.
   *   - success: false               — non-retryable failure (4xx / template).
   *
   * Throws (to trigger Bull retry):
   *   - Provider 5xx / 429 / network errors. The inner LineMessagingService
   *     already handles a per-attempt retry budget; outer Bull retry
   *     covers exhaustion.
   */
  async sendPreparedJob(payload: LineNotificationJobPayload): Promise<{
    success: boolean;
    skipped?: 'preference' | 'unlinked' | 'user-missing' | 'template';
    messageId?: string;
    errorMessage?: string;
  }> {
    const targetKind = this.extractTargetKind(payload.metadata);

    // Gate 4 — preference re-check. Pull only the pref column.
    const user = await this.userRepo.findOne({
      where: { id: payload.recipient.userId },
      select: ['id', 'allowLineNotification'],
    });

    if (!user) {
      this.logger.warn(
        `[NotifyLineProcessor] skipped: user-missing userId=${payload.recipient.userId} event=${payload.eventType}`,
      );
      this.writeAuditLog({
        eventType: payload.eventType,
        targetId: payload.projectId,
        targetKind,
        recipientUserId: payload.recipient.userId,
        recipientLineUserId: payload.recipient.lineUserId,
        status: 'skipped-preference',
        errorMessage: 'user-missing-at-processor',
        actorUserId: payload.actorUserId ?? null,
        actorWorkHistoryId: payload.actorWorkHistoryId ?? null,
      });
      return { success: true, skipped: 'user-missing' };
    }

    if (user.allowLineNotification === false) {
      this.logger.log(
        `[NotifyLineProcessor] skipped-at-processor: preference-off userId=${user.id} event=${payload.eventType}`,
      );
      this.writeAuditLog({
        eventType: payload.eventType,
        targetId: payload.projectId,
        targetKind,
        recipientUserId: payload.recipient.userId,
        recipientLineUserId: payload.recipient.lineUserId,
        status: 'skipped-preference',
        actorUserId: payload.actorUserId ?? null,
        actorWorkHistoryId: payload.actorWorkHistoryId ?? null,
      });
      return { success: true, skipped: 'preference' };
    }

    // Gate 5 — active-binding re-check. The binding could have been
    // soft-unlinked (set unlinkedAt) between enqueue and dispatch. Match
    // by `lineUserId` (the canonical identifier in the queue payload)
    // AND `userId` (so a re-link to a DIFFERENT user does not bleed).
    const activeBinding = await this.lineBindingRepo.findOne({
      where: {
        userId: payload.recipient.userId,
        lineUserId: payload.recipient.lineUserId,
        unlinkedAt: IsNull(),
      },
      select: ['id'],
    });
    if (!activeBinding) {
      this.logger.log(
        `[NotifyLineProcessor] skipped-at-processor: unlinked userId=${user.id} recipient=${this.shortHash(payload.recipient.lineUserId)} event=${payload.eventType}`,
      );
      this.writeAuditLog({
        eventType: payload.eventType,
        targetId: payload.projectId,
        targetKind,
        recipientUserId: payload.recipient.userId,
        recipientLineUserId: payload.recipient.lineUserId,
        status: 'skipped-unlinked',
        actorUserId: payload.actorUserId ?? null,
        actorWorkHistoryId: payload.actorWorkHistoryId ?? null,
      });
      return { success: true, skipped: 'unlinked' };
    }

    // Render Flex template. FlexTemplateNotFoundError is non-retryable.
    let flexMessage;
    try {
      if (
        payload.eventType === 'PROJECT_SUBMITTED_DIGEST' ||
        payload.eventType === 'PROJECT_SUBMITTED_OWNER_DIGEST'
      ) {
        // W105 BE-PR2 — digest carousel path. Bypass the dumb static
        // walker because it does not know how to repeat per-project
        // bubbles. The builder accepts pre-resolved descriptors and
        // assembles a `type: "carousel"` Flex contents object.
        flexMessage = this.buildDigestFlex(payload);
      } else {
        const ctx: FlexRenderContext = {
          projectName: payload.projectName,
          fromStatusTh: payload.fromStatusTh ?? payload.fromStatus,
          toStatusTh: payload.toStatusTh ?? payload.toStatus,
          actionLink: payload.actionLink,
          reason: payload.reason,
        };
        flexMessage = this.flexRenderer.renderFlexTemplate(
          payload.eventType,
          ctx,
        );
      }
    } catch (err) {
      if (err instanceof FlexTemplateNotFoundError) {
        this.logger.error(
          `[NotifyLineDLQ] template-missing event=${payload.eventType} project=${payload.projectId}: ${err.message}`,
        );
        this.writeAuditLog({
          eventType: payload.eventType,
          targetId: payload.projectId,
          targetKind,
          recipientUserId: payload.recipient.userId,
          recipientLineUserId: payload.recipient.lineUserId,
          status: 'failed',
          errorMessage: this.truncateError(
            `template-not-found: ${err.message}`,
          ),
          actorUserId: payload.actorUserId ?? null,
          actorWorkHistoryId: payload.actorWorkHistoryId ?? null,
        });
        return {
          success: false,
          skipped: 'template',
          errorMessage: 'template-not-found',
        };
      }
      throw err;
    }

    // Push via the chokepoint. Sandbox + W90 guard already live inside
    // `pushMessage`; we treat sandboxed outcomes as 'sent' for audit
    // purposes (mirrors the email pattern — operator dashboard would
    // otherwise undercount suppressed sends in non-prod).
    try {
      const result = await this.lineMessagingService.pushMessage(
        payload.recipient.lineUserId,
        [flexMessage],
      );

      this.logger.log(
        `[NotifyLineProvider] sent event=${payload.eventType} project=${payload.projectId} recipient=${this.shortHash(payload.recipient.lineUserId)} sandboxed=${result.sandboxed} messageId=${result.providerMessageId ?? 'n/a'}`,
      );
      this.writeAuditLog({
        eventType: payload.eventType,
        targetId: payload.projectId,
        targetKind,
        recipientUserId: payload.recipient.userId,
        recipientLineUserId: payload.recipient.lineUserId,
        status: 'sent',
        providerMessageId: result.providerMessageId ?? null,
        sentAt: new Date(),
        errorMessage: result.sandboxed ? 'sandboxed' : null,
        actorUserId: payload.actorUserId ?? null,
        actorWorkHistoryId: payload.actorWorkHistoryId ?? null,
      });
      return { success: true, messageId: result.providerMessageId };
    } catch (err) {
      // The LineMessagingService already classified retryable vs
      // non-retryable via its own logging; we cannot reliably re-classify
      // from the thrown Error alone. Audit as failed with a truncated
      // (W83-safe — no raw lineUserId in the message body).
      const errMsg = (err as Error).message ?? 'unknown';
      const truncated = this.truncateError(errMsg);
      this.logger.error(
        `[NotifyLineProvider] send-failed event=${payload.eventType} project=${payload.projectId} recipient=${this.shortHash(payload.recipient.lineUserId)} error=${truncated}`,
      );
      this.writeAuditLog({
        eventType: payload.eventType,
        targetId: payload.projectId,
        targetKind,
        recipientUserId: payload.recipient.userId,
        recipientLineUserId: payload.recipient.lineUserId,
        status: 'failed',
        errorMessage: truncated,
        actorUserId: payload.actorUserId ?? null,
        actorWorkHistoryId: payload.actorWorkHistoryId ?? null,
      });

      // Re-throw so Bull schedules a retry. Non-retryable errors are
      // already short-circuited inside LineMessagingService (it throws
      // for 4xx but does NOT retry). The outer Bull policy will
      // eventually exhaust attempts on hard failures.
      if (this.isNonRetryable(errMsg)) {
        return { success: false, errorMessage: truncated };
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * W105 BE-PR2 — assemble the digest carousel from the payload metadata.
   * The dispatcher serialized the project descriptors as a JSON string in
   * `metadata.digestProjects` (the metadata bag accepts string values
   * only); we deserialize here, resolve the icon base, and hand the input
   * to `DigestFlexBuilderService.buildSubmittedDigestFlex`.
   *
   * Throws `FlexTemplateNotFoundError` if the digest descriptor metadata
   * is missing — surfaced as a non-retryable DLQ error consistent with
   * the existing template-not-found handling.
   */
  private buildDigestFlex(payload: LineNotificationJobPayload) {
    const rawProjects = payload.metadata?.['digestProjects'];
    const rawTotalCount = payload.metadata?.['digestTotalCount'];
    let projects: Array<{
      projectName: string;
      fromStatusTh?: string;
      fromStatus: string;
      toStatusTh?: string;
      toStatus: string;
    }> = [];
    try {
      if (typeof rawProjects === 'string' && rawProjects.length > 0) {
        projects = JSON.parse(rawProjects);
      }
    } catch (err) {
      throw new FlexTemplateNotFoundError(
        payload.eventType,
        `digest-payload-parse-error: ${(err as Error).message}`,
      );
    }
    if (projects.length === 0) {
      throw new FlexTemplateNotFoundError(
        payload.eventType,
        '<digest-projects-empty>',
      );
    }
    const totalCount =
      typeof rawTotalCount === 'number' ? rawTotalCount : projects.length;
    // Mirror `FlexTemplateRendererService` icon-base resolution so the
    // carousel bubbles share the same CDN origin as single-project bubbles.
    const iconBase = (
      process.env.LINE_ICON_BASE_URL ||
      process.env.APP_URL ||
      ''
    ).replace(/\/$/, '');
    const flavor =
      payload.eventType === 'PROJECT_SUBMITTED_OWNER_DIGEST'
        ? 'owner'
        : 'staff';
    return this.digestFlexBuilder.buildSubmittedDigestFlex({
      flavor,
      totalCount,
      projects: projects.map((p) => ({
        projectName: p.projectName,
        fromStatusTh: p.fromStatusTh ?? p.fromStatus,
        toStatusTh: p.toStatusTh ?? p.toStatus,
      })),
      iconBase,
      actionLink: payload.actionLink,
    });
  }

  /**
   * Disambiguate why a recipient was dropped at the 1st-pass gate.
   * Returns 'skipped-preference' if the user has opted out, otherwise
   * 'skipped-not-linked'. Fail-closed on DB errors → 'skipped-not-linked'
   * (the conservative classification — assume binding missing rather
   * than mis-attribute to preference).
   */
  private async classifyDropReason(
    userId: string,
  ): Promise<'skipped-preference' | 'skipped-not-linked'> {
    if (!userId) return 'skipped-not-linked';
    try {
      const user = await this.userRepo.findOne({
        where: { id: userId },
        select: ['id', 'allowLineNotification'],
      });
      if (user && user.allowLineNotification === false) {
        return 'skipped-preference';
      }
      return 'skipped-not-linked';
    } catch {
      return 'skipped-not-linked';
    }
  }

  /**
   * Heuristic — treat 4xx-class messages from LineMessagingService as
   * non-retryable. The provider already classifies status codes; we mirror
   * the substring patterns it uses in its thrown error messages.
   */
  private isNonRetryable(message: string): boolean {
    if (!message) return false;
    const m = message.toLowerCase();
    return (
      m.includes('reason=bad-request') ||
      m.includes('reason=unauthorized') ||
      m.includes('reason=forbidden') ||
      m.includes('reason=not-found') ||
      m.includes('reason=unexpected')
    );
  }

  /**
   * W83 — truncate provider error messages to 256 chars and strip any
   * U-prefixed LINE user id sequences before persisting / logging.
   * Defense-in-depth; the provider already masks recipients in its own
   * logs but a stray inclusion in an error string would leak otherwise.
   */
  private truncateError(message: string): string {
    if (!message) return '';
    const stripped = message.replace(/U[0-9a-fA-F]{32}/g, '<masked>');
    if (stripped.length <= 256) return stripped;
    return stripped.slice(0, 256) + '…';
  }

  /**
   * Short SHA-256 prefix for log-line correlation. 8 hex = 32 bits, far
   * short of letting an operator recover the original lineUserId.
   * Mirrors the helper in `LineMessagingService` so log lines line up.
   */
  private shortHash(value: string): string {
    if (!value) return '<empty>';
    return (
      crypto
        .createHash('sha256')
        .update(value, 'utf8')
        .digest('hex')
        .slice(0, 8) + '...'
    );
  }

  /**
   * Fire-and-forget audit write. NEVER throws — audit-table outages MUST
   * NOT crash the queue job nor the workflow caller (§4.1).
   */
  private writeAuditLog(args: {
    eventType: string;
    targetId: string;
    targetKind: string;
    recipientUserId: string | null;
    recipientLineUserId: string;
    status:
      | 'queued'
      | 'sent'
      | 'failed'
      | 'skipped-preference'
      | 'skipped-killswitch'
      | 'skipped-allowlist'
      | 'skipped-not-linked'
      | 'skipped-unlinked';
    providerMessageId?: string | null;
    errorMessage?: string | null;
    sentAt?: Date | null;
    actorUserId?: string | null;
    actorWorkHistoryId?: string | null;
  }): void {
    this.auditLogRepo
      .insert({
        eventType: args.eventType,
        targetId: args.targetId,
        targetKind: args.targetKind,
        recipientUserId: args.recipientUserId ?? null,
        recipientLineUserId: args.recipientLineUserId ?? '',
        status: args.status,
        attempts: 0,
        provider: 'line-messaging',
        providerMessageId: args.providerMessageId ?? null,
        errorMessage: args.errorMessage ?? null,
        sentAt: args.sentAt ?? null,
        actorUserId: args.actorUserId ?? null,
        actorWorkHistoryId: args.actorWorkHistoryId ?? null,
      })
      .catch((err) => {
        // Audit failures are advisory only.
        this.logger.warn(
          `[NotifyLineAudit] write-failed event=${args.eventType} status=${args.status} target=${args.targetId}: ${(err as Error).message}`,
        );
      });
  }

  /**
   * Extract the target kind ('project-group' | 'revised-project-group' |
   * 'supplement-project-group') from the event metadata bag. Defaults to
   * 'project-group' if unspecified — matches the email path.
   */
  private extractTargetKind(
    metadata: Record<string, string | number | null | undefined> | undefined,
  ): string {
    const raw = metadata?.['kind'];
    if (typeof raw === 'string' && raw.length > 0) return raw;
    return 'project-group';
  }
}
