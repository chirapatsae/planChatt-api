import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';

import { User } from 'src/users/entities/user.entity';
import { EmailService } from 'src/util/email/email.service';
import {
  ProjectNotificationEvent,
  ProjectNotificationEventType,
  ProjectNotificationJobPayload,
  ProjectNotificationRecipient,
} from '../events/project-notification-event';
import { TemplateRendererService } from './template-renderer.service';
import { NotificationEmailLog } from '../entities/notification-email-log.entity';
import { maskEmail } from './utils/mask-email.util';
import { NotificationSettingsService } from './notification-settings.service';

export const NOTIFICATIONS_EMAIL_QUEUE = 'notifications-email';
export const NOTIFICATIONS_EMAIL_JOB = 'email';

/**
 * Mapping from event type to template file + subject builder. All copy
 * lives here or in `.hbs` files — no ad-hoc strings inside send paths
 * (architecture §6.3).
 */
const TEMPLATE_MAP: Record<ProjectNotificationEventType, string> = {
  PROJECT_SUBMITTED: 'project-submitted',
  PROJECT_RETURNED_FOR_REVISION: 'project-returned-for-revision',
  PROJECT_APPROVED: 'project-approved',
};

const SUBJECT_MAP: Record<
  ProjectNotificationEventType,
  (p: { projectName: string }) => string
> = {
  PROJECT_SUBMITTED: (p) => `[แจ้งเตือน] มีโครงการใหม่รอการตรวจสอบ: ${p.projectName}`,
  PROJECT_RETURNED_FOR_REVISION: (p) =>
    `[แจ้งเตือน] โครงการของท่านถูกส่งกลับเพื่อแก้ไข: ${p.projectName}`,
  PROJECT_APPROVED: (p) => `[แจ้งเตือน] โครงการของท่านได้รับการอนุมัติ: ${p.projectName}`,
};

const REQUIRED_TEMPLATE_FIELDS: Record<ProjectNotificationEventType, string[]> = {
  PROJECT_SUBMITTED: ['projectName', 'actionLink', 'toStatus'],
  PROJECT_RETURNED_FOR_REVISION: ['projectName', 'actionLink', 'toStatus'],
  PROJECT_APPROVED: ['projectName', 'actionLink', 'toStatus'],
};

/**
 * Bull job options — matches architecture §2.2.
 *   - 5 attempts, exponential backoff 2s base
 *   - keep last 100 completed for audit tail
 *   - retain failed jobs for DLQ inspection
 *   - 30s timeout (SendGrid SLA envelope)
 */
const JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 } as const,
  removeOnComplete: 100,
  removeOnFail: false,
  timeout: 30_000,
};

/**
 * NotificationsEmailService — Wave 21 Option C wrapper.
 *
 * Design rules (CRITICAL, see architecture EMAIL_NOTIFICATION.md §2.0.1):
 *   - Delegates ALL outbound transport to the existing EmailService
 *     (backend/src/util/email/email.service.ts) via constructor injection.
 *   - MUST NOT depend on concrete transport providers (Gmail/Postmark)
 *     — delegation through EmailService only.
 *   - Enforces the preference gate TWICE:
 *       1. At queueEmail() entry (this file) — prevents queue bloat.
 *       2. At processor pre-send — covers preference flips between enqueue
 *          and dispatch (see EmailNotificationProcessor).
 *   - NEVER writes to tracking_status (§12).
 *   - NEVER re-throws into the caller on queue-add failure (§4.1 workflow
 *     authority: email failure MUST NOT fail a workflow transition).
 *
 * Wave 21 does NOT wire event handlers to workflow emit points — N4 owns
 * that. This service exposes `queueEmail` for N4 to call from its
 * `@OnEvent('notification.*')` handlers.
 */
@Injectable()
export class NotificationsEmailService {
  private readonly logger = new Logger(NotificationsEmailService.name);

  constructor(
    @InjectQueue(NOTIFICATIONS_EMAIL_QUEUE)
    private readonly queue: Queue,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    // Option C wrapper — inject existing EmailService; do NOT construct providers here.
    private readonly emailService: EmailService,
    private readonly templateRenderer: TemplateRendererService,
    // Advisory audit log (N3 migration + N4 wiring). Fire-and-forget writes:
    // failures here MUST NEVER crash the queue job nor the workflow caller (§4.1).
    @InjectRepository(NotificationEmailLog)
    private readonly auditLogRepo: Repository<NotificationEmailLog>,
    // Wave 22 B2 — global kill-switch (ปิดไว้ก่อน). Consulted at the top
    // of `queueEmail()` to short-circuit fanout when emails are disabled
    // system-wide. Fail-closed: DB errors resolve to `emailEnabled=false`.
    private readonly notificationSettingsService: NotificationSettingsService,
  ) {}

