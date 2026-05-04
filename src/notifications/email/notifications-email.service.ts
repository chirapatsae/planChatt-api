import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { User } from 'src/users/entities/user.entity';
import { EmailService } from 'src/util/email/email.service';
import { decryption, isLikelyCiphertext } from 'src/util/encryption.util';
import {
  BYPASS_VERIFICATION_GATE,
  ProjectNotificationEvent,
  ProjectNotificationEventType,
  ProjectNotificationJobPayload,
  ProjectNotificationRecipient,
} from '../events/project-notification-event';
import { TemplateRendererService } from './template-renderer.service';
import { NotificationEmailLog } from '../entities/notification-email-log.entity';
import { maskEmail } from './utils/mask-email.util';
import { NotificationSettingsService } from './notification-settings.service';
import { signActionLinkToken } from './action-link-token.util';

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
  PROJECT_PULLED_BACK: 'project-pulled-back',
  // Wave 94 — owner-side templates.
  PROJECT_SUBMITTED_OWNER: 'project-submitted-owner',
  PROJECT_VERIFIED_OWNER: 'project-verified-owner',
  PROJECT_REJECTED_OWNER: 'project-rejected-owner',
  // Wave 95 — link-based email verification request (Q1).
  EMAIL_VERIFICATION_REQUEST: 'email-verification-request',
  // W105 BE-PR2 — digest templates. Templates support `{{#each projects}}`.
  PROJECT_SUBMITTED_DIGEST: 'project-submitted-digest',
  PROJECT_SUBMITTED_OWNER_DIGEST: 'project-submitted-owner-digest',
};

const SUBJECT_MAP: Record<
  ProjectNotificationEventType,
  (p: { projectName: string }) => string
> = {
  PROJECT_SUBMITTED: (p) => `[แจ้งเตือน] มีโครงการใหม่รอการตรวจสอบ: ${p.projectName}`,
  PROJECT_RETURNED_FOR_REVISION: (p) =>
    `[แจ้งเตือน] โครงการของท่านถูกส่งกลับเพื่อแก้ไข: ${p.projectName}`,
  PROJECT_APPROVED: (p) => `[แจ้งเตือน] โครงการของท่านได้รับการอนุมัติ: ${p.projectName}`,
  PROJECT_PULLED_BACK: (p) =>
    `[แจ้งเตือน] โครงการถูกถอนออกจากการตรวจสอบ: ${p.projectName}`,
  // Wave 94 — owner-side subject lines.
  PROJECT_SUBMITTED_OWNER: (p) =>
    `[ยืนยันการนำส่ง] โครงการของท่านถูกส่งเรียบร้อย: ${p.projectName}`,
  PROJECT_VERIFIED_OWNER: (p) =>
    `[แจ้งความคืบหน้า] โครงการของท่านผ่านการตรวจสอบ: ${p.projectName}`,
  PROJECT_REJECTED_OWNER: (p) =>
    `[แจ้งผล] โครงการของท่านไม่ผ่านการพิจารณา (เกินศักยภาพ): ${p.projectName}`,
  // Wave 95 — link-based email verification request (Q1). `projectName`
  // is unused for this event; the subject is static.
  EMAIL_VERIFICATION_REQUEST: () =>
    `[ยืนยันอีเมล] กรุณายืนยันอีเมลของท่าน`,
  // W105 BE-PR2 — digest subjects. The `projectName` arg is repurposed to
  // carry the totalCount-as-string from `dispatchDigest`. The dispatcher
  // sets `event.projectName = '${N} โครงการ'` so we extract the leading
  // numeric run and fall back to the raw value if parsing fails.
  PROJECT_SUBMITTED_DIGEST: (p) =>
    `[แจ้งเตือน] มีโครงการใหม่รอการตรวจสอบ ${extractDigestCount(p.projectName)} รายการ`,
  PROJECT_SUBMITTED_OWNER_DIGEST: (p) =>
    `[ยืนยันการนำส่ง] ส่งโครงการ ${extractDigestCount(p.projectName)} รายการเรียบร้อย`,
};

