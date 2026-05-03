import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { Repository } from 'typeorm';

import { EmailService } from 'src/util/email/email.service';
import { User } from 'src/users/entities/user.entity';
import { UsersService } from 'src/users/users.service';
import { maskEmail } from '../email/utils/mask-email.util';
import { EmailStatsService } from '../email/email-stats.service';
import { LineStatsService } from '../line/line-stats.service';
import { NotificationQuotaAlertsService } from './notification-quota-alerts.service';
import { NotificationQuotaAlert } from '../entities/notification-quota-alert.entity';

/**
 * Wave 97 — Quota Alert background worker.
 *
 * Runs every 5 minutes (`@Cron('*\/5 * * * *')`). For each enabled
 * `notification_quota_alerts` row:
 *   1. Compute current quota window key
 *      - email: `YYYY-MM-DD` (UTC)
 *      - line:  `YYYY-MM`    (UTC)
 *   2. If `last_fired_window_key !== currentKey` → reset `last_fired_at`
 *      (window rollover so next-window crossings can re-fire).
 *   3. Skip if already fired this window (`last_fired_window_key === currentKey
 *      && last_fired_at !== null`).
 *   4. Aggregate `sent` count for the window via the stats services.
 *   5. If `sent / quota * 100 >= thresholdPercent` → fire alert email.
 *   6. Mark `last_fired_at = NOW(), last_fired_window_key = currentKey`.
 *
 * Alert path bypasses the citizen-facing pipeline:
 *   - Goes directly via `EmailService.sendEmail` (the W90 sandbox guard
 *     still applies — no live mail in dev/staging).
 *   - Skips the kill-switch check (alerts ARE the kill-switch monitor;
 *     the recipient is operator-only and the DTO restricts to a
 *     super-admin-supplied address).
 *   - Skips verification gate (recipient may not be a registered user).
 *   - Skips `NotificationsEmailService.queueEmail` entirely so it does
 *     not write to `notification_email_logs` (alerts are operator-only;
 *     mixing them with the citizen-volume audit pollutes the dashboards).
 *
 * Source-of-truth guardrails:
 *   - §4.1, §17.2 — advisory; never gates a workflow
 *   - §12         — never writes `tracking_status`
 *   - §17.3       — alert rows reference users via SET NULL only
 *   - W83         — `recipientEmail` masked in every log line
 *   - W90         — `EmailService.sendEmail` is the single chokepoint
 */
@Injectable()
export class QuotaAlertWorkerService {
  private readonly logger = new Logger(QuotaAlertWorkerService.name);

  constructor(
    private readonly alerts: NotificationQuotaAlertsService,
    private readonly emailStats: EmailStatsService,
    private readonly lineStats: LineStatsService,
    private readonly emailService: EmailService,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly usersService: UsersService,
  ) {}

  /**
   * W98 follow-up — fetch every active admin / super-admin email
   * address. Used as the recipient list when an alert row carries a
   * NULL `recipientEmail` (the new W98 default).
   *
   * Decrypts `users.email` via `UsersService.decryptUserPii` because
   * the column is encrypted at rest under W89. Skips users whose
   * decrypt fails or returns falsy. Deduplicates the final list.
   *
   * Read-only path — no audit row, no tracking_status write.
   */
  private async resolveAdminLeadEmails(): Promise<string[]> {
    const users = await this.userRepo
      .createQueryBuilder('u')
      .innerJoin('u.workHistories', 'wh', 'wh.is_current = true')
      .innerJoin('wh.role', 'r', "r.name IN ('admin', 'super-admin')")
      .innerJoin('wh.workStatus', 'ws', "ws.name = 'approved'")
      .where('u.email IS NOT NULL')
      .getMany();

    const emails = new Set<string>();
    for (const u of users) {
      try {
        await this.usersService.decryptUserPii(u);
      } catch {
        // decryption failed — skip this user; never block other admins
        continue;
      }
      const e = (u.email ?? '').trim().toLowerCase();
      if (e) emails.add(e);
    }
    return Array.from(emails);
  }

  @Cron('*/5 * * * *')
  async tick(): Promise<void> {
    let rows: NotificationQuotaAlert[];
    try {
      rows = await this.alerts.listEnabled();
    } catch (err) {
      this.logger.warn(
        `[QuotaAlertWorker] enabled-alerts read failed: ${(err as Error).message}`,
      );
      return;
    }
    if (rows.length === 0) return;

    const now = new Date();
    for (const row of rows) {
      try {
        await this.processOne(row, now);
      } catch (err) {
        // Per-row try/catch so one bad row does not stall the loop.
        this.logger.warn(
          `[QuotaAlertWorker] alert id=${row.id} channel=${row.channel} failed: ${(err as Error).message}`,
        );
      }
    }
  }

