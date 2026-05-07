import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { NotificationLineLog } from '../entities/notification-line-log.entity';

/**
 * Wave 97 — LINE-channel quota-window aggregation service.
 *
 * Mirrors `EmailStatsService.getQuotaWindow` but reads
 * `notification_line_logs` and emits the LINE 8-status vocabulary:
 *
 *   - 'queued'
 *   - 'sent'
 *   - 'failed'
 *   - 'skipped-killswitch'
 *   - 'skipped-no-binding'      (alias of 'skipped-not-linked')
 *   - 'skipped-not-opted-in'    (alias of 'skipped-preference')
 *   - 'skipped-event-not-allowed' (alias of 'skipped-allowlist')
 *   - 'skipped-unlinked'        (binding disappeared between enqueue/dispatch)
 *
 * The DB stores the canonical LINE statuses listed in
 * `NotificationLineLog.status`. The W97 quota response expects the
 * dashboard-friendly aliases above. Translation happens in this service
 * so the controller envelope matches the spec contract exactly.
 *
 * Source-of-truth guardrails:
 *   - CLAUDE.md §4.1   — advisory only; never gates a workflow
 *   - CLAUDE.md §17.2  — staff retains final decision authority
 *   - W83             — recipient line-user-ids are NEVER read or returned
 *                       by this service; only aggregate counts.
 *
 * Lean on these indexes (created by the W96 migration):
 *   - `ix_notification_line_logs_event_status` — by-status / byEvent path
 *   - `ix_notification_line_logs_queued_at`     — date-range slicing
 */
@Injectable()
export class LineStatsService {
  constructor(
    @InjectRepository(NotificationLineLog)
    private readonly lineLogRepo: Repository<NotificationLineLog>,
  ) {}

  /**
   * Map the DB-stored LINE status to the dashboard-facing alias.
   *
   * 'skipped-not-linked'  → 'skipped-no-binding'
   * 'skipped-preference'  → 'skipped-not-opted-in'
   * 'skipped-allowlist'   → 'skipped-event-not-allowed'
   *
   * All other values pass through verbatim. Unknown statuses are
   * preserved so an ops-side data anomaly is visible in the response
   * rather than silently dropped (matches `EmailStatsService` behavior).
   */
  private toQuotaStatus(raw: string): string {
    switch (raw) {
      case 'skipped-not-linked':
        return 'skipped-no-binding';
      case 'skipped-preference':
        return 'skipped-not-opted-in';
      case 'skipped-allowlist':
        return 'skipped-event-not-allowed';
      default:
        return raw;
    }
  }

  /**
   * Quota-window aggregation. Caller passes resolved Date objects so the
   * controller can stamp the matching `windowStart`/`windowEnd` into the
   * response envelope. Default LINE window is the current calendar month
   * UTC (computed at the controller level).
   */
  async getQuotaWindow(
    fromDate: Date,
    toDate: Date,
  ): Promise<{
    byStatus: Record<string, number>;
    byEvent: Array<{
      eventType: string;
      sent: number;
      failed: number;
      skipped: number;
    }>;
  }> {
    const statusRows = await this.lineLogRepo
      .createQueryBuilder('log')
      .select('log.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('log.queued_at >= :from', { from: fromDate })
      .andWhere('log.queued_at <= :to', { to: toDate })
      .groupBy('log.status')
      .getRawMany<{ status: string; count: string }>();

    const byStatus: Record<string, number> = {};
    for (const r of statusRows) {
      const key = this.toQuotaStatus(r.status);
      byStatus[key] = (byStatus[key] ?? 0) + (Number(r.count) || 0);
    }

    const eventRows = await this.lineLogRepo
      .createQueryBuilder('log')
      .select('log.event_type', 'eventType')
      .addSelect('log.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('log.queued_at >= :from', { from: fromDate })
      .andWhere('log.queued_at <= :to', { to: toDate })
      .groupBy('log.event_type')
      .addGroupBy('log.status')
      .getRawMany<{ eventType: string; status: string; count: string }>();

    const eventMap = new Map<
      string,
      {
        eventType: string;
        sent: number;
        failed: number;
        skipped: number;
        total: number;
      }
    >();
    for (const r of eventRows) {
      const n = Number(r.count) || 0;
      let entry = eventMap.get(r.eventType);
      if (!entry) {
        entry = {
          eventType: r.eventType,
          sent: 0,
          failed: 0,
          skipped: 0,
          total: 0,
        };
        eventMap.set(r.eventType, entry);
      }
      // Use the alias-translated status to classify the bucket; "skipped"
      // covers ANY skipped-* prefix.
      if (r.status === 'sent') entry.sent += n;
      else if (r.status === 'failed') entry.failed += n;
      else if (r.status?.startsWith('skipped-')) entry.skipped += n;
      entry.total += n;
    }

    const byEvent = Array.from(eventMap.values())
      .sort((a, b) => b.total - a.total)
      .slice(0, 50)
      .map(({ eventType, sent, failed, skipped }) => ({
        eventType,
        sent,
        failed,
        skipped,
      }));

    return { byStatus, byEvent };
  }

  /**
   * Sum of `sent` rows in the given window. Used by the alert worker to
   * compute `percentUsed` against `LINE_MONTHLY_QUOTA`.
   */
  async getSentCount(fromDate: Date, toDate: Date): Promise<number> {
    const row = await this.lineLogRepo
      .createQueryBuilder('log')
      .select('COUNT(*)', 'count')
      .where('log.status = :status', { status: 'sent' })
      .andWhere('log.queued_at >= :from', { from: fromDate })
      .andWhere('log.queued_at <= :to', { to: toDate })
      .getRawOne<{ count: string }>();
    return Number(row?.count ?? 0) || 0;
  }

  /**
   * Wave 97 visual amendment — daily-bucket time series for the LINE
   * channel comparison chart. Mirrors `EmailStatsService.getByDay` but
   * reads `notification_line_logs` and emits the `sent` count per UTC day.
   * Other statuses are omitted because the comparison chart only plots
   * "successful sends" (i.e. quota actually consumed).
   *
   * Returns rows sorted by bucket ASC. Buckets with zero `sent` are
   * intentionally NOT padded — the consumer (FE) is responsible for
   * filling missing days when rendering a continuous timeline.
   */
  async getSentByDay(
    fromDate: Date,
    toDate: Date,
  ): Promise<Array<{ bucket: string; sent: number }>> {
    // W97 amendment — bucket by **Asia/Bangkok** day so the chart's
    // "today" matches the operator's local calendar. Using UTC days here
    // misaligned: a 08:00 Bangkok send (01:00 UTC) was previously bucketed
    // under the previous UTC day, and the operator perceived "yesterday's
    // total bleeding into today". `to_char` returns a stable YYYY-MM-DD
    // string keyed by the Bangkok-local day even when `queued_at` straddles
    // UTC midnight.
    const rows = await this.lineLogRepo
      .createQueryBuilder('log')
      .select(
        `to_char(log.queued_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD')`,
        'bucket',
      )
      .addSelect('COUNT(*)', 'count')
      .where('log.queued_at >= :from', { from: fromDate })
      .andWhere('log.queued_at <= :to', { to: toDate })
      .andWhere('log.status = :status', { status: 'sent' })
      .groupBy('bucket')
      .orderBy('bucket', 'ASC')
      .getRawMany<{ bucket: string; count: string }>();

    return rows.map((r) => ({
      bucket: r.bucket,
      sent: Number(r.count) || 0,
    }));
  }
}