/**
 * W105 BE-PR2 — extract the leading numeric digit run from the digest
 * `projectName` placeholder (`'<N> โครงการ'`). Defensive: if the value is
 * not in that shape we return the raw input so the subject still renders
 * something readable.
 */
function extractDigestCount(raw: string): string {
  if (!raw) return '0';
  const m = raw.match(/^\s*(\d+)/);
  return m ? m[1] : raw;
}

const REQUIRED_TEMPLATE_FIELDS: Record<ProjectNotificationEventType, string[]> = {
  PROJECT_SUBMITTED: ['projectName', 'actionLink', 'toStatus'],
  PROJECT_RETURNED_FOR_REVISION: ['projectName', 'actionLink', 'toStatus'],
  PROJECT_APPROVED: ['projectName', 'actionLink', 'toStatus'],
  PROJECT_PULLED_BACK: ['projectName', 'actionLink', 'fromStatus', 'toStatus'],
  // Wave 94 — owner-side required fields.
  PROJECT_SUBMITTED_OWNER: ['projectName', 'actionLink', 'toStatus'],
  PROJECT_VERIFIED_OWNER: ['projectName', 'actionLink', 'toStatus'],
  PROJECT_REJECTED_OWNER: ['projectName', 'actionLink', 'toStatus'],
  // Wave 95 — verification email needs only the verify link; no project
  // status fields apply since this is an account-scope event.
  EMAIL_VERIFICATION_REQUEST: ['actionLink'],
  // W105 BE-PR2 — digest templates iterate over `projects[]` and render
  // a totalCount + actionLink. `projects` is an array; the renderer's
  // truthy check (length > 0) covers the "required-and-non-empty" rule.
  PROJECT_SUBMITTED_DIGEST: ['totalCount', 'projects', 'actionLink'],
  PROJECT_SUBMITTED_OWNER_DIGEST: ['totalCount', 'projects', 'actionLink'],
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
 * Wave 95 — emergency rollback flag for the email-verification gate.
 *
 * Resolved at module-load time: enabled by default; only the literal string
 * `'false'` disables the gate (per W95-GATE §7). When disabled, the gate is
 * inert and behavior reverts to pre-W95 (preference + kill-switch only).
 *
 * Gate scope: the verification-status check (`users.email_verified_at`) only.
 * The consent-bypass flag (`bypassAllowEmailNotification`) and the
 * `BYPASS_VERIFICATION_GATE` event-type set are orthogonal and remain active
 * regardless of this flag.
 */
const EMAIL_VERIFICATION_GATE_ENABLED =
  process.env.EMAIL_VERIFICATION_GATE_ENABLED !== 'false';

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

      // Wave 95 — consent-bypass flag is event-scope and applies to all
      // recipients of THIS event. Only the first-login auto-fire path of
      // EMAIL_VERIFICATION_REQUEST sets this; the user-initiated resend
      // path leaves it false so the user's `allowEmailNotification=false`
      // preference is still respected.
      const bypassPref = event.bypassAllowEmailNotification === true;

      for (const recipient of event.recipients) {
        // Preference gate — FIRST LAYER (architecture §2.4). Even though the
        // RecipientResolverService pre-filters, we re-check here against the
        // canonical `users` row because (a) N4 may pass a hand-built recipient
        // list that skipped the resolver, and (b) the gate must be centrally
        // unit-testable in this service (A18).
        const allowed = await this.assertPreference(recipient.userId, {
          bypassAllowEmailNotification: bypassPref,
        });
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

        // Wave 95 — verification gate (FIRST LAYER). Ordering: consent first
        // (above), deliverability second (here), per W95-GATE §11. The
        // `BYPASS_VERIFICATION_GATE` event-type set short-circuits this check
        // for `EMAIL_VERIFICATION_REQUEST` itself — gating the verification
        // email on `email_verified_at` would deadlock the user (chicken-and-
        // egg). The consent-bypass flag (`bypassAllowEmailNotification`) is
        // orthogonal: it relaxes the preference gate above but DOES NOT
        // bypass this verification-status gate (§17.2 advisory: integrity,
        // not workflow authority).
        if (
          EMAIL_VERIFICATION_GATE_ENABLED &&
          !BYPASS_VERIFICATION_GATE.has(event.eventType)
        ) {
          const verified = await this.assertEmailVerified(recipient.userId);
          if (!verified) {
            this.logger.log(
              `[Notify] skipped-at-queue: not-verified userId=${recipient.userId} event=${event.eventType}`,
            );
            this.writeAuditLog({
              eventType: event.eventType,
              targetId: event.projectId,
              targetKind,
              recipient,
              status: 'skipped-not-verified',
              providerMessageId: null,
              errorMessage: null,
              actorUserId: event.actorUserId ?? null,
              actorWorkHistoryId: event.actorWorkHistoryId ?? null,
            });
            continue;
          }
        }

        const payload: ProjectNotificationJobPayload = {
          eventType: event.eventType,
          projectId: event.projectId,
          projectName: event.projectName,
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          fromStatusTh: event.fromStatusTh,
          toStatusTh: event.toStatusTh,
          reason: event.reason,
          actionLink: event.actionLink,
          recipient,
          metadata: event.metadata,
          actorUserId: event.actorUserId,
          actorWorkHistoryId: event.actorWorkHistoryId,
          // Wave 95 — propagate to processor so the SECOND-layer preference
          // re-check honors the same bypass.
          bypassAllowEmailNotification: bypassPref || undefined,
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
    skipped?: 'preference' | 'no-email' | 'user-missing' | 'not-verified';
    messageId?: string;
    errorMessage?: string;
  }> {
    // SECOND LAYER — re-load user and re-check allowEmailNotification.
    // W90-FIX-01: also pull `emailHash` so the empty-email gate works on the
    // W89 invariant (no email → emailHash IS NULL). The `email` column itself
    // is AES-ciphertext post-W89 and only becomes a usable address after
    // decryption at the transport boundary below.
    const user = await this.userRepo.findOne({
      where: { id: payload.recipient.userId },
      select: ['id', 'email', 'emailHash', 'allowEmailNotification'],
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

    if (user.allowEmailNotification === false) {
      // Wave 95 — same consent-bypass semantics as assertPreference.
      if (payload.bypassAllowEmailNotification === true) {
        this.logger.log(
          `[NotifyProcessor] preference-off-bypassed userId=${user.id} event=${payload.eventType} (W95 verification-request)`,
        );
        // fall through — proceed with send.
      } else {
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
    }

    // Wave 95 — verification gate (SECOND LAYER). Re-checked here to catch
    // the case where the user's `email_verified_at` flipped to NULL (email
    // changed via `UsersService.update`) between enqueue and dispatch —
    // mirrors the existing two-layer pattern for `allowEmailNotification`.
    // `BYPASS_VERIFICATION_GATE` keeps `EMAIL_VERIFICATION_REQUEST` flowing
    // through the unverified path. `bypassAllowEmailNotification` is NOT
    // honored here — consent-bypass MUST NOT bypass verification (§17.2).
    if (
      EMAIL_VERIFICATION_GATE_ENABLED &&
      !BYPASS_VERIFICATION_GATE.has(payload.eventType)
    ) {
      const verified = await this.assertEmailVerified(payload.recipient.userId);
      if (!verified) {
        this.logger.log(
          `[NotifyProcessor] skipped-at-processor: not-verified userId=${payload.recipient.userId} event=${payload.eventType}`,
        );
        this.writeAuditLog({
          eventType: payload.eventType,
          targetId: payload.projectId,
          targetKind,
          recipient: payload.recipient,
          status: 'skipped-not-verified',
          providerMessageId: null,
          errorMessage: 'email-not-verified-at-processor',
          actorUserId: payload.actorUserId ?? null,
          actorWorkHistoryId: payload.actorWorkHistoryId ?? null,
        });
        return { success: true, skipped: 'not-verified' };
      }
    }

    // W90-FIX-01 — decrypt-at-boundary. Post-W89 the `email` column is
    // AES-ciphertext (`iv:hex`); pre-W89 legacy rows may still hold plaintext.
    // We branch on the shape, decrypt only when needed, and treat any
    // decryption failure as a non-retryable per-job audit failure (the
    // ciphertext could be corrupted or encrypted under a rotated key — Bull
    // retry would not help). Plaintext NEVER leaves this stack frame: it
    // lives only in `plaintextEmail` between this block and the
    // `emailService.sendEmail` call below, and is fed to `maskEmail(...)`
    // for log lines so masks are meaningful instead of opaque hex.
    const plaintextEmail = await this.decryptUserEmail(user);
    if (plaintextEmail === '__decrypt_failed__') {
      // W83 logger discipline — never log the raw ciphertext payload.
      this.logger.error(
        `[NotifyProcessor] decrypt-failed userId=${user.id} event=${payload.eventType}`,
      );
      this.writeAuditLog({
        eventType: payload.eventType,
        targetId: payload.projectId,
        targetKind,
        recipient: payload.recipient,
        status: 'failed',
        errorMessage: 'decrypt-failed',
        actorUserId: payload.actorUserId ?? null,
        actorWorkHistoryId: payload.actorWorkHistoryId ?? null,
      });
      return { success: false, errorMessage: 'decrypt-failed' };
    }

    if (!plaintextEmail) {
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

    // Render template. TemplateContextError is non-retryable.
    const templateName = TEMPLATE_MAP[payload.eventType];
    const required = REQUIRED_TEMPLATE_FIELDS[payload.eventType];
    // W105 BE-PR2 — branch on event type to build the templateCtx. Digest
    // events carry `projects[]` in `metadata.digestProjects` (JSON-encoded
    // by `DigestDispatcherService.dispatchDigest`) and a `digestTotalCount`
    // count. Single-project events use the legacy single-row context.
    let templateCtx: Record<string, unknown>;
    if (
      payload.eventType === 'PROJECT_SUBMITTED_DIGEST' ||
      payload.eventType === 'PROJECT_SUBMITTED_OWNER_DIGEST'
    ) {
      const rawProjects = payload.metadata?.['digestProjects'];
      const rawTotalCount = payload.metadata?.['digestTotalCount'];
      let projects: Array<{
        projectId: string;
        projectName: string;
        fromStatus: string;
        toStatus: string;
        fromStatusTh?: string;
        toStatusTh?: string;
      }> = [];
      try {
        if (typeof rawProjects === 'string' && rawProjects.length > 0) {
          projects = JSON.parse(rawProjects);
        }
      } catch (parseErr) {
        this.logger.warn(
          `[NotifyProcessor] digest payload parse-error event=${payload.eventType}: ${(parseErr as Error).message}`,
        );
      }
      const totalCount =
        typeof rawTotalCount === 'number'
          ? rawTotalCount
          : projects.length;
      // Resolve Thai labels per-project so the email's `{{fromStatusTh}}` /
      // `{{toStatusTh}}` columns render canonical Thai labels (W67). The
      // dispatcher already populates these on each descriptor; this fallback
      // mirrors the single-project path's behavior for legacy callers.
      const projectsForRender = projects.map((p) => ({
        projectName: p.projectName,
        fromStatus: p.fromStatus,
        toStatus: p.toStatus,
        fromStatusTh: p.fromStatusTh ?? p.fromStatus,
        toStatusTh: p.toStatusTh ?? p.toStatus,
      }));
      templateCtx = {
        totalCount,
        projects: projectsForRender,
        actionLink: payload.actionLink,
        sentAt: this.formatThaiTimestamp(new Date()),
        // For the subject builder we re-use the digest-count extraction
        // pattern; payload.projectName is `'${N} โครงการ'` set by the
        // dispatcher.
        subject: SUBJECT_MAP[payload.eventType]({
          projectName: payload.projectName,
        }),
      };
    } else {
      // Wave 92 — Thai labels are the preferred display source per CLAUDE.md
      // W67. Templates render `{{fromStatusTh}}` / `{{toStatusTh}}`; we fall
      // back to the canonical English name when the upstream caller has not
      // supplied a Thai label (legacy callers / boot-time defensive case).
      templateCtx = {
        projectName: payload.projectName,
        fromStatus: payload.fromStatus,
        toStatus: payload.toStatus,
        fromStatusTh: payload.fromStatusTh ?? payload.fromStatus,
        toStatusTh: payload.toStatusTh ?? payload.toStatus,
        reason: payload.reason,
        actionLink: payload.actionLink,
        sentAt: this.formatThaiTimestamp(new Date()),
        subject: SUBJECT_MAP[payload.eventType]({
          projectName: payload.projectName,
        }),
      };
    }
    const bodyHtml = this.templateRenderer.render(templateName, templateCtx, required);
    const subjectStr = String(templateCtx.subject ?? '');
    const sentAtStr = String(templateCtx.sentAt ?? '');
    const html = this.templateRenderer.render('_base', {
      subject: subjectStr,
      sentAt: sentAtStr,
      bodyHtml,
    });
    const text = this.templateRenderer.toPlainText(bodyHtml);

    // Transport — Option C: delegate to existing EmailService. No provider
    // instantiation here. W90-FIX-01: `plaintextEmail` is the decrypted
    // address; the ciphertext form on `user.email` MUST NOT be passed to
    // nodemailer or Gmail will reject the malformed address.
    const result = await this.emailService.sendEmail({
      to: plaintextEmail,
      subject: subjectStr,
      html,
      text,
    });

    if (result.success) {
      this.logger.log(
        `[NotifyProvider] sent event=${payload.eventType} project=${payload.projectId} recipient=${maskEmail(plaintextEmail)} messageId=${result.messageId ?? 'n/a'}`,
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
      `[NotifyProvider] send-failed event=${payload.eventType} project=${payload.projectId} recipient=${maskEmail(plaintextEmail)} error=${result.error ?? 'unknown'}`,
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
  async assertPreference(
    userId: string,
    opts: { bypassAllowEmailNotification?: boolean } = {},
  ): Promise<boolean> {
    if (!userId) return false;
    // W90-FIX-01 — gate on `emailHash` instead of decrypting `email`. W89
    // backfill guarantees `emailHash IS NULL` iff the user has no email,
    // so this is functionally equivalent to the prior plaintext check
    // without paying the per-job decryption cost on the queue-ingress hot
    // path. The prior `user.email.trim() === ''` check operated on
    // ciphertext post-W89 and was therefore non-functional (always truthy).
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ['id', 'emailHash', 'allowEmailNotification'],
    });
    if (!user) {
      this.logger.debug(`[Notify] skipped-at-queue: user-missing userId=${userId}`);
      return false;
    }
    if (!user.emailHash) {
      this.logger.log(`[Notify] skipped-at-queue: no-email-address userId=${userId}`);
      return false;
    }
    if (user.allowEmailNotification === false) {
      // Wave 95 — consent-bypass for the first-login auto-fire path of
      // EMAIL_VERIFICATION_REQUEST only. We log the bypass explicitly so the
      // operational trail makes the override visible. This bypass relaxes
      // the consent gate ONLY; the W95-GATE verification-status gate is
      // controlled separately via `BYPASS_VERIFICATION_GATE` keyed on
      // event type (see project-notification-event.ts).
      if (opts.bypassAllowEmailNotification === true) {
        this.logger.log(
          `[Notify] preference-off-bypassed userId=${userId} (W95 verification-request)`,
        );
        return true;
      }
      this.logger.log(`[Notify] skipped-at-queue: preference-off userId=${userId}`);
      return false;
    }
    return true;
  }

  /**
   * Wave 95 — verification gate (W95-GATE). Single source of truth for the
   * `email_verified_at IS NOT NULL` predicate, called from BOTH layers:
   *   1. queueEmail() — prevents queue bloat for unverified addresses.
   *   2. sendPreparedJob() — covers the case where the user changed their
   *      email between enqueue and dispatch (UsersService.update resets
   *      `email_verified_at = null` on email change — see W95-USERS-API).
   *
   * Returns:
   *   - `true`  — `email_verified_at` is non-null (user verified).
   *   - `false` — verified-at is NULL, user-missing, or DB error.
   *
   * Fail-closed: any DB error returns `false` (never silently sends to an
   * unverified address). Mirrors the `assertPreference` failure shape. The
   * BYPASS_VERIFICATION_GATE event-type set is checked at the call site —
   * this helper does NOT inspect event type.
   *
   * §17.3 — never logs raw email; userId only (W83 PII discipline).
   */
  private async assertEmailVerified(userId: string): Promise<boolean> {
    if (!userId) return false;
    try {
      const user = await this.userRepo.findOne({
        where: { id: userId },
        select: ['id', 'emailVerifiedAt'],
      });
      if (!user) return false;
      return user.emailVerifiedAt != null;
    } catch (err) {
      // Fail-closed — DB outage MUST NOT cause unverified sends.
      this.logger.warn(
        `[Notify] assertEmailVerified db-error userId=${userId}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Signed action link. HMAC-SHA256 over `${projectId}|${expiryEpoch}` using
   * NOTIFY_ACTION_LINK_SECRET; base URL NOTIFY_ACTION_LINK_BASE or APP_URL.
   *
   * Signed-URL is anti-leak only — recipients still re-auth on click (§9.4).
   */
  signActionLink(args: {
    projectId: string;
    eventType: ProjectNotificationEventType;
    projectKind: 'project-group' | 'revised-project-group';
    expiresInDays?: number;
  }): string {
    const expiresInDays = args.expiresInDays ?? 30;
    // Base URL precedence (Wave 93 fix — APP_URL removed from chain):
    //   1. NOTIFY_ACTION_LINK_BASE — explicit override (REQUIRED in production)
    //   2. http://localhost:5173   — Vite dev default (frontend dev server)
    //
    // APP_URL is intentionally NOT in this chain. Convention in this repo
    // (and across most NestJS projects) is APP_URL = BACKEND API origin,
    // which would produce email links pointing at the API host instead of
    // the SPA — clicking would 404 or download JSON. The W92 version
    // mistakenly fell back to APP_URL; removed here.
    //
    // Production deployers MUST set NOTIFY_ACTION_LINK_BASE to the public
    // frontend origin (e.g. https://projectbank.kpao.go.th).
    const base =
      process.env.NOTIFY_ACTION_LINK_BASE ||
      'http://localhost:5173';
    const expiry = Math.floor(Date.now() / 1000) + expiresInDays * 24 * 60 * 60;
    // W93-VERIFY-CORE — HMAC computation now lives in the shared util so the
    // verifier endpoint (W93-VERIFY-API) can import the same code path. URL
    // output here is byte-for-byte unchanged for fixed inputs.
    const token = signActionLinkToken({ projectId: args.projectId, expiry });
    const path = this.resolveActionPath(args.eventType, args.projectKind, args.projectId);
    return `${base.replace(/\/+$/, '')}${path}?t=${token}&e=${expiry}`;
  }

  /**
   * Wave 92 — pick the deep-link path based on event + project kind so the
   * email button lands on a route that EXISTS in the frontend AND matches
   * the recipient's role. Auth is handled by RequireAuth/ProtectedRoute on
   * the frontend — anonymous clicks bounce through `/login` automatically.
   *
   * Routing table (see App.tsx + menuConfig.tsx):
   *   PROJECT_SUBMITTED     / PROJECT_PULLED_BACK
   *     - main plan  → `/agency/admin/pending`        (staff list)
   *     - revision   → `/revise/edit/admin/detail/:id` (staff detail)
   *   PROJECT_RETURNED_FOR_REVISION
   *     - main plan  → `/project/edit/:id`            (owner editable)
   *     - revision   → `/revision/edit`               (owner revision-edit list)
   *   PROJECT_APPROVED
   *     - main plan  → `/project`                     (owner project list)
   *     - revision   → `/revision/tracking`           (owner revision tracker)
   *
   * Trade-off: revision projects route through `/revise/edit/...` regardless
   * of whether the underlying revision is type=edit or type=change. The
   * `/revise/change/admin/detail/:id` route exists but the projectKind alone
   * does not tell us which. Acceptable for Wave 92 — staff land on a page
   * that shows the project either way.
   */
  private resolveActionPath(
    eventType: ProjectNotificationEventType,
    projectKind: 'project-group' | 'revised-project-group',
    projectId: string,
  ): string {
    const id = encodeURIComponent(projectId);
    const isMainPlan = projectKind === 'project-group';

    if (eventType === 'PROJECT_SUBMITTED' || eventType === 'PROJECT_PULLED_BACK') {
      return isMainPlan ? '/agency/admin/pending' : `/revise/edit/admin/detail/${id}`;
    }
    if (eventType === 'PROJECT_RETURNED_FOR_REVISION') {
      return isMainPlan ? `/project/edit/${id}` : '/revision/edit';
    }
    if (eventType === 'PROJECT_APPROVED') {
      return isMainPlan ? '/project' : '/revision/tracking';
    }
    // Wave 94 — owner-side events route to the owner's project list. We do
    // not deep-link to a detail page because:
    //   - SUBMITTED_OWNER: they just submitted; list view shows the new row
    //     with "Pending" badge — most natural landing.
    //   - VERIFIED_OWNER: progress update, no action needed; list view OK.
    //   - REJECTED_OWNER: post-rejection editability is W68 follow-up;
    //     until that's defined, do NOT push them to an edit page.
    if (
      eventType === 'PROJECT_SUBMITTED_OWNER' ||
      eventType === 'PROJECT_VERIFIED_OWNER' ||
      eventType === 'PROJECT_REJECTED_OWNER'
    ) {
      return isMainPlan ? '/project' : '/revision/tracking';
    }
    // W105 BE-PR2 — digest events route to the same list pages as their
    // single-project counterparts so the CTA lands on the queue/owner list.
    if (eventType === 'PROJECT_SUBMITTED_DIGEST') {
      return isMainPlan ? '/agency/admin/pending' : `/revise/edit/admin/detail/${id}`;
    }
    if (eventType === 'PROJECT_SUBMITTED_OWNER_DIGEST') {
      return isMainPlan ? '/project' : '/revision/tracking';
    }
    // Defensive fallback — owner project list. Should never hit since the
    // event-type union is exhaustive above, but keeps the function total.
    return '/project';
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
    /** Wave 92 — Thai display labels resolved from `status.th_name`. */
    fromStatusTh?: string;
    toStatusTh?: string;
    reason?: string;
    /**
     * Wave 92 — required for action-link routing. The legacy `metadata.kind`
     * channel is still populated for compatibility, but we accept the kind
     * as a first-class arg so the action link can be built without
     * inspecting `metadata`.
     */
    projectKind: 'project-group' | 'revised-project-group';
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
      fromStatusTh: args.fromStatusTh,
      toStatusTh: args.toStatusTh,
      reason: args.reason,
      actionLink: this.signActionLink({
        projectId: args.projectId,
        eventType: args.eventType,
        projectKind: args.projectKind,
      }),
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
   * W90-FIX-01 — decrypt the user's email at the transport boundary.
   *
   * Return contract:
   *   - `null`                — no email present (empty / missing column).
   *   - `'__decrypt_failed__'` — column held ciphertext-shaped data but
   *     `decryption()` threw. Caller MUST audit-log `errorMessage='decrypt-failed'`
   *     and abort the send. We use a sentinel string instead of throwing so
   *     the failure path stays inside the existing fire-and-forget audit
   *     contract and never bubbles up to crash the Bull processor.
   *   - any other string     — plaintext email, ready to hand to nodemailer.
   *
   * Plaintext NEVER appears in logs and NEVER leaves the function-local
   * scope of the caller. No closure / cache / map keyed on the value.
   * Centralized in this file (NOT exported globally) to keep blast radius
   * small per the task spec.
   */
  private async decryptUserEmail(user: {
    email?: string;
  }): Promise<string | null | '__decrypt_failed__'> {
    const raw = user?.email;
    if (typeof raw !== 'string' || raw.length === 0) return null;
    if (isLikelyCiphertext(raw)) {
      try {
        const plain = await decryption(raw);
        const trimmed = (plain ?? '').trim();
        return trimmed.length > 0 ? trimmed : null;
      } catch {
        // W83 — never log the raw ciphertext here. Caller emits a structured
        // log with userId only.
        return '__decrypt_failed__';
      }
    }
    // Legacy pre-W89 plaintext row — accept as-is.
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

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
      | 'skipped-killswitch'
      // Wave 95 — recipient email not verified at queue time. Non-failure
      // skip; aggregations bucket this identically to 'skipped-preference'.
      // The actual write site lives in W95-GATE.
      | 'skipped-not-verified';
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
