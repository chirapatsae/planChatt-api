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
  }
}
