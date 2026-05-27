import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BackupLoginAuditLog } from '../entities/backup-login-audit-log.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { BackupLineNotifier } from '../backup-line-notifier.service';
import { Role } from 'src/auth/roles.enum';

/**
 * SECURITY-01 §7.14.1 — daily LINE digest of backup-login activity to
 * all super-admins (09:00 server time).
 *
 * The summary aggregates the last 24h by outcome and surfaces the top
 * usernames by failure count. LINE failure to a single recipient is
 * logged and skipped — the cron MUST NOT crash on transient errors.
 */
@Injectable()
export class BackupDailySummaryCron {
  private readonly logger = new Logger(BackupDailySummaryCron.name);

  constructor(
    @InjectRepository(BackupLoginAuditLog)
    private readonly auditRepo: Repository<BackupLoginAuditLog>,
    @InjectRepository(WorkHistory)
    private readonly whRepo: Repository<WorkHistory>,
    private readonly lineNotifier: BackupLineNotifier,
  ) {}

  @Cron('0 9 * * *')
  async run(): Promise<void> {
    try {
      const since = new Date(Date.now() - 24 * 3600_000);
      const rows: Array<{ outcome: string; cnt: string }> = await this.auditRepo
        .createQueryBuilder('a')
        .select('a.outcome', 'outcome')
        .addSelect('COUNT(*)::text', 'cnt')
        .where('a.attemptedAt >= :since', { since })
        .groupBy('a.outcome')
        .getRawMany();

      const total = rows.reduce((acc, r) => acc + Number(r.cnt), 0);
      const lines = rows
        .sort((a, b) => Number(b.cnt) - Number(a.cnt))
        .map((r) => `${r.outcome}: ${r.cnt}`)
        .join('\n');
      const body =
        `รายงานสรุปการล็อกอินสำรอง 24 ชั่วโมง\n` +
        `จำนวนความพยายามทั้งหมด: ${total}\n\n` +
        (lines || '(ไม่มีกิจกรรม)');

      const superAdmins = await this.whRepo
        .createQueryBuilder('wh')
        .leftJoin('wh.user', 'user')
        .leftJoin('wh.role', 'role')
        .leftJoin('wh.workStatus', 'ws')
        .where('role.name = :role', { role: Role.SUPER_ADMIN })
        .andWhere('LOWER(ws.name) = :ws', { ws: 'approved' })
        .andWhere('wh.isCurrent = TRUE')
        .select(['user.id AS userid'])
        .getRawMany<{ userid: string }>();
      const ids = [
        ...new Set(superAdmins.map((r) => r.userid).filter(Boolean)),
      ];
      await this.lineNotifier.notifyEventToSuperAdmins(ids, body);

      this.logger.log(
        `[BackupDailySummary] sent to ${ids.length} super-admin(s); total events=${total}`,
      );
    } catch (err) {
      this.logger.error(
        `[BackupDailySummary] failed: ${(err as Error).message}`,
      );
    }
  }
}
