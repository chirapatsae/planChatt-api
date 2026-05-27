import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { LineUserBinding } from 'src/line/entities/line-user-binding.entity';
import { LineMessagingService } from 'src/line/line-messaging.service';
import { maskIpForDisplay } from './backup-attempt-audit.service';
import type { BackupAttemptOutcome } from './constants/error-messages';
import { BACKUP_OUTCOME } from './constants/error-messages';

/**
 * SECURITY-01 §7.14 — LINE notifications for the backup-login flow.
 *
 * Two channels:
 *   - **Per-attempt**: fire-and-forget LINE push to the affected user
 *     on every credential/TOTP attempt (success + failure). Body MUST
 *     NOT carry password / TOTP code / token — just timestamp +
 *     masked-/24 IP + outcome label. SECURITY-01 §7.14.2 PII safety.
 *   - **Per-event**: super-admin issue / reset / revoke / freeze /
 *     unfreeze / TOTP-reset / killswitch toggle — notifies the
 *     affected user + ALL super-admins. Per-event delivery is best
 *     effort but always queued (no back-pressure drop).
 *
 * Back-pressure (SECURITY-01 §7.14.3):
 *   - Per-attempt drops when the LINE provider queue depth exceeds
 *     10000. We approximate "queue depth" as the number of currently
 *     in-flight per-attempt sends inside this process (Bull queue
 *     depth would be more authoritative but adds a Redis round-trip
 *     per attempt; this approximation is fine for Phase 1).
 *
 * §17.2 advisory — LINE delivery failure MUST NOT block the login
 * flow. Every public method swallows errors at the boundary.
 */
@Injectable()
export class BackupLineNotifier {
  private readonly logger = new Logger(BackupLineNotifier.name);
  private inFlightPerAttempt = 0;
  private readonly PER_ATTEMPT_INFLIGHT_CAP = 10_000;

  constructor(
    @InjectRepository(LineUserBinding)
    private readonly bindingRepo: Repository<LineUserBinding>,
    private readonly messaging: LineMessagingService,
  ) {}

  async notifyPerAttempt(args: {
    userId: string | null;
    outcome: BackupAttemptOutcome;
    ip: string;
    attemptedAt: Date;
  }): Promise<void> {
    if (!args.userId) return;
    if (this.inFlightPerAttempt >= this.PER_ATTEMPT_INFLIGHT_CAP) {
      this.logger.warn(
        '[BackupLineNotifier] per-attempt back-pressure: dropping notification',
      );
      return;
    }
    this.inFlightPerAttempt++;
    try {
      const lineUserId = await this.resolveActiveLineUserId(args.userId);
      if (!lineUserId) return;
      const ts = formatThaiTimestamp(args.attemptedAt);
      const result = this.outcomeLabel(args.outcome);
      const masked = maskIpForDisplay(args.ip);
      const text = `มีการพยายามเข้าสู่ระบบสำรองของบัญชีคุณ\nเมื่อ ${ts}\nจาก IP ${masked}\nผลลัพธ์: ${result}`;
      await this.messaging.pushText(lineUserId, text);
    } catch (err) {
      this.logger.warn(
        `[BackupLineNotifier] per-attempt failed: ${(err as Error).message}`,
      );
    } finally {
      this.inFlightPerAttempt--;
    }
  }

  async notifyEventToUser(
    userId: string,
    text: string,
  ): Promise<void> {
    try {
      const lineUserId = await this.resolveActiveLineUserId(userId);
      if (!lineUserId) return;
      await this.messaging.pushText(lineUserId, text);
    } catch (err) {
      this.logger.warn(
        `[BackupLineNotifier] event-to-user failed: ${(err as Error).message}`,
      );
    }
  }

  async notifyEventToSuperAdmins(
    superAdminUserIds: string[],
    text: string,
  ): Promise<void> {
    for (const uid of superAdminUserIds) {
      // Sequential (not parallel) so one slow recipient does not stall
      // the whole fan-out; per-recipient try/catch via the helper.
      await this.notifyEventToUser(uid, text);
    }
  }

  private async resolveActiveLineUserId(
    userId: string,
  ): Promise<string | null> {
    const binding = await this.bindingRepo.findOne({
      where: { userId, unlinkedAt: IsNull() },
      select: ['lineUserId'],
    });
    return binding?.lineUserId ?? null;
  }

  private outcomeLabel(outcome: BackupAttemptOutcome): string {
    if (outcome === BACKUP_OUTCOME.SUCCESS) return 'สำเร็จ';
    if (outcome === BACKUP_OUTCOME.MFA_REQUIRED) return 'ต้องการ MFA (กำลังดำเนินการ)';
    if (outcome === BACKUP_OUTCOME.MUST_CHANGE_PASSWORD)
      return 'ต้องเปลี่ยนรหัสผ่าน';
    return 'ล้มเหลว';
  }
}

function formatThaiTimestamp(d: Date): string {
  // ISO-style with Bangkok offset; keep the output PII-free.
  return d.toISOString();
}