  private async processOne(
    row: NotificationQuotaAlert,
    now: Date,
  ): Promise<void> {
    const window = this.resolveWindow(row.channel, now);
    const currentKey = window.key;

    // Step 2 — window rollover: if the row's stored key differs from
    // the current key, reset (and continue evaluation against the
    // fresh window).
    if (row.lastFiredWindowKey && row.lastFiredWindowKey !== currentKey) {
      await this.alerts.resetFired(row.id, currentKey);
      row.lastFiredAt = null;
      row.lastFiredWindowKey = currentKey;
    }

    // Step 3 — already fired this window.
    if (row.lastFiredWindowKey === currentKey && row.lastFiredAt !== null) {
      return;
    }

    // Step 4 — aggregate sent count + resolve quota total.
    const quotaTotal =
      row.channel === 'email'
        ? Number(process.env.EMAIL_DAILY_QUOTA ?? 500) || 500
        : Number(process.env.LINE_MONTHLY_QUOTA ?? 1000) || 1000;

    const sentCount =
      row.channel === 'email'
        ? await this.emailStats.getSentCount(window.from, window.to)
        : await this.lineStats.getSentCount(window.from, window.to);

    const percentUsed = quotaTotal > 0 ? (sentCount / quotaTotal) * 100 : 0;

    if (percentUsed < row.thresholdPercent) return;

    // Step 5 — fire alert email (W90 sandbox guard inside `sendEmail`).
    const remaining = Math.max(0, quotaTotal - sentCount);
    const resetText = this.describeResetTime(row.channel, now);
    const pctRounded = Math.round(percentUsed * 100) / 100;

    const subject = `[Project Bank Alert] ${row.channel} quota at ${pctRounded}%`;
    const text = [
      `Channel:       ${row.channel}`,
      `Threshold:     ${row.thresholdPercent}%`,
      `Current usage: ${sentCount} / ${quotaTotal} (${pctRounded}%)`,
      `Remaining:     ${remaining}`,
      `Window:        ${window.from.toISOString()} → ${window.to.toISOString()}`,
      `Window resets: ${resetText}`,
      '',
      'This is an advisory notification. The pipeline has NOT been stopped.',
      'Source-of-truth: docs/tasks/wave97/W97-API-QUOTA.md',
    ].join('\n');

    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:600px">
        <h2 style="color:#b91c1c;margin:0 0 12px">Quota alert — ${row.channel}</h2>
        <p>Threshold <b>${row.thresholdPercent}%</b> reached.</p>
        <table cellpadding="6" style="border-collapse:collapse">
          <tr><td><b>Current usage</b></td><td>${sentCount} / ${quotaTotal} (${pctRounded}%)</td></tr>
          <tr><td><b>Remaining</b></td><td>${remaining}</td></tr>
          <tr><td><b>Window</b></td><td>${window.from.toISOString()} → ${window.to.toISOString()}</td></tr>
          <tr><td><b>Window resets</b></td><td>${resetText}</td></tr>
        </table>
        <p style="color:#6b7280;font-size:12px;margin-top:16px">
          Advisory only — pipeline NOT stopped. See docs/tasks/wave97/W97-API-QUOTA.md.
        </p>
      </div>
    `;

    // W98 follow-up — resolve recipients. If the row carries an explicit
    // `recipientEmail` (W97 contract / legacy rows), use that single
    // address. Otherwise fan out to every active admin + super-admin
    // mailbox. If neither path yields an address, skip firing for this
    // tick and try again later — DO NOT mark fired so the alert reaches
    // someone once accounts exist.
    const explicit = (row.recipientEmail ?? '').trim();
    const recipients = explicit
      ? [explicit]
      : await this.resolveAdminLeadEmails();

    if (recipients.length === 0) {
      this.logger.warn(
        `[QuotaAlertWorker] no recipients channel=${row.channel} threshold=${row.thresholdPercent}% — skipping; will retry next tick`,
      );
      return;
    }

    // Send to every recipient; one transient failure does not stall
    // the rest. Mark fired only if AT LEAST ONE send succeeds.
    let anySuccess = false;
    let lastError: string | undefined;
    let anySandboxed = false;
    for (const to of recipients) {
      const r = await this.emailService.sendEmail({ to, subject, text, html });
      if (r.success) {
        anySuccess = true;
        if (r.sandboxed) anySandboxed = true;
      } else {
        lastError = r.error;
        this.logger.warn(
          `[QuotaAlertWorker] sendEmail failed channel=${row.channel} to=${maskEmail(to)} err=${r.error}`,
        );
      }
    }

    if (!anySuccess) {
      this.logger.warn(
        `[QuotaAlertWorker] all sends failed channel=${row.channel} threshold=${row.thresholdPercent}% lastError=${lastError ?? 'unknown'}`,
      );
      // Do NOT mark fired — a transient send failure should retry next tick.
      return;
    }

    // Step 6 — record firing. (Sandboxed sends still mark fired so a dev
    // env does not loop alerts every 5 minutes.)
    await this.alerts.markFired(row.id, currentKey);
    this.logger.log(
      `[QuotaAlertWorker] fired channel=${row.channel} threshold=${row.thresholdPercent}% used=${pctRounded}% recipients=${recipients.length} explicit=${!!explicit} sandboxed=${anySandboxed}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Window helpers (UTC)
  // ---------------------------------------------------------------------------

  private resolveWindow(
    channel: 'email' | 'line',
    now: Date,
  ): { from: Date; to: Date; key: string } {
    if (channel === 'email') {
      const from = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          0,
          0,
          0,
          0,
        ),
      );
      const key = `${from.getUTCFullYear()}-${this.pad(from.getUTCMonth() + 1)}-${this.pad(from.getUTCDate())}`;
      return { from, to: now, key };
    }
    // line — calendar month UTC
    const from = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
    );
    const key = `${from.getUTCFullYear()}-${this.pad(from.getUTCMonth() + 1)}`;
    return { from, to: now, key };
  }

  private describeResetTime(channel: 'email' | 'line', now: Date): string {
    if (channel === 'email') {
      const next = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate() + 1,
          0,
          0,
          0,
          0,
        ),
      );
      return `${next.toISOString()} (next UTC day)`;
    }
    const next = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0),
    );
    return `${next.toISOString()} (next UTC month)`;
  }

  private pad(n: number): string {
    return n < 10 ? `0${n}` : `${n}`;
  }
}
