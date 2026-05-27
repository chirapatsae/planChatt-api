import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { KillSwitchService } from './kill-switch.service';

/**
 * Boot-time hooks for the backup-login subsystem.
 *
 *   1. Seed the kill-switch row (`BACKUP_LOGIN_ENABLED='true'`) if
 *      missing — SECURITY-01 §7.10 default ON per user decision.
 *   2. Self-test the append-only triggers on
 *      `backup_login_audit_logs` (SECURITY-01 §7.12.3 — concern #3
 *      from the spec). If the trigger is missing, log loud + Sentry
 *      stub via `Logger.error` and DO NOT crash. Per the task brief
 *      "log loud warning + Sentry alert + DO NOT block boot".
 *      Crashing would block the entire app on a config drift; the
 *      louder option is observability.
 */
@Injectable()
export class BackupLoginBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BackupLoginBootstrapService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly killSwitch: KillSwitchService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.seedKillSwitch();
    await this.selfTestAppendOnlyTriggers();
  }

  private async seedKillSwitch(): Promise<void> {
    try {
      const inserted = await this.killSwitch.seedDefault();
      if (inserted) {
        this.logger.log('[BackupLogin] kill-switch row seeded (ON)');
      }
    } catch (err) {
      this.logger.error(
        `[BackupLogin] kill-switch seed failed: ${(err as Error).message}`,
      );
    }
  }

  private async selfTestAppendOnlyTriggers(): Promise<void> {
    try {
      // Insert a sentinel row, attempt UPDATE (must fail), attempt
      // DELETE (must fail), then DELETE inside the retention-sweep
      // escape hatch (must succeed). Each step rolls back via
      // SAVEPOINT so the sentinel does not leak into production data.
      const ok = await this.dataSource.transaction(async (em) => {
        const insertResult: Array<{ id: string }> = await em.query(
          `INSERT INTO backup_login_audit_logs
             (user_id, username_attempted, stage, ip_address, subnet_24,
              user_agent, outcome)
           VALUES
             (NULL, '__selftest__', 'bootstrap', '0.0.0.0', '0.0.0.0/32',
              'selftest', 'bootstrap')
           RETURNING id`,
        );
        const id = insertResult[0]?.id;
        if (!id) throw new Error('selftest insert returned no id');

        // SAVEPOINTs are REQUIRED here. Without them, the first
        // expected-to-fail UPDATE marks the whole transaction as
        // ABORTED and every subsequent command (including the escape-
        // hatch DELETE) errors with "current transaction is aborted".
        let updateBlocked = false;
        await em.query('SAVEPOINT sp_update_block');
        try {
          await em.query(
            `UPDATE backup_login_audit_logs SET outcome = 'success' WHERE id = $1`,
            [id],
          );
          // If we reach here, the trigger did NOT block — leave
          // updateBlocked=false so the self-test reports FAILED.
          await em.query('RELEASE SAVEPOINT sp_update_block');
        } catch {
          updateBlocked = true;
          await em.query('ROLLBACK TO SAVEPOINT sp_update_block');
        }

        let deleteBlocked = false;
        await em.query('SAVEPOINT sp_delete_block');
        try {
          await em.query(
            `DELETE FROM backup_login_audit_logs WHERE id = $1`,
            [id],
          );
          await em.query('RELEASE SAVEPOINT sp_delete_block');
        } catch {
          deleteBlocked = true;
          await em.query('ROLLBACK TO SAVEPOINT sp_delete_block');
        }

        // Now delete with the escape hatch — must succeed.
        let escapeWorks = false;
        try {
          await em.query(`SET LOCAL app.retention_sweep_in_progress = 'true'`);
          await em.query(
            `DELETE FROM backup_login_audit_logs WHERE id = $1`,
            [id],
          );
          escapeWorks = true;
        } catch (err) {
          this.logger.error(
            `[BackupLogin] retention escape-hatch DELETE failed: ${(err as Error).message}`,
          );
        }

        return updateBlocked && deleteBlocked && escapeWorks;
      });

      if (ok) {
        this.logger.log(
          '[BackupLogin] append-only trigger self-test PASSED',
        );
      } else {
        this.logger.error(
          '[BackupLogin] append-only trigger self-test FAILED — apply backend/src/backup-login/sql/backup-login-audit-log.triggers.sql immediately',
        );
      }
    } catch (err) {
      this.logger.error(
        `[BackupLogin] self-test errored (not crashing app): ${(err as Error).message}`,
      );
    }
  }
}
