import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';

import {
  NotificationsEmailService,
  NOTIFICATIONS_EMAIL_JOB,
  NOTIFICATIONS_EMAIL_QUEUE,
} from './notifications-email.service';
import { ProjectNotificationJobPayload } from '../events/project-notification-event';
import { TemplateContextError } from './template-renderer.service';

/**
 * Wave 21 — BullMQ-style consumer for `notifications-email` queue.
 *
 * Responsibilities:
 *   - Drains queued ProjectNotificationJobPayload jobs.
 *   - Delegates transport to NotificationsEmailService.sendPreparedJob
 *     which in turn wraps the existing EmailService (Option C).
 *   - Classifies errors:
 *       * TemplateContextError       → NON-RETRYABLE (coding bug, DLQ).
 *       * Provider 4xx-ish failure   → NON-RETRYABLE (bad recipient, DLQ).
 *       * Provider 5xx / network     → THROW so Bull retries with backoff.
 *   - Writes NO tracking_status rows (§12).
 *
 * Preference-gate SECOND LAYER lives inside `sendPreparedJob` — if the
 * user flipped allowEmailNotification off between enqueue and dispatch,
 * the method returns `{ success: true, skipped: 'preference' }` and the
 * processor marks the job complete without sending.
 */
@Processor(NOTIFICATIONS_EMAIL_QUEUE)
export class EmailNotificationProcessor {
  private readonly logger = new Logger(EmailNotificationProcessor.name);

  constructor(private readonly notificationsEmailService: NotificationsEmailService) {}

  @Process(NOTIFICATIONS_EMAIL_JOB)
  async handleEmailJob(job: Job<ProjectNotificationJobPayload>): Promise<void> {
    const { data } = job;
    const attempt = job.attemptsMade + 1;

    this.logger.log(
      `[NotifyProcessor] pickup jobId=${job.id} attempt=${attempt} event=${data.eventType} project=${data.projectId}`,
    );

    try {
      const result = await this.notificationsEmailService.sendPreparedJob(data);

      if (result.success) {
        if (result.skipped) {
          this.logger.log(
            `[NotifyProcessor] complete-skipped jobId=${job.id} event=${data.eventType} reason=${result.skipped}`,
          );
        } else {
          this.logger.log(
            `[NotifyProcessor] complete-sent jobId=${job.id} event=${data.eventType} messageId=${result.messageId ?? 'n/a'}`,
          );
        }
        return;
      }

      // Non-success without a thrown error — classify as non-retryable.
      // The current EmailResult contract from the legacy EmailService does
      // NOT surface structured 4xx/5xx status. For safety, Wave 21 treats
      // a non-throwing `success=false` as non-retryable and logs DLQ.
      this.logger.error(
        `[NotifyDLQ] non-retryable jobId=${job.id} event=${data.eventType} project=${data.projectId} attempt=${attempt} error=${result.errorMessage ?? 'unknown'}`,
      );
      // Intentionally do NOT throw — job completes, failure captured in log.
      return;
    } catch (err) {
      if (err instanceof TemplateContextError) {
        // Non-retryable — coding bug. Mark complete, log DLQ.
        this.logger.error(
          `[NotifyDLQ] template-context-invalid jobId=${job.id} event=${data.eventType} project=${data.projectId}: ${err.message}`,
        );
        return;
      }

      // Everything else — provider 5xx / network / timeout. Rethrow so Bull
      // schedules the next backoff attempt (architecture §2.2, §7 matrix).
      this.logger.warn(
        `[NotifyProcessor] retryable-error jobId=${job.id} attempt=${attempt}/${job.opts.attempts ?? 5} event=${data.eventType}: ${(err as Error).message}`,
      );
      throw err;
    }
  }
}