  /**
   * Queue one email job per recipient. Applies the preference gate and
   * email-null gate per recipient at enqueue time (first layer of the
   * double-gate). Swallows queue-add errors — the caller (workflow path)
   * MUST never see a thrown exception from notifications.
   *
   * Contract:
   *   - Returns void on both success AND swallowed-error paths.
   *   - Logs `[Notify] skipped-at-queue: preference-off` for pref=false.
   *   - Logs `[Notify] skipped-at-queue: no-email-address` for null email.
   *   - Logs `[NotifyQueue] unavailable` if `queue.add` rejects.
   */
  async queueEmail(event: ProjectNotificationEvent): Promise<void> {
    try {
      // Wave 22 B2 — kill-switch short-circuit.
      // Per §17.2 advisory + user directive ("ปิดไว้ก่อน"): if the global
      // kill-switch is OFF, skip the entire fanout. Audit one row per
      // recipient with status='skipped-killswitch' so stats still count
      // the suppressed load. Fail-closed: settings-read error → treat as
      // OFF (never silently send).
      const emailEnabled =
        await this.notificationSettingsService.isEmailEnabled();
      if (!emailEnabled) {
        const killTargetKind = this.extractTargetKind(event?.metadata);
        for (const recipient of event?.recipients ?? []) {
          this.writeAuditLog({
            eventType: event?.eventType ?? 'UNKNOWN',
            targetId: event?.projectId ?? '',
            targetKind: killTargetKind,
            recipient,
            status: 'skipped-killswitch',
            providerMessageId: null,
            errorMessage: null,
            actorUserId: event?.actorUserId ?? null,
            actorWorkHistoryId: event?.actorWorkHistoryId ?? null,
          });
        }
        this.logger.log(
          `[Notify kill-switch] OFF — skipped ${event?.recipients?.length ?? 0} recipient(s) for event=${event?.eventType}`,
        );
        return;
      }

      if (!event || !event.recipients || event.recipients.length === 0) {
        this.logger.debug(
          `[Notify] skipped-at-queue: no-recipients event=${event?.eventType} project=${event?.projectId}`,
        );
        return;
      }

      const targetKind = this.extractTargetKind(event.metadata);

      for (const recipient of event.recipients) {
        // Preference gate — FIRST LAYER (architecture §2.4). Even though the
        // RecipientResolverService pre-filters, we re-check here against the
        // canonical `users` row because (a) N4 may pass a hand-built recipient
        // list that skipped the resolver, and (b) the gate must be centrally
        // unit-testable in this service (A18).
        const allowed = await this.assertPreference(recipient.userId);
        if (!allowed) {
          // Fine-grained log already emitted inside assertPreference.
          // Audit point #4 — preference-gate skip (§4.2 audit requirement).
          this.writeAuditLog({
            eventType: event.eventType,
            targetId: event.projectId,
            targetKind,
            recipient,
            status: 'skipped-preference',
            actorUserId: event.actorUserId ?? null,
            actorWorkHistoryId: event.actorWorkHistoryId ?? null,
          });
          continue;
        }

        const payload: ProjectNotificationJobPayload = {
          eventType: event.eventType,
          projectId: event.projectId,
          projectName: event.projectName,
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          reason: event.reason,
          actionLink: event.actionLink,
          recipient,
          metadata: event.metadata,
          actorUserId: event.actorUserId,
          actorWorkHistoryId: event.actorWorkHistoryId,
        };

        try {
          await this.queue.add(NOTIFICATIONS_EMAIL_JOB, payload, JOB_OPTIONS);
          this.logger.log(
            `[NotifyQueue] enqueued event=${event.eventType} project=${event.projectId} recipient=${maskEmail(recipient.email)}`,
          );
          // Audit point #1 — enqueue success.
          this.writeAuditLog({
            eventType: event.eventType,
            targetId: event.projectId,
            targetKind,
            recipient,
            status: 'queued',
            actorUserId: event.actorUserId ?? null,
            actorWorkHistoryId: event.actorWorkHistoryId ?? null,
          });
        } catch (err) {
          // Redis down / queue unreachable — architecture §7 requires catch + swallow.
          this.logger.error(
            `[NotifyQueue] unavailable event=${event.eventType} project=${event.projectId} recipient=${maskEmail(recipient.email)}: ${(err as Error).message}`,
          );
          // Audit point #3 — enqueue failure (queue/Redis unreachable).
          this.writeAuditLog({
            eventType: event.eventType,
            targetId: event.projectId,
            targetKind,
            recipient,
            status: 'failed',
            errorMessage: `queue-unavailable: ${(err as Error).message}`,
            actorUserId: event.actorUserId ?? null,
            actorWorkHistoryId: event.actorWorkHistoryId ?? null,
          });
        }
      }
    } catch (outerErr) {
      // Belt-and-braces — any unexpected throw from assertPreference, payload
      // build, etc. MUST NOT cascade into the workflow transaction emitter.
      this.logger.error(
        `[Notify] queueEmail unexpected-error event=${event?.eventType} project=${event?.projectId}: ${(outerErr as Error).message}`,
      );
    }
  }

