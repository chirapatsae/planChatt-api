import {
  Controller,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import * as crypto from 'crypto';

import { JwtAuthGuard } from 'src/auth/auth.guard';
import { LineUserBinding } from 'src/line/entities/line-user-binding.entity';
import { LineMessagingService } from 'src/line/line-messaging.service';
import type { LineFlexMessage } from 'src/line/interfaces/line-message.interface';

import { NotificationLineLog } from '../entities/notification-line-log.entity';

/**
 * W96-FE-PROFILE — Operator-facing test-message endpoint.
 *
 * `POST /v1/notifications/line/test`
 *   Sends a single Flex test push to the requester's active LINE binding.
 *
 * Design rules:
 *
 *   - JWT-guarded; targets the AUTHENTICATED user only (never an arbitrary
 *     userId from the request). §4.1 — this endpoint manages a personal
 *     channel, never a workflow transition.
 *   - 404 when the caller has no active `line_user_bindings` row.
 *   - 60-second per-user cooldown enforced via in-process Map; second
 *     hit within the window returns 429 with `retryAfterSeconds` so the
 *     FE can render a countdown. Multi-instance deploys can race past
 *     this — acceptable: the test path is low-volume and self-throttled
 *     by the user clicking once and waiting for LINE to arrive.
 *   - BYPASSES the §96 kill-switch (`NotificationSettingsService.isLineEnabled`).
 *     Operators need to verify connectivity even when global notifications
 *     are disabled. The test message is initiated by the user themself, so
 *     this is consent-by-action and §17.2 advisory framing is preserved.
 *   - DOES NOT bypass the env-level `LINE_MESSAGING_ENABLED` guard owned
 *     by `LineMessagingService.pushMessage` (W96-LINE-PROVIDER). When that
 *     env is unset/false the chokepoint short-circuits with `sandboxed:true`
 *     and the controller returns success — operator will know the test
 *     "worked" but no real push went out (matches sandbox semantics
 *     elsewhere; FE just shows the success toast).
 *   - W83 — `lineUserId` is masked via `shortHash` in every log line;
 *     the raw value is NEVER logged here.
 *   - Audit row written to `notification_line_logs` with
 *     `event_type='LINE_TEST_MESSAGE'` (non-allowlist pseudo-event,
 *     controller-local — does NOT pollute `LINE_EVENT_ALLOWLIST`).
 *   - §12 — does NOT write to `tracking_status`. §17.3 — audit row has no
 *     project FK.
 */
@Controller({ version: '1', path: 'notifications/line' })
@UseGuards(JwtAuthGuard)
export class NotificationsLineController {
  private readonly logger = new Logger(NotificationsLineController.name);

  /**
   * Per-user cooldown tracker. Key = userId, value = epoch ms of last
   * successful test send. Entries are evicted lazily on next read.
   */
  private static readonly cooldown = new Map<string, number>();
  private static readonly COOLDOWN_MS = 60_000;

  constructor(
    @InjectRepository(LineUserBinding)
    private readonly bindingRepo: Repository<LineUserBinding>,
    @InjectRepository(NotificationLineLog)
    private readonly auditRepo: Repository<NotificationLineLog>,
    private readonly lineMessagingService: LineMessagingService,
  ) {}

  @Post('test')
  async sendTestMessage(
    @Req() req: any,
  ): Promise<{ ok: true; sandboxed: boolean }> {
    const userId: string | undefined = req?.user?.userId;
    if (!userId) {
      throw new HttpException(
        'Authenticated user context missing',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // Cooldown check.
    const now = Date.now();
    const last = NotificationsLineController.cooldown.get(userId);
    if (last && now - last < NotificationsLineController.COOLDOWN_MS) {
      const retryAfterSeconds = Math.ceil(
        (NotificationsLineController.COOLDOWN_MS - (now - last)) / 1000,
      );
      throw new HttpException(
        { message: 'TEST_COOLDOWN_ACTIVE', retryAfterSeconds },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Active-binding lookup. Soft-unlinked rows (unlinkedAt IS NOT NULL)
    // are excluded; the partial unique index guarantees at most one active.
    const binding = await this.bindingRepo.findOne({
      where: { userId, unlinkedAt: IsNull() },
      select: ['id', 'lineUserId'],
    });
    if (!binding) {
      throw new HttpException(
        { message: 'LINE_NOT_LINKED' },
        HttpStatus.NOT_FOUND,
      );
    }

    const recipientHash = this.shortHash(binding.lineUserId);
    this.logger.log(
      `[NotifyLineTest] dispatch userId=${userId} recipient=${recipientHash}`,
    );

    // Minimal Flex bubble — clearly labeled as a test (§17.2 advisory framing).
    const flexMessage: LineFlexMessage = {
      type: 'flex',
      altText: 'ทดสอบการแจ้งเตือนจาก Project Bank',
      contents: {
        type: 'bubble',
        size: 'kilo',
        header: {
          type: 'box',
          layout: 'vertical',
          backgroundColor: '#06C755',
          paddingAll: '12px',
          contents: [
            {
              type: 'text',
              text: 'ทดสอบการแจ้งเตือน',
              weight: 'bold',
              size: 'md',
              color: '#FFFFFF',
            },
          ],
        },
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          paddingAll: '16px',
          contents: [
            {
              type: 'text',
              text: 'หากท่านได้รับข้อความนี้ แสดงว่าระบบเชื่อมต่อบัญชี LINE ของท่านเรียบร้อยแล้ว',
              wrap: true,
              size: 'sm',
              color: '#333333',
            },
            {
              type: 'text',
              text: 'ข้อความนี้เป็นการทดสอบจาก Project Bank',
              wrap: true,
              size: 'xs',
              color: '#888888',
              margin: 'md',
            },
          ],
        },
      },
    };

    let sandboxed = false;
    let providerMessageId: string | undefined;
    try {
      const result = await this.lineMessagingService.pushMessage(
        binding.lineUserId,
        [flexMessage],
      );
      sandboxed = result.sandboxed;
      providerMessageId = result.providerMessageId;
    } catch (err) {
      // Push failure — write an audit row, don't arm cooldown, surface 5xx.
      const errMsg = (err as Error).message ?? 'unknown';
      this.logger.error(
        `[NotifyLineTest] push-failed userId=${userId} recipient=${recipientHash} error=${this.truncateError(errMsg)}`,
      );
      this.writeAuditRow({
        userId,
        recipientLineUserId: binding.lineUserId,
        status: 'failed',
        errorMessage: this.truncateError(errMsg),
      });
      throw new HttpException(
        { message: 'LINE_TEST_SEND_FAILED' },
        HttpStatus.BAD_GATEWAY,
      );
    }

    // Arm cooldown only on a successful send (sandboxed counts — the
    // operator's intent ran end-to-end through the chokepoint).
    NotificationsLineController.cooldown.set(userId, now);

    this.writeAuditRow({
      userId,
      recipientLineUserId: binding.lineUserId,
      status: 'sent',
      providerMessageId: providerMessageId ?? null,
      errorMessage: sandboxed ? 'sandboxed' : null,
    });

    return { ok: true, sandboxed };
  }

  /**
   * Fire-and-forget audit insert. Mirrors the pattern used by
   * `NotificationsLineService.writeAuditLog` — never throws so an audit
   * outage does not crash the request.
   */
  private writeAuditRow(args: {
    userId: string;
    recipientLineUserId: string;
    status: 'sent' | 'failed';
    providerMessageId?: string | null;
    errorMessage?: string | null;
  }): void {
    this.auditRepo
      .insert({
        eventType: 'LINE_TEST_MESSAGE',
        targetKind: 'user',
        // No real project target — the test endpoint is user-scoped.
        // Use the userId as a stable target uuid so operator queries can
        // filter test messages by recipient without ambiguity.
        targetId: args.userId,
        recipientUserId: args.userId,
        recipientLineUserId: args.recipientLineUserId,
        status: args.status,
        attempts: 0,
        provider: 'line-messaging',
        providerMessageId: args.providerMessageId ?? null,
        errorMessage: args.errorMessage ?? null,
        sentAt: args.status === 'sent' ? new Date() : null,
        actorUserId: args.userId,
        actorWorkHistoryId: null,
      })
      .catch((err) => {
        this.logger.warn(
          `[NotifyLineTestAudit] write-failed userId=${args.userId} status=${args.status}: ${(err as Error).message}`,
        );
      });
  }

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

  private truncateError(message: string): string {
    if (!message) return '';
    const stripped = message.replace(/U[0-9a-fA-F]{32}/g, '<masked>');
    if (stripped.length <= 256) return stripped;
    return stripped.slice(0, 256) + '…';
  }
}
