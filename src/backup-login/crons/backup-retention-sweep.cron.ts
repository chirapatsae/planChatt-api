import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * SECURITY-01 §7.12.2 — daily retention sweep of
 * `backup_login_audit_logs`. Deletes rows where `attempted_at <
 * NOW() - 730 days`.
 *
 * The `BEFORE DELETE` trigger on the table rejects any DELETE that is
 * NOT inside a transaction with `app.retention_sweep_in_progress =
 * 'true'`. This cron is the SOLE consumer of that escape hatch.
 *
 * §17.2 advisory — failure logs but MUST NOT crash the app.
 */
@Injectable()
export class BackupRetentionSweepCron {
  private readonly logger = new Logger(BackupRetentionSweepCron.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  // 03:00 server time, every day.
  @Cron('0 3 * * *')
  async run(): Promise<void> {
    try {
      const deleted = await this.dataSource.transaction(async (em) => {
        await em.query(`SET LOCAL app.retention_sweep_in_progress = 'true'`);
        const result: Array<{ id: string }> = await em.query(
          `DELETE FROM backup_login_audit_logs
           WHERE attempted_at < NOW() - INTERVAL '730 days'
           RETURNING id`,
        );
        return result.length;
      });
      this.logger.log(
        `[BackupRetentionSweep] deleted ${deleted} row(s) older than 730d`,
      );
    } catch (err) {
      this.logger.error(
        `[BackupRetentionSweep] failed: ${(err as Error).message}`,
      );
    }

    // Batch 2 — staff_session retention. Delete rows whose expiry OR revoke is
    // older than a 7-day grace (so a recently-used device lingers briefly in
    // the device-manager listing). Independent try so a session-sweep failure
    // never masks the audit-log sweep above. `staff_session` carries NO
    // BEFORE-DELETE trigger (unlike backup_login_audit_logs), so a plain
    // batched DELETE is sufficient; `revoked_at < ...` never matches a NULL
    // (still-active) row.
    await this.sweepStaffSessions();
  }

  /** Purge expired / revoked `staff_session` rows past the 7-day grace. */
  private async sweepStaffSessions(): Promise<void> {
    try {
      const result: Array<{ id: string }> = await this.dataSource.query(
        `DELETE FROM staff_session
         WHERE id IN (
           SELECT id FROM staff_session
           WHERE expires_at < NOW() - INTERVAL '7 days'
              OR revoked_at < NOW() - INTERVAL '7 days'
           LIMIT 5000
         )
         RETURNING id`,
      );
      this.logger.log(
        `[BackupRetentionSweep] deleted ${result.length} staff_session row(s) past 7d grace`,
      );
    } catch (err) {
      this.logger.error(
        `[BackupRetentionSweep] staff_session sweep failed: ${(err as Error).message}`,
      );
    }
  }
}
