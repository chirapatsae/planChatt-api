/**
 * W107-BE-PR1 — Nightly System Usage Rollup Cron + Backfill helper.
 *
 * Source of truth:
 *   - docs/tasks/wave107/W107-PLAN-SYSTEM-USAGE-STATS.md
 *   - docs/tasks/wave107/W107-BE-PR1-ROLLUP-CRON.md
 *   - docs/reports/wave107/W107-DB-PR1-REPORT.md (open questions OQ1-OQ4)
 *   - CLAUDE.md §17.2 (advisory), §17.3 (audit separation)
 *
 * Responsibilities:
 *   1. On boot, ensure the COALESCE-based expression unique index
 *      `idx_system_usage_rollup_unique` exists. TypeORM's `@Index` cannot
 *      emit expression indices through `synchronize`, so DB-PR1 deferred
 *      this to BE-PR1 (DB-PR1 report §D2 / OQ1). The index is required so
 *      that NULL `amphoe_id` / `government_agency_id` segments collapse
 *      to a single canonical row under the UPSERT (Postgres treats NULL
 *      as distinct otherwise). OQ1 OPTION A — chosen.
 *
 *   2. Run @Cron('0 2 * * *', tz='Asia/Bangkok') and roll up the
 *      previous ICT calendar day into `system_usage_daily_rollups`.
 *
 *   3. Expose `rollupForDate(bucketDate)` so the backfill CLI can call
 *      the same code path as the cron (DRY).
 *
 * §17.2 — output is advisory metadata; no workflow service is invoked.
 * §17.3 — writes go ONLY to `system_usage_daily_rollups`. Reads from
 *         tracking_status / users / comment / ai_usage_logs /
 *         notification_email_logs / notification_line_logs are SELECT
 *         only and are explicitly read-only compute (§17.6).
 * §4.1   — no project-table imports anywhere in this file (grep gate).
 */

