/**
 * W107-BE-PR2 — SystemUsageQueryService
 *
 * Read-only query service for the System Usage Statistics page.
 *
 * Source-of-truth:
 *   - docs/tasks/wave107/W107-BE-PR2-STATS-API.md §7.1, §7.2, §7.4, §7.5
 *   - docs/reports/wave107/W107-DB-PR1-REPORT.md (column names, types, OQ5–OQ8)
 *   - CLAUDE.md §17.2 (advisory), §17.3 (no audit-table writes)
 *
 * Two query modes:
 *   1. Rollup-backed — overview KPIs, timeseries, role-distribution. Reads
 *      `system_usage_daily_rollups` only.
 *   2. On-the-fly — top-users, heatmap, inactive-users. Reads raw
 *      `tracking_status`, `comment`, `users` tables. Strict §17.3
 *      compliance: NEVER writes to those tables.
 *
 * Date-range cap: all rollup-backed methods enforce a 365-day cap before
 * issuing the SQL (mirrored at the controller level via DTO validation).
 */

import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { RollupCronService } from '../rollup-cron.service';
import { SystemUsageDailyRollup } from '../entities/system-usage-daily-rollup.entity';
import {
  CANONICAL_ROLES,
  CanonicalRole,
  HeatmapMetric,
  HeatmapQueryDto,
  InactiveUsersQueryDto,
  MAX_DATE_RANGE_DAYS,
  MIN_FROM_DATE,
  OverviewQueryDto,
  RoleDistributionQueryDto,
  TimeseriesBucket,
  TimeseriesMetric,
  TimeseriesQueryDto,
  TopUsersMetric,
  TopUsersQueryDto,
} from '../dto/system-usage-query.dto';
import {
  HeatmapResponseDto,
  InactiveUsersResponseDto,
  OverviewResponseDto,
  RoleDistributionResponseDto,
  TimeseriesResponseDto,
  TopUsersResponseDto,
} from '../dto/system-usage-response.dto';

@Injectable()
export class SystemUsageQueryService {
  constructor(
    @InjectRepository(SystemUsageDailyRollup)
    private readonly rollupRepo: Repository<SystemUsageDailyRollup>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly rollupCron: RollupCronService,
  ) {}

  /**
   * Roll up TODAY's bucket on demand if the queried range includes today
   * (Asia/Bangkok). The nightly cron only writes "yesterday and earlier",
   * so without this hop the page reports 0 for "today" until tomorrow's
   * 02:00 cron — which made the page feel broken when a freshly-logged-in
   * user expected to see themselves in DAU. The rollup is UPSERT-keyed
   * (DB-PR1 / BE-PR1 OQ1), so calling it on every page load is idempotent
   * and cheap (~100-500ms in dev with seed data).
   *
   * Errors are SWALLOWED — a partial rollup must not 5xx the read endpoint.
   */
  private async ensureTodayRollup(from: string, to: string): Promise<void> {
    const todayIct = this.todayIctIsoDate();
    if (to < todayIct) return; // historical-only range, nothing to refresh
    if (from > todayIct) return; // future range, no source data
    try {
      await this.rollupCron.rollupForDate(todayIct);
    } catch (e: any) {
      // Best-effort. The endpoint still returns whatever the rollup
      // currently has plus zero for today.
      // eslint-disable-next-line no-console
      console.warn('[SystemUsage] ensureTodayRollup failed:', e?.message ?? e);
    }
  }

