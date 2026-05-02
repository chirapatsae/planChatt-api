import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';

import {
  NOTIFICATIONS_LINE_JOB,
  NOTIFICATIONS_LINE_QUEUE,
  NotificationsLineService,
} from './notifications-line.service';
import { LineNotificationJobPayload } from '../events/project-notification-event';
import { FlexTemplateNotFoundError } from './flex-template-renderer.service';

/**
 * Wave 96 — BullMQ-style consumer for the `notifications-line` queue.
 *
 * Mirror of `EmailNotificationProcessor` (Wave 21):
 *   - Drains queued LineNotificationJobPayload jobs.
 *   - Delegates transport to `NotificationsLineService.sendPreparedJob`
 *     which wraps `LineMessagingService.pushMessage` (the W90 sandbox
 *     guard chokepoint).
 *   - Classifies errors:
 *       * FlexTemplateNotFoundError  → NON-RETRYABLE (DLQ via log).
 *       * Provider 4xx-ish failure   → NON-RETRYABLE (DLQ via log).
 *         (Service surfaces these as `success:false` rather than throwing.)
 *       * Provider 5xx / 429 / network → THROW so Bull retries with
 *         exponential backoff.
 *   - Writes NO `tracking_status` rows (§12).
 *
 * Preference SECOND LAYER + binding SECOND LAYER live inside
 * `sendPreparedJob`; if either gate flips during transit the method
 * returns `{ success: true, skipped: 'preference' | 'unlinked' | ... }`
 * and the processor marks the job complete without raising.
 */
@Processor(NOTIFICATIONS_LINE_QUEUE)
export class LineNotificationProcessor {
  private readonly logger = new Logger(LineNotificationProcessor.name);

  constructor(
    private readonly notificationsLineService: NotificationsLineService,
  ) {}

  @Process(NOTIFICATIONS_LINE_JOB)
  async handleLineJob(job: Job<LineNotificationJobPayload>): Promise<void> {
    const { data } = job;
    const attempt = job.attemptsMade + 1;

    this.logger.log(
      `[NotifyLineProcessor] pickup jobId=${job.id} attempt=${attempt} event=${data.eventType} project=${data.projectId}`,
    );

    try {
      const result = await this.notificationsLineService.sendPreparedJob(data);

      if (result.success) {
        if (result.skipped) {
          this.logger.log(
            `[NotifyLineProcessor] complete-skipped jobId=${job.id} event=${data.eventType} reason=${result.skipped}`,
          );
        } else {
          this.logger.log(
            `[NotifyLineProcessor] complete-sent jobId=${job.id} event=${data.eventType} messageId=${result.messageId ?? 'n/a'}`,
          );
        }
        return;
      }

      // Non-success without a thrown error — non-retryable (template
      // missing / classified 4xx). The service has already audit-logged
      // 'failed'; we only need to mark the Bull job complete + log DLQ.
      this.logger.error(
        `[NotifyLineDLQ] non-retryable jobId=${job.id} event=${data.eventType} project=${data.projectId} attempt=${attempt} error=${result.errorMessage ?? 'unknown'}`,
      );
      return;
    } catch (err) {
      if (err instanceof FlexTemplateNotFoundError) {
        // Defensive — should already have been caught inside the service,
        // but guard here so a coding bug never causes infinite retry.
        this.logger.error(
          `[NotifyLineDLQ] flex-template-missing jobId=${job.id} event=${data.eventType} project=${data.projectId}: ${err.message}`,
        );
        return;
      }

      // Provider 5xx / 429 / network — let Bull retry with backoff.
      this.logger.warn(
        `[NotifyLineProcessor] retryable-error jobId=${job.id} attempt=${attempt}/${job.opts.attempts ?? 5} event=${data.eventType}: ${(err as Error).message}`,
      );
      throw err;
    }
  }
}