import {
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Canonical role whitelist applied at write time (DB-PR1 D4 / OQ5
 * forward-compat). Roles outside this list are discarded so the rollup
 * never accumulates rows for stale or test-only role names.
 */
const CANONICAL_ROLES = new Set([
  'user',
  'staff',
  'admin',
  'super-admin',
  'c-level',
]);

/**
 * Internal aggregate map key for one (role × amphoe_id × government_agency_id)
 * segment. NULLs are normalized to the empty string in the key to match
 * the COALESCE expression in the unique index (OQ1).
 */
type SegmentKey = string;

interface SegmentRow {
  role: string;
  amphoeId: string | null;
  governmentAgencyId: string | null;
  dauCount: number;
  loginCount: number;
  transitionCount: number;
  commentCount: number;
  pdfExportCount: number;
  aiInvocationCount: number;
  notificationCount: number;
}

/**
 * Compute the previous ICT (Asia/Bangkok = UTC+7) calendar day relative to
 * the supplied "now" instant. Returns 'YYYY-MM-DD'.
 *
 * The cron decorator already pins the trigger to Asia/Bangkok, so when it
 * fires at 02:00 ICT the "yesterday" we want is the calendar date that
 * just ended at 00:00 ICT two hours earlier. Computing this from raw UTC
 * components avoids any host-timezone drift (the staging container could
 * be UTC, ICT, or anything else).
 */
function previousIctDateString(now: Date = new Date()): string {
  const ictMs = now.getTime() + 7 * 60 * 60 * 1000;
  const ictNow = new Date(ictMs);
  // ictNow is a Date whose UTC components describe the ICT clock face.
  // "Previous ICT day" = (ictNow − 1 day).getUTCDate().
  ictNow.setUTCDate(ictNow.getUTCDate() - 1);
  const y = ictNow.getUTCFullYear();
  const m = String(ictNow.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ictNow.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

@Injectable()
export class RollupCronService implements OnModuleInit {
  private readonly logger = new Logger(RollupCronService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    this.logger.log(
      '[SystemUsage] cron registered: rollup at 02:00 (Asia/Bangkok)',
    );
  }

  /**
   * Bootstrap: ensure the COALESCE-based expression unique index exists.
   * Idempotent via `IF NOT EXISTS`. Must run before any rollup attempt
   * (cron or backfill) so UPSERT can pin to the conflict target.
   */
  async onModuleInit(): Promise<void> {
    try {
      // The information_schema check makes the boot log clean: we only
      // emit the "created" line when the index was actually missing.
      const existing: Array<{ indexname: string }> = await this.dataSource.query(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = current_schema()
           AND tablename  = 'system_usage_daily_rollups'
           AND indexname  = 'idx_system_usage_rollup_unique'
         LIMIT 1`,
      );

      await this.dataSource.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_system_usage_rollup_unique
         ON system_usage_daily_rollups (
           bucket_date,
           role,
           COALESCE(amphoe_id, ''),
           COALESCE(government_agency_id, '')
         )`,
      );

      if (existing.length === 0) {
        this.logger.log(
          '[SystemUsage] created idx_system_usage_rollup_unique',
        );
      }
    } catch (e: any) {
      // The base table may not yet exist on a brand-new DB if synchronize
      // ordering is racy. Swallow + log; the next boot will retry. We do
      // NOT crash the process — the cron will simply throw on first run
      // and surface in @nestjs/schedule failure stats, which is desired.
      this.logger.warn(
        `[SystemUsage] could not ensure rollup unique index: ${e?.message ?? e}`,
      );
    }
  }

  /**
   * Cron entry: 02:00 ICT every day. Always rolls up the *previous* ICT
   * day so the cron has a settled close-of-business window. Wrapped in
   * try/catch so a partial failure logs cleanly without crashing the
   * scheduler thread; the throw afterward lets @nestjs/schedule record
   * the failure in its run history.
   */
  @Cron('0 2 * * *', { timeZone: 'Asia/Bangkok' })
  async runNightly(): Promise<void> {
    const bucketDate = previousIctDateString();
    this.logger.log(`[SystemUsage] nightly rollup start bucket=${bucketDate}`);
    try {
      const rowsWritten = await this.rollupForDate(bucketDate);
      this.logger.log(
        `[SystemUsage] nightly rollup ok bucket=${bucketDate} rows=${rowsWritten}`,
      );
    } catch (e: any) {
      this.logger.error(
        `[SystemUsage] nightly rollup FAILED bucket=${bucketDate}: ${e?.message ?? e}`,
        e?.stack,
      );
      throw e;
    }
  }

  /**
   * Public entry used by both the cron and the backfill CLI.
   *
   * Idempotent: rerunning for the same `bucketDate` produces an identical
   * row per (role, amphoe_id, government_agency_id) segment because the
   * UPSERT key is exactly that tuple (with NULLs collapsed via COALESCE)
   * and all metric inputs are immutable historical data.
   *
   * @param bucketDate ICT calendar date as 'YYYY-MM-DD'
   * @returns number of rollup rows UPSERTed for this day
   */
  async rollupForDate(bucketDate: string): Promise<number> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bucketDate)) {
      throw new Error(
        `[SystemUsage] invalid bucketDate (expected YYYY-MM-DD): ${bucketDate}`,
      );
    }
    const t0 = Date.now();

    // Compute UTC half-open range [bucketDate 00:00 ICT, bucketDate+1 00:00 ICT).
    // ICT = UTC+7, so the UTC instants are (bucketDate − 7h, bucketDate+1 − 7h).
    const dayStartIct = new Date(`${bucketDate}T00:00:00+07:00`);
    const dayEndIct = new Date(dayStartIct.getTime() + 24 * 60 * 60 * 1000);
    const startUtc = dayStartIct.toISOString();
    const endUtc = dayEndIct.toISOString();

    // Aggregate every metric into a single in-memory map keyed by
    // (role, amphoeId, governmentAgencyId). Each per-metric SQL is a
    // pure SELECT — no writes to source tables (§17.3 grep gate).
    const segments = new Map<SegmentKey, SegmentRow>();

    // ---- 1) DAU: distinct user_ids active in the day ----------------
    // Activity = users.last_seen_at IN range OR tracking_status authored
    // by the user's WorkHistory in range. Attribution uses the user's
    // CURRENT WorkHistory so the user falls into a single segment.
    const dauRows: Array<{
      role: string | null;
      amphoe_id: string | null;
      government_agency_id: string | null;
      dau_count: string;
    }> = await this.dataSource.query(
      `SELECT
         COALESCE(r.name, 'user')        AS role,
         wh.amphoe_id                     AS amphoe_id,
         wh.government_agencies_id        AS government_agency_id,
         COUNT(DISTINCT u.id)             AS dau_count
       FROM users u
       LEFT JOIN work_history wh
              ON wh.user_id = u.id
             AND wh.is_current = true
             AND wh.deleted_at IS NULL
       LEFT JOIN roles r ON r.id = wh.role_id
       WHERE u.delete_at IS NULL
         AND (
           (u.last_seen_at >= $1 AND u.last_seen_at < $2)
           OR EXISTS (
             SELECT 1 FROM tracking_status ts
             JOIN work_history wh2 ON wh2.id = ts.created_by
             WHERE wh2.user_id = u.id
               AND ts.create_at >= $1
               AND ts.create_at <  $2
               AND ts."deletedAt" IS NULL
           )
         )
       GROUP BY role, wh.amphoe_id, wh.government_agencies_id`,
      [startUtc, endUtc],
    );
    for (const row of dauRows) {
      const seg = this.touchSegment(segments, row.role, row.amphoe_id, row.government_agency_id);
      if (!seg) continue;
      seg.dauCount = Number(row.dau_count) || 0;
    }

    // ---- 2) Login proxy: distinct user_ids whose last_seen_at is in range
    const loginRows: Array<{
      role: string | null;
      amphoe_id: string | null;
      government_agency_id: string | null;
      login_count: string;
    }> = await this.dataSource.query(
      `SELECT
         COALESCE(r.name, 'user')        AS role,
         wh.amphoe_id                     AS amphoe_id,
         wh.government_agencies_id        AS government_agency_id,
         COUNT(DISTINCT u.id)             AS login_count
       FROM users u
       LEFT JOIN work_history wh
              ON wh.user_id = u.id
             AND wh.is_current = true
             AND wh.deleted_at IS NULL
       LEFT JOIN roles r ON r.id = wh.role_id
       WHERE u.delete_at IS NULL
         AND u.last_seen_at >= $1
         AND u.last_seen_at <  $2
       GROUP BY role, wh.amphoe_id, wh.government_agencies_id`,
      [startUtc, endUtc],
    );
    for (const row of loginRows) {
      const seg = this.touchSegment(segments, row.role, row.amphoe_id, row.government_agency_id);
      if (!seg) continue;
      seg.loginCount = Number(row.login_count) || 0;
    }

    // ---- 3) Transitions: tracking_status rows in range, attributed by
    // the actor's WorkHistory at action time.
    const transitionRows: Array<{
      role: string | null;
      amphoe_id: string | null;
      government_agency_id: string | null;
      transition_count: string;
    }> = await this.dataSource.query(
      `SELECT
         COALESCE(r.name, 'user')        AS role,
         wh.amphoe_id                     AS amphoe_id,
         wh.government_agencies_id        AS government_agency_id,
         COUNT(*)                         AS transition_count
       FROM tracking_status ts
       LEFT JOIN work_history wh ON wh.id = ts.created_by
       LEFT JOIN roles r ON r.id = wh.role_id
       WHERE ts.create_at >= $1
         AND ts.create_at <  $2
         AND ts."deletedAt" IS NULL
       GROUP BY role, wh.amphoe_id, wh.government_agencies_id`,
      [startUtc, endUtc],
    );
    for (const row of transitionRows) {
      const seg = this.touchSegment(segments, row.role, row.amphoe_id, row.government_agency_id);
      if (!seg) continue;
      seg.transitionCount = Number(row.transition_count) || 0;
    }

    // ---- 4) Comments: comment.create_at in range, attributed via the
    // tracking_status row -> work_history. NB: comment table is `comment`
    // (singular).
    const commentRows: Array<{
      role: string | null;
      amphoe_id: string | null;
      government_agency_id: string | null;
      comment_count: string;
    }> = await this.dataSource.query(
      `SELECT
         COALESCE(r.name, 'user')        AS role,
         wh.amphoe_id                     AS amphoe_id,
         wh.government_agencies_id        AS government_agency_id,
         COUNT(*)                         AS comment_count
       FROM comment c
       LEFT JOIN tracking_status ts ON ts.id = c.tracking_status_id
       LEFT JOIN work_history wh ON wh.id = ts.created_by
       LEFT JOIN roles r ON r.id = wh.role_id
       WHERE c.create_at >= $1
         AND c.create_at <  $2
       GROUP BY role, wh.amphoe_id, wh.government_agencies_id`,
      [startUtc, endUtc],
    );
    for (const row of commentRows) {
      const seg = this.touchSegment(segments, row.role, row.amphoe_id, row.government_agency_id);
      if (!seg) continue;
      seg.commentCount = Number(row.comment_count) || 0;
    }

    // ---- 5) PDF exports: no dedicated audit table exists for ad-hoc PDF
    // generation in this codebase (the `pdf_*_document` tables are
    // template / draft / approved book artifacts, not user-export events).
    // Per OQ4: leave at 0 and document the gap. A future wave that adds
    // a PDF export audit can plug into this method without breaking the
    // rollup contract.
    // pdfExportCount stays 0 for every segment.

    // ---- 6) AI invocations: ai_usage_logs.used_at in range, attributed
    // via actor_work_history_id -> work_history.
    const aiRows: Array<{
      role: string | null;
      amphoe_id: string | null;
      government_agency_id: string | null;
      ai_invocation_count: string;
    }> = await this.dataSource.query(
      `SELECT
         COALESCE(r.name, 'user')        AS role,
         wh.amphoe_id                     AS amphoe_id,
         wh.government_agencies_id        AS government_agency_id,
         COUNT(*)                         AS ai_invocation_count
       FROM ai_usage_logs aul
       LEFT JOIN work_history wh ON wh.id = aul.actor_work_history_id
       LEFT JOIN roles r ON r.id = wh.role_id
       WHERE aul.used_at >= $1
         AND aul.used_at <  $2
       GROUP BY role, wh.amphoe_id, wh.government_agencies_id`,
      [startUtc, endUtc],
    );
    for (const row of aiRows) {
      const seg = this.touchSegment(segments, row.role, row.amphoe_id, row.government_agency_id);
      if (!seg) continue;
      seg.aiInvocationCount = Number(row.ai_invocation_count) || 0;
    }

    // ---- 7) Notifications: email + line. Attribute via the actor's
    // current WorkHistory (the actor is the user whose action triggered
    // the notification — recipient attribution would mean a successful
    // workflow event inflates the recipient's role bucket, which is not
    // what the dashboard wants).
    const notificationRows: Array<{
      role: string | null;
      amphoe_id: string | null;
      government_agency_id: string | null;
      notification_count: string;
    }> = await this.dataSource.query(
      `SELECT
         COALESCE(r.name, 'user')        AS role,
         wh.amphoe_id                     AS amphoe_id,
         wh.government_agencies_id        AS government_agency_id,
         SUM(cnt)                         AS notification_count
       FROM (
         SELECT actor_work_history_id, 1 AS cnt
         FROM notification_email_logs
         WHERE queued_at >= $1 AND queued_at < $2
         UNION ALL
         SELECT actor_work_history_id, 1 AS cnt
         FROM notification_line_logs
         WHERE queued_at >= $1 AND queued_at < $2
       ) AS n
       LEFT JOIN work_history wh ON wh.id = n.actor_work_history_id
       LEFT JOIN roles r ON r.id = wh.role_id
       GROUP BY role, wh.amphoe_id, wh.government_agencies_id`,
      [startUtc, endUtc],
    );
    for (const row of notificationRows) {
      const seg = this.touchSegment(segments, row.role, row.amphoe_id, row.government_agency_id);
      if (!seg) continue;
      seg.notificationCount = Number(row.notification_count) || 0;
    }

    // -----------------------------------------------------------------
    // UPSERT every segment. ON CONFLICT relies on the OQ1 expression
    // index created in onModuleInit. Use a single transaction so a
    // mid-loop failure rolls back cleanly (per task spec §7.1.4).
    // -----------------------------------------------------------------
    let written = 0;
    await this.dataSource.transaction(async (tx) => {
      for (const seg of segments.values()) {
        await tx.query(
          `INSERT INTO system_usage_daily_rollups (
             bucket_date, role, amphoe_id, government_agency_id,
             dau_count, login_count, transition_count, comment_count,
             pdf_export_count, ai_invocation_count, notification_count
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (
             bucket_date, role,
             COALESCE(amphoe_id, ''),
             COALESCE(government_agency_id, '')
           )
           DO UPDATE SET
             dau_count           = EXCLUDED.dau_count,
             login_count         = EXCLUDED.login_count,
             transition_count    = EXCLUDED.transition_count,
             comment_count       = EXCLUDED.comment_count,
             pdf_export_count    = EXCLUDED.pdf_export_count,
             ai_invocation_count = EXCLUDED.ai_invocation_count,
             notification_count  = EXCLUDED.notification_count,
             updated_at          = now()`,
          [
            bucketDate,
            seg.role,
            seg.amphoeId,
            seg.governmentAgencyId,
            seg.dauCount,
            seg.loginCount,
            seg.transitionCount,
            seg.commentCount,
            seg.pdfExportCount,
            seg.aiInvocationCount,
            seg.notificationCount,
          ],
        );
        written++;
      }
    });

    const durationMs = Date.now() - t0;
    this.logger.log(
      `[SystemUsage] rollup bucket=${bucketDate} segments=${written} duration=${durationMs}ms`,
    );
    return written;
  }

  /**
   * Whitelist + materialize a segment. Returns null when the role is
   * not canonical (DB-PR1 D4) — those rows are silently dropped from
   * the rollup so stale role names never accumulate.
   */
  private touchSegment(
    segments: Map<SegmentKey, SegmentRow>,
    role: string | null,
    amphoeId: string | null,
    governmentAgencyId: string | null,
  ): SegmentRow | null {
    const canonical = role ?? 'user';
    if (!CANONICAL_ROLES.has(canonical)) {
      return null;
    }
    const key = `${canonical} ${amphoeId ?? ''} ${governmentAgencyId ?? ''}`;
    const existing = segments.get(key);
    if (existing) return existing;
    const fresh: SegmentRow = {
      role: canonical,
      amphoeId: amphoeId ?? null,
      governmentAgencyId: governmentAgencyId ?? null,
      dauCount: 0,
      loginCount: 0,
      transitionCount: 0,
      commentCount: 0,
      pdfExportCount: 0,
      aiInvocationCount: 0,
      notificationCount: 0,
    };
    segments.set(key, fresh);
    return fresh;
  }
}