  /** Asia/Bangkok calendar date as ISO YYYY-MM-DD (no time component). */
  private todayIctIsoDate(): string {
    // toLocaleDateString with explicit timeZone gives a TZ-correct string,
    // then we normalise to ISO (en-CA emits YYYY-MM-DD).
    return new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Bangkok',
    });
  }

  // ---------------------------------------------------------------------------
  // A. Overview
  // ---------------------------------------------------------------------------

  async getOverview(q: OverviewQueryDto): Promise<OverviewResponseDto> {
    const { from, to, rangeDays } = this.validateAndNormalizeRange(q.from, q.to);
    await this.ensureTodayRollup(from, to);

    // Single sweep across the rollup, segmented by role / amphoe / agency.
    const qb = this.rollupRepo
      .createQueryBuilder('r')
      .select('SUM(r.dau_count)', 'dauSum')
      .addSelect('SUM(r.transition_count)', 'transitionSum')
      .addSelect('SUM(r.comment_count)', 'commentSum')
      .addSelect('SUM(r.pdf_export_count)', 'pdfSum')
      .addSelect('SUM(r.ai_invocation_count)', 'aiSum')
      .addSelect('SUM(r.notification_count)', 'notifSum')
      .addSelect('MAX(r.updated_at)', 'lastRollupAt')
      .where('r.bucket_date BETWEEN :from AND :to', { from, to });
    this.applySegmentFilters(qb, q);
    const totals: any = await qb.getRawOne();

    // DAU "today" = the latest bucket inside the range. We pick the
    // greatest bucket_date inside the filter so the KPI strip stays
    // useful even when the user picked a historical range.
    const latestBucket = (
      await this.rollupRepo
        .createQueryBuilder('r')
        .select('MAX(r.bucket_date)', 'latest')
        .where('r.bucket_date BETWEEN :from AND :to', { from, to })
        .getRawOne<{ latest: string | null }>()
    )?.latest ?? null;

    let dauToday = 0;
    if (latestBucket) {
      const dauTodayQb = this.rollupRepo
        .createQueryBuilder('r')
        .select('SUM(r.dau_count)', 'dauToday')
        .where('r.bucket_date = :d', { d: latestBucket });
      this.applySegmentFilters(dauTodayQb, q);
      const row: any = await dauTodayQb.getRawOne();
      dauToday = Number(row?.dauToday ?? 0);
    }

    // WAU/MAU rough proxies via rollup: SUM(dau) over trailing 7 / 28 days
    // ending at the latest bucket. The rollup-grain doesn't store distinct
    // user IDs so this overcounts slightly (a user active 3 distinct days
    // in the window contributes 3). Documented as a known proxy in the
    // master plan §11.
    const wau = await this.dauWindowSum(q, latestBucket, 7);
    const mau = await this.dauWindowSum(q, latestBucket, 28);

    const transitionsTotal = Number(totals?.transitionSum ?? 0);

    // ── User-access KPIs (W107 reframe) ─────────────────────────────
    // Adoption rate, new users in range, and never-logged-in count.
    // These are NOT segmented by amphoe/agency — they describe the
    // global registered population, which is the lens that answers
    // "is the system worth its budget".
    const userPopulation: any = await this.dataSource.query(
      `SELECT
         COUNT(*)::int AS "total",
         COUNT(*) FILTER (WHERE last_seen_at IS NOT NULL)::int AS "everSeen",
         COUNT(*) FILTER (WHERE last_seen_at IS NULL)::int AS "neverSeen"
       FROM users
       WHERE delete_at IS NULL`,
    );
    const pop = userPopulation?.[0] ?? { total: 0, everSeen: 0, neverSeen: 0 };
    const adoptionRate =
      pop.total > 0 ? Number((pop.everSeen / pop.total).toFixed(4)) : 0;

    // NOTE: this codebase's `users` table uses non-standard column names —
    // `delete_at` (singular) and `create_at` (singular). Matches the
    // naming used everywhere else (e.g. tracking_status.create_at).
    const newUsers: any = await this.dataSource.query(
      `SELECT COUNT(*)::int AS "n"
       FROM users
       WHERE delete_at IS NULL
         AND create_at >= $1::date
         AND create_at <  ($2::date + INTERVAL '1 day')`,
      [from, to],
    );
    const newUsersInRange = Number(newUsers?.[0]?.n ?? 0);

    return {
      rangeFrom: from,
      rangeTo: to,
      rangeDays,
      dauToday,
      wau,
      mau,
      adoptionRate,
      newUsersInRange,
      neverLoggedInCount: Number(pop.neverSeen ?? 0),
      totalTransitions: transitionsTotal,
      transitionsAvgPerDay:
        rangeDays > 0 ? Number((transitionsTotal / rangeDays).toFixed(2)) : 0,
      totalComments: Number(totals?.commentSum ?? 0),
      totalPdfExports: Number(totals?.pdfSum ?? 0),
      aiInvocations: Number(totals?.aiSum ?? 0),
      notificationDeliveries: Number(totals?.notifSum ?? 0),
      lastRollupAt:
        totals?.lastRollupAt instanceof Date
          ? totals.lastRollupAt.toISOString()
          : (totals?.lastRollupAt ?? null),
    };
  }

  // ---------------------------------------------------------------------------
  // A2. Adoption funnel (W107 reframe — answers ROI / "งบคุ้มไหม")
  // ---------------------------------------------------------------------------

  async getAdoptionFunnel(): Promise<{
    totalRegistered: number;
    everLoggedIn: number;
    activeIn30Days: number;
    activeIn7Days: number;
    activeIn24h: number;
  }> {
    const rows: any = await this.dataSource.query(
      `SELECT
         COUNT(*)::int AS "totalRegistered",
         COUNT(*) FILTER (WHERE last_seen_at IS NOT NULL)::int AS "everLoggedIn",
         COUNT(*) FILTER (WHERE last_seen_at >= NOW() - INTERVAL '30 days')::int AS "activeIn30Days",
         COUNT(*) FILTER (WHERE last_seen_at >= NOW() - INTERVAL '7 days')::int AS "activeIn7Days",
         COUNT(*) FILTER (WHERE last_seen_at >= NOW() - INTERVAL '24 hours')::int AS "activeIn24h"
       FROM users
       WHERE delete_at IS NULL`,
    );
    const r = rows?.[0] ?? {};
    return {
      totalRegistered: Number(r.totalRegistered ?? 0),
      everLoggedIn: Number(r.everLoggedIn ?? 0),
      activeIn30Days: Number(r.activeIn30Days ?? 0),
      activeIn7Days: Number(r.activeIn7Days ?? 0),
      activeIn24h: Number(r.activeIn24h ?? 0),
    };
  }

  private async dauWindowSum(
    q: OverviewQueryDto,
    latestBucket: string | null,
    windowDays: number,
  ): Promise<number> {
    if (!latestBucket) return 0;
    const qb = this.rollupRepo
      .createQueryBuilder('r')
      .select('SUM(r.dau_count)', 's')
      .where(
        `r.bucket_date <= :latest AND r.bucket_date > (:latest::date - INTERVAL '${windowDays} days')`,
        { latest: latestBucket },
      );
    this.applySegmentFilters(qb, q);
    const row: any = await qb.getRawOne();
    return Number(row?.s ?? 0);
  }

  // ---------------------------------------------------------------------------
  // B. Timeseries
  // ---------------------------------------------------------------------------

  async getTimeseries(q: TimeseriesQueryDto): Promise<TimeseriesResponseDto> {
    const { from, to } = this.validateAndNormalizeRange(q.from, q.to);
    await this.ensureTodayRollup(from, to);
    const bucket: TimeseriesBucket = q.bucket ?? 'daily';
    const column = this.timeseriesMetricColumn(q.metric);

    // Bucket-grouping expression. We GROUP BY the truncated bucket_date.
    let groupExpr: string;
    switch (bucket) {
      case 'weekly':
        groupExpr = `DATE_TRUNC('week', r.bucket_date)::date`;
        break;
      case 'monthly':
        groupExpr = `DATE_TRUNC('month', r.bucket_date)::date`;
        break;
      case 'daily':
      default:
        groupExpr = `r.bucket_date`;
        break;
    }

    const qb = this.rollupRepo
      .createQueryBuilder('r')
      .select(`${groupExpr}`, 'b')
      .addSelect(`SUM(r.${column})`, 'v')
      .where('r.bucket_date BETWEEN :from AND :to', { from, to });
    this.applySegmentFilters(qb, q);
    qb.groupBy('b').orderBy('b', 'ASC');

    const rows: Array<{ b: string | Date; v: string | null }> =
      await qb.getRawMany();

    return {
      metric: q.metric,
      bucket,
      points: rows.map((r) => ({
        bucket: this.toIsoDate(r.b),
        value: Number(r.v ?? 0),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // C. Top users (on-the-fly)
  // ---------------------------------------------------------------------------

  async getTopUsers(q: TopUsersQueryDto): Promise<TopUsersResponseDto> {
    const { from, to } = this.validateAndNormalizeRange(q.from, q.to);
    const limit = Math.min(Math.max(q.limit ?? 10, 1), 50);

    // Map the metric to the source table + actor join column.
    // 'projects' is treated as an alias for 'transitions' until a
    // project-creation-event audit lands (master plan §11 risks).
    const metric: TopUsersMetric =
      q.metric === 'projects' ? 'transitions' : q.metric;

    let baseSql: string;
    const params: Record<string, unknown> = { from, to, limit };

    if (metric === 'transitions') {
      baseSql = `
        SELECT
          u.id              AS "userId",
          (u.firstname || ' ' || u.lastname) AS "fullName",
          COALESCE(role.name, 'unknown') AS "role",
          wh.amphoe_id      AS "amphoeId",
          COUNT(ts.id)      AS "count",
          MAX(u.last_seen_at) AS "lastSeenAt"
        FROM tracking_status ts
        INNER JOIN work_history wh ON wh.id = ts.created_by
        INNER JOIN users u ON u.id = wh.user_id
        LEFT JOIN roles role ON role.id = wh.role_id
        WHERE ts.create_at >= :from::date
          AND ts.create_at <  (:to::date + INTERVAL '1 day')
          AND ts."deletedAt" IS NULL
          ${q.role ? 'AND role.name = :role' : ''}
          ${q.amphoeId ? 'AND wh.amphoe_id = :amphoeId' : ''}
        GROUP BY u.id, u.firstname, u.lastname, role.name, wh.amphoe_id
        ORDER BY "count" DESC, u.id ASC
        LIMIT :limit
      `;
    } else if (metric === 'comments') {
      baseSql = `
        SELECT
          u.id              AS "userId",
          (u.firstname || ' ' || u.lastname) AS "fullName",
          COALESCE(role.name, 'unknown') AS "role",
          wh.amphoe_id      AS "amphoeId",
          COUNT(c.id)       AS "count",
          MAX(u.last_seen_at) AS "lastSeenAt"
        FROM comment c
        INNER JOIN tracking_status ts ON ts.id = c.tracking_status_id
        INNER JOIN work_history wh ON wh.id = ts.created_by
        INNER JOIN users u ON u.id = wh.user_id
        LEFT JOIN roles role ON role.id = wh.role_id
        WHERE c.create_at >= :from::date
          AND c.create_at <  (:to::date + INTERVAL '1 day')
          ${q.role ? 'AND role.name = :role' : ''}
          ${q.amphoeId ? 'AND wh.amphoe_id = :amphoeId' : ''}
        GROUP BY u.id, u.firstname, u.lastname, role.name, wh.amphoe_id
        ORDER BY "count" DESC, u.id ASC
        LIMIT :limit
      `;
    } else if (metric === 'loginDays') {
      // W107 reframe — distinct active days per user, unioned across the
      // signals we DO have (tracking_status, ai_usage_logs, last_seen_at).
      // Acts as a proxy for "login frequency" until a dedicated login-
      // event table exists. Pure passive viewers contribute via
      // last_seen_at because the W106 heartbeat refreshes that column.
      baseSql = `
        WITH activity AS (
          SELECT wh.user_id AS uid,
                 (ts.create_at AT TIME ZONE 'Asia/Bangkok')::date AS d
          FROM tracking_status ts
          INNER JOIN work_history wh ON wh.id = ts.created_by
          WHERE ts.create_at >= :from::date
            AND ts.create_at <  (:to::date + INTERVAL '1 day')
            AND ts."deletedAt" IS NULL
          UNION
          SELECT wh.user_id,
                 (aul.used_at AT TIME ZONE 'Asia/Bangkok')::date
          FROM ai_usage_logs aul
          INNER JOIN work_history wh ON wh.id = aul.actor_work_history_id
          WHERE aul.used_at >= :from::date
            AND aul.used_at <  (:to::date + INTERVAL '1 day')
          UNION
          SELECT u.id,
                 (u.last_seen_at AT TIME ZONE 'Asia/Bangkok')::date
          FROM users u
          WHERE u.last_seen_at IS NOT NULL
            AND u.last_seen_at >= :from::date
            AND u.last_seen_at <  (:to::date + INTERVAL '1 day')
            AND u.delete_at IS NULL
        )
        SELECT
          u.id              AS "userId",
          (u.firstname || ' ' || u.lastname) AS "fullName",
          COALESCE(role.name, 'unknown') AS "role",
          wh.amphoe_id      AS "amphoeId",
          COUNT(DISTINCT activity.d)::int AS "count",
          MAX(u.last_seen_at) AS "lastSeenAt"
        FROM activity
        INNER JOIN users u ON u.id = activity.uid
        LEFT JOIN work_history wh ON wh.user_id = u.id AND wh.is_current = true
        LEFT JOIN roles role ON role.id = wh.role_id
        WHERE u.delete_at IS NULL
          ${q.role ? 'AND role.name = :role' : ''}
          ${q.amphoeId ? 'AND wh.amphoe_id = :amphoeId' : ''}
        GROUP BY u.id, u.firstname, u.lastname, role.name, wh.amphoe_id
        ORDER BY "count" DESC, u.id ASC
        LIMIT :limit
      `;
    } else {
      // pdfExports — no audit row exists yet (per DB-PR1 OQ4).
      // Return empty so the FE renders an empty-state, no error.
      return { metric: q.metric, users: [] };
    }

    if (q.role) params.role = q.role;
    if (q.amphoeId) params.amphoeId = q.amphoeId;

    const rows = await this.dataSource.query(
      this.rewriteNamedParams(baseSql, params),
      this.orderedParams(baseSql, params),
    );

    return {
      metric: q.metric,
      users: rows.map((r: any) => ({
        userId: r.userId,
        fullName: (r.fullName ?? '').trim() || '(unknown)',
        role: r.role,
        amphoeId: r.amphoeId ?? null,
        count: Number(r.count ?? 0),
        lastSeenAt:
          r.lastSeenAt instanceof Date
            ? r.lastSeenAt.toISOString()
            : (r.lastSeenAt ?? null),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // D. Heatmap (on-the-fly)
  // ---------------------------------------------------------------------------

  async getHeatmap(q: HeatmapQueryDto): Promise<HeatmapResponseDto> {
    const { from, to } = this.validateAndNormalizeRange(
      q.from,
      q.to,
      // Heatmap is heavy; cap at 90 days per spec §11 risks.
      90,
    );
    const metric: HeatmapMetric = q.metric ?? 'transitions';

    if (metric === 'transitions') {
      const sql = `
        SELECT
          EXTRACT(DOW FROM (ts.create_at AT TIME ZONE 'Asia/Bangkok'))::int  AS "dow",
          EXTRACT(HOUR FROM (ts.create_at AT TIME ZONE 'Asia/Bangkok'))::int AS "hour",
          COUNT(ts.id)::int AS "value"
        FROM tracking_status ts
        ${q.role ? 'INNER JOIN work_history wh ON wh.id = ts.created_by INNER JOIN roles role ON role.id = wh.role_id' : ''}
        WHERE ts.create_at >= :from::date
          AND ts.create_at <  (:to::date + INTERVAL '1 day')
          AND ts."deletedAt" IS NULL
          ${q.role ? 'AND role.name = :role' : ''}
        GROUP BY "dow", "hour"
        ORDER BY "dow", "hour"
      `;
      const params: Record<string, unknown> = { from, to };
      if (q.role) params.role = q.role;
      const rows = await this.dataSource.query(
        this.rewriteNamedParams(sql, params),
        this.orderedParams(sql, params),
      );
      return {
        metric,
        matrix: rows.map((r: any) => ({
          dayOfWeek: Number(r.dow),
          hour: Number(r.hour),
          value: Number(r.value ?? 0),
        })),
      };
    }

    // 'dau' heatmap proxies via tracking_status distinct actor (acts as
    // a sufficiently granular signal of "people doing things at hour H").
    const sql = `
      SELECT
        EXTRACT(DOW FROM (ts.create_at AT TIME ZONE 'Asia/Bangkok'))::int  AS "dow",
        EXTRACT(HOUR FROM (ts.create_at AT TIME ZONE 'Asia/Bangkok'))::int AS "hour",
        COUNT(DISTINCT wh.user_id)::int AS "value"
      FROM tracking_status ts
      INNER JOIN work_history wh ON wh.id = ts.created_by
      ${q.role ? 'INNER JOIN roles role ON role.id = wh.role_id' : ''}
      WHERE ts.create_at >= :from::date
        AND ts.create_at <  (:to::date + INTERVAL '1 day')
        AND ts."deletedAt" IS NULL
        ${q.role ? 'AND role.name = :role' : ''}
      GROUP BY "dow", "hour"
      ORDER BY "dow", "hour"
    `;
    const params: Record<string, unknown> = { from, to };
    if (q.role) params.role = q.role;
    const rows = await this.dataSource.query(
      this.rewriteNamedParams(sql, params),
      this.orderedParams(sql, params),
    );
    return {
      metric,
      matrix: rows.map((r: any) => ({
        dayOfWeek: Number(r.dow),
        hour: Number(r.hour),
        value: Number(r.value ?? 0),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // E. Role distribution (rollup-backed)
  // ---------------------------------------------------------------------------

  async getRoleDistribution(
    q: RoleDistributionQueryDto,
  ): Promise<RoleDistributionResponseDto> {
    const { from, to } = this.validateAndNormalizeRange(q.from, q.to);
    await this.ensureTodayRollup(from, to);

    const rows = await this.rollupRepo
      .createQueryBuilder('r')
      .select('r.role', 'role')
      .addSelect('SUM(r.dau_count)', 'dauCount')
      .addSelect('SUM(r.transition_count)', 'transitionCount')
      .where('r.bucket_date BETWEEN :from AND :to', { from, to })
      .groupBy('r.role')
      .orderBy('"transitionCount"', 'DESC')
      .getRawMany();

    const total = rows.reduce(
      (acc, r) => acc + Number(r.transitionCount ?? 0),
      0,
    );

    return {
      slices: rows.map((r) => {
        const transitionCount = Number(r.transitionCount ?? 0);
        return {
          role: r.role,
          dauCount: Number(r.dauCount ?? 0),
          transitionCount,
          share:
            total > 0 ? Number((transitionCount / total).toFixed(4)) : 0,
        };
      }),
    };
  }

  // ---------------------------------------------------------------------------
  // F. Inactive users (super-admin only — gated at controller level)
  // ---------------------------------------------------------------------------

  async getInactiveUsers(
    q: InactiveUsersQueryDto,
  ): Promise<InactiveUsersResponseDto> {
    const days = q.days;
    const limit = Math.min(Math.max(q.limit ?? 200, 1), 200);
    const offset = q.offset ?? 0;

    const sql = `
      WITH cur_wh AS (
        SELECT DISTINCT ON (wh.user_id)
          wh.user_id,
          wh.role_id,
          wh.amphoe_id
        FROM work_history wh
        WHERE wh.deleted_at IS NULL AND wh.is_current = true
        ORDER BY wh.user_id, wh.updated_at DESC
      )
      SELECT
        u.id  AS "userId",
        (u.firstname || ' ' || u.lastname) AS "fullName",
        role.name AS "role",
        u.last_seen_at AS "lastSeenAt"
      FROM users u
      LEFT JOIN cur_wh wh ON wh.user_id = u.id
      LEFT JOIN roles role ON role.id = wh.role_id
      WHERE u.delete_at IS NULL
        AND (u.last_seen_at IS NULL OR u.last_seen_at < (NOW() - INTERVAL '${days} days'))
        ${q.role ? 'AND role.name = :role' : ''}
        ${q.amphoeId ? 'AND wh.amphoe_id = :amphoeId' : ''}
      ORDER BY u.last_seen_at NULLS FIRST
      LIMIT :limit OFFSET :offset
    `;

    const params: Record<string, unknown> = { limit, offset };
    if (q.role) params.role = q.role;
    if (q.amphoeId) params.amphoeId = q.amphoeId;

    const rows = await this.dataSource.query(
      this.rewriteNamedParams(sql, params),
      this.orderedParams(sql, params),
    );

    const now = Date.now();
    return {
      thresholdDays: days,
      asOf: new Date().toISOString().slice(0, 10),
      total: rows.length,
      users: rows.map((r: any) => {
        const lastSeen = r.lastSeenAt instanceof Date
          ? r.lastSeenAt
          : r.lastSeenAt
          ? new Date(r.lastSeenAt)
          : null;
        return {
          userId: r.userId,
          fullName: (r.fullName ?? '').trim() || '(unknown)',
          role: r.role ?? null,
          lastSeenAt: lastSeen ? lastSeen.toISOString() : null,
          daysSinceLastSeen: lastSeen
            ? Math.floor((now - lastSeen.getTime()) / (1000 * 60 * 60 * 24))
            : null,
        };
      }),
    };
  }

  // ---------------------------------------------------------------------------
  // CSV helpers
  // ---------------------------------------------------------------------------

  buildTopUsersCsv(payload: TopUsersResponseDto): string {
    const header = 'User ID,Full Name,Role,Count,Last Seen At\n';
    const rows = payload.users.map((u) =>
      [
        this.csvEscape(u.userId),
        this.csvEscape(u.fullName),
        this.csvEscape(u.role),
        String(u.count),
        this.csvEscape(u.lastSeenAt ?? ''),
      ].join(','),
    );
    return header + rows.join('\n') + (rows.length > 0 ? '\n' : '');
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private validateAndNormalizeRange(
    fromRaw: string,
    toRaw: string,
    capDaysOverride?: number,
  ): { from: string; to: string; rangeDays: number } {
    const from = this.toIsoDate(fromRaw);
    const to = this.toIsoDate(toRaw);

    if (from < MIN_FROM_DATE) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'STATS_RANGE_FLOOR',
        detail: `from must be >= ${MIN_FROM_DATE}`,
      });
    }
    if (from > to) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'STATS_RANGE_INVALID',
        detail: 'from must be <= to',
      });
    }

    const fromMs = Date.parse(`${from}T00:00:00Z`);
    const toMs = Date.parse(`${to}T00:00:00Z`);
    const rangeDays = Math.floor((toMs - fromMs) / (1000 * 60 * 60 * 24)) + 1;

    const cap = capDaysOverride ?? MAX_DATE_RANGE_DAYS;
    if (rangeDays > cap) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'DATE_RANGE_TOO_WIDE',
        detail: `range ${rangeDays} days exceeds cap of ${cap} days`,
      });
    }

    return { from, to, rangeDays };
  }

  private applySegmentFilters(
    qb: ReturnType<Repository<SystemUsageDailyRollup>['createQueryBuilder']>,
    q: { role?: CanonicalRole; amphoeId?: string; governmentAgencyId?: string },
  ): void {
    if (q.role) {
      if (!CANONICAL_ROLES.includes(q.role)) {
        throw new BadRequestException('STATS_INVALID_ROLE');
      }
      qb.andWhere('r.role = :roleFilter', { roleFilter: q.role });
    }
    if (q.amphoeId) {
      qb.andWhere('r.amphoe_id = :amphoeIdFilter', {
        amphoeIdFilter: q.amphoeId,
      });
    }
    if (q.governmentAgencyId) {
      qb.andWhere('r.government_agency_id = :gaIdFilter', {
        gaIdFilter: q.governmentAgencyId,
      });
    }
  }

  private timeseriesMetricColumn(m: TimeseriesMetric): string {
    switch (m) {
      case 'dau':
        return 'dau_count';
      case 'transitions':
        return 'transition_count';
      case 'comments':
        return 'comment_count';
      case 'pdfExports':
        return 'pdf_export_count';
      case 'ai':
        return 'ai_invocation_count';
      case 'notifications':
        return 'notification_count';
      default: {
        // Exhaustive guard — should never happen because the DTO whitelists
        // the values up front. Throwing here keeps a 400 surface even if
        // a caller bypasses the DTO (e.g. internal direct call).
        throw new BadRequestException(`STATS_INVALID_METRIC:${m}`);
      }
    }
  }

  private toIsoDate(v: string | Date): string {
    if (v instanceof Date) {
      return v.toISOString().slice(0, 10);
    }
    // Accept either 'YYYY-MM-DD' or full ISO; truncate to date.
    return v.slice(0, 10);
  }

  /**
   * Convert `:name` tokens to `$1, $2, ...` for `dataSource.query`.
   * TypeORM's raw-query uses positional binds; we maintain the token
   * map so the SQL stays readable above.
   */
  private rewriteNamedParams(
    sql: string,
    params: Record<string, unknown>,
  ): string {
    let i = 0;
    const order: string[] = [];
    const replaced = sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
      // Only treat as bind if the param actually exists; otherwise leave
      // the token alone (e.g. inside a comment / unrelated colon).
      if (!(name in params)) return `:${name}`;
      order.push(name);
      i += 1;
      return `$${i}`;
    });
    // Stash the order on a side channel via a non-enumerable property on
    // the params (avoids changing the function signature). We instead
    // rebuild order in `orderedParams` from the same regex, so this is a
    // no-op apart from rewriting the placeholders.
    void order;
    return replaced;
  }

  private orderedParams(
    sql: string,
    params: Record<string, unknown>,
  ): unknown[] {
    const ordered: unknown[] = [];
    sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
      if (name in params) ordered.push(params[name]);
      return '';
    });
    return ordered;
  }

  private csvEscape(v: string): string {
    if (v == null) return '';
    const needsQuote = /[",\r\n]/.test(v);
    const escaped = v.replace(/"/g, '""');
    return needsQuote ? `"${escaped}"` : escaped;
  }
}