  /**
   * Processor-side send. Re-checks preference (SECOND layer of the
   * double-gate — user may have flipped the toggle off between enqueue
   * and dispatch) and delegates to the existing EmailService transport.
   *
   * Returns:
   *   - success: true  — email dispatched (or intentionally skipped for pref/no-email).
   *   - success: false — non-retryable send failure. Caller should NOT re-throw.
   *
   * Throws (to trigger Bull retry):
   *   - Provider 5xx / network / timeout errors (via rethrow in processor).
   *
   * This method itself does not throw for preference/no-email skips —
   * those are normal completions. It DOES throw for template context
   * errors, since those are non-retryable coding bugs and should push
   * the job to DLQ (Bull still treats thrown as retryable, so the
   * processor catches TemplateContextError explicitly and marks
   * complete — see EmailNotificationProcessor).
   */
  async sendPreparedJob(payload: ProjectNotificationJobPayload): Promise<{
    success: boolean;
    skipped?: 'preference' | 'no-email' | 'user-missing';
    messageId?: string;
    errorMessage?: string;
  }> {
    // SECOND LAYER — re-load user and re-check allowEmailNotification.
    const user = await this.userRepo.findOne({
      where: { id: payload.recipient.userId },
      select: ['id', 'email', 'allowEmailNotification'],
    });

    const targetKind = this.extractTargetKind(payload.metadata);

    if (!user) {
      this.logger.warn(
        `[NotifyProcessor] skipped: user-missing userId=${payload.recipient.userId} event=${payload.eventType}`,
      );
      this.writeAuditLog({
        eventType: payload.eventType,
        targetId: payload.projectId,
        targetKind,
        recipient: payload.recipient,
        status: 'skipped-preference',
        errorMessage: 'user-missing-at-processor',
        actorUserId: payload.actorUserId ?? null,
        actorWorkHistoryId: payload.actorWorkHistoryId ?? null,
      });
      return { success: true, skipped: 'user-missing' };
    }

    if (!user.email || user.email.trim() === '') {
      this.logger.log(
        `[NotifyProcessor] skipped: no-email-address userId=${user.id} event=${payload.eventType}`,
      );
      this.writeAuditLog({
        eventType: payload.eventType,
        targetId: payload.projectId,
        targetKind,
        recipient: payload.recipient,
        status: 'skipped-preference',
        errorMessage: 'no-email-at-processor',
        actorUserId: payload.actorUserId ?? null,
        actorWorkHistoryId: payload.actorWorkHistoryId ?? null,
      });
      return { success: true, skipped: 'no-email' };
    }

    if (user.allowEmailNotification === false) {
      this.logger.log(
        `[NotifyProcessor] skipped-at-processor: preference-off userId=${user.id} event=${payload.eventType}`,
      );
      // Audit point #4 (processor-side) — preference flipped between enqueue and dispatch.
      this.writeAuditLog({
        eventType: payload.eventType,
        targetId: payload.projectId,
        targetKind,
        recipient: payload.recipient,
        status: 'skipped-preference',
        actorUserId: payload.actorUserId ?? null,
        actorWorkHistoryId: payload.actorWorkHistoryId ?? null,
      });
      return { success: true, skipped: 'preference' };
    }

    // Render template. TemplateContextError is non-retryable.
    const templateName = TEMPLATE_MAP[payload.eventType];
    const required = REQUIRED_TEMPLATE_FIELDS[payload.eventType];
    const templateCtx = {
      projectName: payload.projectName,
      fromStatus: payload.fromStatus,
      toStatus: payload.toStatus,
      reason: payload.reason,
      actionLink: payload.actionLink,
      sentAt: this.formatThaiTimestamp(new Date()),
      subject: SUBJECT_MAP[payload.eventType]({ projectName: payload.projectName }),
    };
    const bodyHtml = this.templateRenderer.render(templateName, templateCtx, required);
    const html = this.templateRenderer.render('_base', {
      subject: templateCtx.subject,
      sentAt: templateCtx.sentAt,
      bodyHtml,
    });
    const text = this.templateRenderer.toPlainText(bodyHtml);

    // Transport — Option C: delegate to existing EmailService. No provider
    // instantiation here.
    const result = await this.emailService.sendEmail({
      to: user.email,
      subject: templateCtx.subject,
      html,
      text,
    });

    if (result.success) {
      this.logger.log(
        `[NotifyProvider] sent event=${payload.eventType} project=${payload.projectId} recipient=${maskEmail(user.email)} messageId=${result.messageId ?? 'n/a'}`,
      );
      // Audit point #2 — send success.
      this.writeAuditLog({
        eventType: payload.eventType,
        targetId: payload.projectId,
        targetKind,
        recipient: payload.recipient,
        status: 'sent',
        providerMessageId: result.messageId ?? null,
        sentAt: new Date(),
        actorUserId: payload.actorUserId ?? null,
        actorWorkHistoryId: payload.actorWorkHistoryId ?? null,
      });
      return { success: true, messageId: result.messageId };
    }

    this.logger.error(
      `[NotifyProvider] send-failed event=${payload.eventType} project=${payload.projectId} recipient=${maskEmail(user.email)} error=${result.error ?? 'unknown'}`,
    );
    // Audit point #3 — provider send failure (non-retryable tail).
    this.writeAuditLog({
      eventType: payload.eventType,
      targetId: payload.projectId,
      targetKind,
      recipient: payload.recipient,
      status: 'failed',
      errorMessage: result.error ?? 'unknown',
      actorUserId: payload.actorUserId ?? null,
      actorWorkHistoryId: payload.actorWorkHistoryId ?? null,
    });
    return { success: false, errorMessage: result.error ?? 'unknown' };
  }

  /**
   * Preference gate — SINGLE SOURCE OF TRUTH for preference enforcement.
   * Called at queueEmail() entry (A18 unit-testable). The processor path
   * re-checks through sendPreparedJob() to catch inter-enqueue flips.
   */
  async assertPreference(userId: string): Promise<boolean> {
    if (!userId) return false;
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ['id', 'email', 'allowEmailNotification'],
    });
    if (!user) {
      this.logger.debug(`[Notify] skipped-at-queue: user-missing userId=${userId}`);
      return false;
    }
    if (!user.email || user.email.trim() === '') {
      this.logger.log(`[Notify] skipped-at-queue: no-email-address userId=${userId}`);
      return false;
    }
    if (user.allowEmailNotification === false) {
      this.logger.log(`[Notify] skipped-at-queue: preference-off userId=${userId}`);
      return false;
    }
    return true;
  }

  /**
   * Signed action link. HMAC-SHA256 over `${projectId}|${expiryEpoch}` using
   * NOTIFY_ACTION_LINK_SECRET; base URL NOTIFY_ACTION_LINK_BASE or APP_URL.
   *
   * Signed-URL is anti-leak only — recipients still re-auth on click (§9.4).
   */
  signActionLink(projectId: string, expiresInDays = 30): string {
    const base =
      process.env.NOTIFY_ACTION_LINK_BASE ||
      process.env.APP_URL ||
      'http://localhost:3000';
    const secret = process.env.NOTIFY_ACTION_LINK_SECRET || 'dev-insecure-secret';
    const expiry = Math.floor(Date.now() / 1000) + expiresInDays * 24 * 60 * 60;
    const payload = `${projectId}|${expiry}`;
    const token = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return `${base.replace(/\/+$/, '')}/projects/${encodeURIComponent(projectId)}?t=${token}&e=${expiry}`;
  }

  /**
   * Convenience — build the event envelope that N4 will @OnEvent emit.
   * Exposed so workflow emitters do not need to import crypto / env names.
   */
  buildEvent(args: {
    eventType: ProjectNotificationEventType;
    projectId: string;
    projectName: string;
    fromStatus: string;
    toStatus: string;
    reason?: string;
    recipients: ProjectNotificationRecipient[];
    metadata?: Record<string, string | number | null | undefined>;
    /** Wave 22 B1 — optional workflow-actor threading (see event type). */
    actorUserId?: string;
    /** Wave 22 B1 — optional workflow-actor threading (see event type). */
    actorWorkHistoryId?: string;
  }): ProjectNotificationEvent {
    return {
      eventType: args.eventType,
      projectId: args.projectId,
      projectName: args.projectName,
      fromStatus: args.fromStatus,
      toStatus: args.toStatus,
      reason: args.reason,
      actionLink: this.signActionLink(args.projectId),
      recipients: args.recipients,
      metadata: args.metadata,
      actorUserId: args.actorUserId,
      actorWorkHistoryId: args.actorWorkHistoryId,
    };
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  /**
   * Fire-and-forget audit write. NEVER throws. NEVER awaits completion from
   * the caller's perspective — failures are logged and swallowed so an audit
   * table outage cannot crash the notification pipeline nor the workflow
   * transition that triggered it (§4.1 guardrail).
   */
  private writeAuditLog(args: {
    eventType: string;
    targetId: string;
    targetKind: string;
    recipient: ProjectNotificationRecipient;
    status:
      | 'queued'
      | 'sent'
      | 'failed'
      | 'skipped-preference'
      // Wave 22 B2 — global kill-switch OFF (ปิดไว้ก่อน).
      | 'skipped-killswitch';
    providerMessageId?: string | null;
    errorMessage?: string | null;
    sentAt?: Date | null;
    /** Wave 22 B1 — workflow-actor threading. Null for legacy / system emits. */
    actorUserId?: string | null;
    /** Wave 22 B1 — workflow-actor threading. Null for legacy / system emits. */
    actorWorkHistoryId?: string | null;
  }): void {
    // No await — fire and forget. Catch internally so unhandled rejections
    // never surface to the Node runtime.
    this.auditLogRepo
      .insert({
        eventType: args.eventType,
        targetId: args.targetId,
        targetKind: args.targetKind,
        recipientUserId: args.recipient.userId ?? null,
        recipientEmail: args.recipient.email ?? '',
        status: args.status,
        attempts: 0,
        provider:
          process.env.NOTIFY_EMAIL_PROVIDER ||
          process.env.EMAIL_PROVIDER ||
          null,
        providerMessageId: args.providerMessageId ?? null,
        errorMessage: args.errorMessage ?? null,
        sentAt: args.sentAt ?? null,
        actorUserId: args.actorUserId ?? null,
        actorWorkHistoryId: args.actorWorkHistoryId ?? null,
      })
      .catch((err) => {
        // Audit failures are advisory only. Log and swallow.
        this.logger.warn(
          `[NotifyAudit] write-failed event=${args.eventType} status=${args.status} target=${args.targetId}: ${(err as Error).message}`,
        );
      });
  }

  /**
   * Extract the target kind ('project-group' | 'revised-project-group' |
   * 'supplement-project-group') from the event metadata bag. Defaults to
   * 'project-group' if unspecified — matches current Wave 21 scope where
   * PG is the primary emitter. N4 emitters pass `kind` explicitly via
   * event.metadata to disambiguate PG vs RPG.
   */
  private extractTargetKind(
    metadata: Record<string, string | number | null | undefined> | undefined,
  ): string {
    const raw = metadata?.['kind'];
    if (typeof raw === 'string' && raw.length > 0) return raw;
    return 'project-group';
  }

  /** Thai-locale timestamp string (Asia/Bangkok). */
  private formatThaiTimestamp(d: Date): string {
    try {
      return d.toLocaleString('th-TH', {
        timeZone: 'Asia/Bangkok',
        dateStyle: 'medium',
        timeStyle: 'short',
      });
    } catch {
      return d.toISOString();
    }
  }
}
