import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { NotificationEmailLog } from '../entities/notification-email-log.entity';
import { User } from 'src/users/entities/user.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { maskEmail } from './utils/mask-email.util';

/**
 * Wave 22 B1 — Super-admin email-stats query service.
 *
 * Advisory-only (§4.1, §17.2) — these aggregations feed the super-admin
 * dashboard. They MUST NOT be used to gate any workflow transition and
 * MUST NOT write to `tracking_status` (§12).
 *
 * All queries are parameterized TypeORM QueryBuilders (no raw string
 * interpolation). Recipient emails are returned masked via
 * `maskEmail(...)` from the shared util.
 *
 * Designed to lean on the following indexes:
 *   - `ix_notification_email_logs_queued_at`         (date-range slicing)
 *   - `ix_notification_email_logs_event_status`      (overview by status)
 *   - `ix_notification_email_logs_recipient`         (top-recipients)
 *   - `ix_notification_email_logs_actor_queued`      (top-senders, W22 D1)
 *
 * Wave 22 QA fixes (C-2 / C-3 / H-1):
 *   - top-senders / top-recipients return `fullName` + (sender only)
 *     `roleName` resolved from the user's current/latest WorkHistory.role.
 *   - by-day is pivoted to wide format with camelCase status keys
 *     (`skippedPreference`, `skippedKillswitch`).
 *   - failures hydrate the actor via `actor_user_id` → { fullName, email }.
 */
@Injectable()
export class EmailStatsService {
  /** Default window in days when caller omits `from` / `to`. */
  private static readonly DEFAULT_WINDOW_DAYS = 30;

  constructor(
    @InjectRepository(NotificationEmailLog)
    private readonly auditLogRepo: Repository<NotificationEmailLog>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,
  ) {}

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve a `from` / `to` pair into a concrete Date range. Defaults to
   * `[now() - 30d, now()]` when both are absent. Invalid or malformed
   * inputs fall back to the default endpoint so the dashboard never 500s
   * on a transient client bug (DTO-level `@IsISO8601` already rejects
   * malformed shapes before we get here).
   */
  private resolveRange(
    from?: string,
    to?: string,
  ): { fromDate: Date; toDate: Date } {
    const now = new Date();
    const defaultFrom = new Date(
      now.getTime() - EmailStatsService.DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    const parsedFrom = from ? new Date(from) : defaultFrom;
    const parsedTo = to ? new Date(to) : now;

    const fromDate = isNaN(parsedFrom.getTime()) ? defaultFrom : parsedFrom;
    const toDate = isNaN(parsedTo.getTime()) ? now : parsedTo;

    return { fromDate, toDate };
  }

  /**
   * Build a `fullName` from a User row. Handles nulls / whitespace so the
   * dashboard never renders a bare dash + whitespace combo.
   */
  private buildFullName(user?: { firstname?: string | null; lastname?: string | null } | null): string {
    if (!user) return '—';
    const first = (user.firstname ?? '').trim();
    const last = (user.lastname ?? '').trim();
    const joined = `${first} ${last}`.trim();
    return joined.length > 0 ? joined : '—';
  }

  /**
   * Resolve each user's role name via `WorkHistory.role.name` using the
   * current (`isCurrent = true`) row, falling back to the most recent
   * non-current history row when no current row exists. Users without any
   * work history map to `null` (rare — legacy data).
   *
   * Returns a map keyed by user id.
   */
  private async resolveRoleNames(userIds: string[]): Promise<Map<string, string | null>> {
    const roleByUser = new Map<string, string | null>();
    if (userIds.length === 0) return roleByUser;

    const histories = await this.workHistoryRepo
      .createQueryBuilder('wh')
      .leftJoinAndSelect('wh.role', 'role')
      .leftJoinAndSelect('wh.user', 'user')
      .where('user.id IN (:...ids)', { ids: userIds })
      .orderBy('wh.isCurrent', 'DESC')
      .addOrderBy('wh.createdAt', 'DESC')
      .getMany();

    for (const wh of histories) {
      const uid = wh.user?.id;
      if (!uid) continue;
      if (roleByUser.has(uid)) continue; // keep first (most-preferred) match
      roleByUser.set(uid, wh.role?.name ?? null);
    }

    // Ensure every requested user is represented (null when absent).
    for (const uid of userIds) {
      if (!roleByUser.has(uid)) roleByUser.set(uid, null);
    }

    return roleByUser;
  }

  // ---------------------------------------------------------------------------
  // Endpoints
  // ---------------------------------------------------------------------------

  /**
   * Overall counts by status across the given date range (defaults to the
   * last 30 days when `from` / `to` are absent).
   *
   * Returns `{ total, byStatus: { queued, sent, failed, 'skipped-preference', ... } }`.
   */
  async getOverview(
    from?: string,
    to?: string,
  ): Promise<{
    total: number;
    byStatus: Record<string, number>;
  }> {
    const { fromDate, toDate } = this.resolveRange(from, to);

    const rows = await this.auditLogRepo
      .createQueryBuilder('log')
      .select('log.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('log.queued_at >= :from', { from: fromDate })
      .andWhere('log.queued_at <= :to', { to: toDate })
      .groupBy('log.status')
      .getRawMany<{ status: string; count: string }>();

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const n = Number(r.count) || 0;
      byStatus[r.status] = n;
      total += n;
    }
    return { total, byStatus };
  }

  /**
   * Time-series pivoted to WIDE format:
   *   `[{ bucket, queued, sent, failed, skippedPreference, skippedKillswitch, skippedNotVerified }]`
   *
   * Wave 95 — `skippedNotVerified` mirrors the non-failure-skip treatment of
   * `skippedPreference`. The audit-row write happens in W95-GATE.
   *
   * `bucket` is `YYYY-MM-DD` when `bucketSize === 'day'` and
   * `YYYY-MM-DDTHH:00:00Z` when `bucketSize === 'hour'`.
   *
   * NOTE: raw-SQL fragments use the physical column name `queued_at`
   * (not the entity property `queuedAt`). `.select(...)` with a function
   * call is passed through verbatim — TypeORM does NOT translate
   * property paths inside SQL expressions.
   */
  async getByDay(
    from?: string,
    to?: string,
    bucketSize: 'day' | 'hour' = 'day',
  ): Promise<
    Array<{
      bucket: string;
      queued: number;
      sent: number;
      failed: number;
      skippedPreference: number;
      skippedKillswitch: number;
      skippedNotVerified: number;
    }>
  > {
    const { fromDate, toDate } = this.resolveRange(from, to);
    const truncUnit = bucketSize === 'hour' ? 'hour' : 'day';

    const rows = await this.auditLogRepo
      .createQueryBuilder('log')
      .select(`date_trunc('${truncUnit}', log.queued_at)`, 'bucket')
      .addSelect('log.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('log.queued_at >= :from', { from: fromDate })
      .andWhere('log.queued_at <= :to', { to: toDate })
      .groupBy('bucket')
      .addGroupBy('log.status')
      .orderBy('bucket', 'ASC')
      .addOrderBy('log.status', 'ASC')
      .getRawMany<{ bucket: Date | string; status: string; count: string }>();

    // Pivot long → wide. Keyed by bucket string.
    const byBucket = new Map<
      string,
      {
        bucket: string;
        queued: number;
        sent: number;
        failed: number;
        skippedPreference: number;
        skippedKillswitch: number;
        skippedNotVerified: number;
      }
    >();

    const formatBucket = (raw: Date | string): string => {
      const d = raw instanceof Date ? raw : new Date(raw);
      if (isNaN(d.getTime())) return String(raw);
      if (bucketSize === 'hour') {
        // ISO 8601 with hour precision: `2026-04-18T09:00:00Z`.
        const iso = d.toISOString();
        return `${iso.slice(0, 13)}:00:00Z`;
      }
      return d.toISOString().slice(0, 10);
    };

    for (const r of rows) {
      const key = formatBucket(r.bucket);
      let entry = byBucket.get(key);
      if (!entry) {
        entry = {
          bucket: key,
          queued: 0,
          sent: 0,
          failed: 0,
          skippedPreference: 0,
          skippedKillswitch: 0,
          skippedNotVerified: 0,
        };
        byBucket.set(key, entry);
      }
      const count = Number(r.count) || 0;
      switch (r.status) {
        case 'queued':
          entry.queued += count;
          break;
        case 'sent':
          entry.sent += count;
          break;
        case 'failed':
          entry.failed += count;
          break;
        case 'skipped-preference':
          entry.skippedPreference += count;
          break;
        case 'skipped-killswitch':
          entry.skippedKillswitch += count;
          break;
        case 'skipped-not-verified':
          // Wave 95 — non-failure skip; bucketed identically to
          // `skipped-preference` for dashboard purposes (W95-GATE writes).
          entry.skippedNotVerified += count;
          break;
        // Unknown statuses are intentionally ignored — we only render the
        // six known categories on the dashboard. Total-by-status coverage
        // is provided by `overview`.
        default:
          break;
      }
    }

    return Array.from(byBucket.values()).sort((a, b) =>
      a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0,
    );
  }

  /**
   * Top workflow actors by notification volume. Filters
   * `actor_user_id IS NOT NULL` so pre-Wave-22 rows (where actor was not
   * captured) do not pollute the leaderboard. Joins `users` for display
   * name + email (email is returned masked) and `work_history` for role.
   */
  async getTopSenders(
    limit: number,
    from?: string,
    to?: string,
  ): Promise<
    Array<{
      actorUserId: string;
      fullName: string;
      roleName: string | null;
      emailMasked: string;
      count: number;
    }>
  > {
    const n = Math.max(1, Math.min(200, Math.floor(limit)));
    const { fromDate, toDate } = this.resolveRange(from, to);

    const rows = await this.auditLogRepo
      .createQueryBuilder('log')
      .select('log.actor_user_id', 'actorUserId')
      .addSelect('COUNT(*)', 'count')
      .where('log.actor_user_id IS NOT NULL')
      .andWhere('log.queued_at >= :from', { from: fromDate })
      .andWhere('log.queued_at <= :to', { to: toDate })
      .groupBy('log.actor_user_id')
      .orderBy('count', 'DESC')
      .limit(n)
      .getRawMany<{ actorUserId: string; count: string }>();

    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.actorUserId);
    const [users, roleByUser] = await Promise.all([
      this.userRepo
        .createQueryBuilder('u')
        .select(['u.id', 'u.firstname', 'u.lastname', 'u.email'])
        .where('u.id IN (:...ids)', { ids })
        .getMany(),
      this.resolveRoleNames(ids),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));

    return rows.map((r) => {
      const u = userById.get(r.actorUserId);
      return {
        actorUserId: r.actorUserId,
        fullName: this.buildFullName(u),
        roleName: roleByUser.get(r.actorUserId) ?? null,
        emailMasked: maskEmail(u?.email ?? null),
        count: Number(r.count) || 0,
      };
    });
  }

  /**
   * Top recipients by notification volume. Filters
   * `recipient_user_id IS NOT NULL` — rows whose recipient user has been
   * deleted (SET NULL) fall out so the leaderboard always has a usable
   * display name. Email is returned masked.
   */
  async getTopRecipients(
    limit: number,
    from?: string,
    to?: string,
  ): Promise<
    Array<{
      recipientUserId: string;
      fullName: string;
      roleName: string | null;
      emailMasked: string;
      count: number;
    }>
  > {
    const n = Math.max(1, Math.min(200, Math.floor(limit)));
    const { fromDate, toDate } = this.resolveRange(from, to);

    const rows = await this.auditLogRepo
      .createQueryBuilder('log')
      .select('log.recipient_user_id', 'recipientUserId')
      .addSelect('COUNT(*)', 'count')
      .where('log.recipient_user_id IS NOT NULL')
      .andWhere('log.queued_at >= :from', { from: fromDate })
      .andWhere('log.queued_at <= :to', { to: toDate })
      .groupBy('log.recipient_user_id')
      .orderBy('count', 'DESC')
      .limit(n)
      .getRawMany<{ recipientUserId: string; count: string }>();

    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.recipientUserId);
    const [users, roleByUser] = await Promise.all([
      this.userRepo
        .createQueryBuilder('u')
        .select(['u.id', 'u.firstname', 'u.lastname', 'u.email'])
        .where('u.id IN (:...ids)', { ids })
        .getMany(),
      this.resolveRoleNames(ids),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));

    return rows.map((r) => {
      const u = userById.get(r.recipientUserId);
      return {
        recipientUserId: r.recipientUserId,
        fullName: this.buildFullName(u),
        roleName: roleByUser.get(r.recipientUserId) ?? null,
        emailMasked: maskEmail(u?.email ?? null),
        count: Number(r.count) || 0,
      };
    });
  }

  /**
   * Recent failure tail: the last N `status = 'failed'` rows with their
   * error message. Ordered by `queued_at DESC`. Recipient email masked;
   * `errorMessage` is returned as stored (no PII scrubbing — error strings
   * are provider-originated and do not contain user PII in this codebase).
   *
   * Wave 22 QA H-1 — the `actor` object is hydrated from
   * `actor_user_id` via the `users` table so the dashboard can render
   * the triggering user without a second round-trip. Emails in the actor
   * block are returned masked (§17 PII default); the display-only raw
   * email field still exists in the type for FE tooltip compatibility
   * but holds the masked form.
   */
  async getFailures(
    limit: number,
    from?: string,
    to?: string,
  ): Promise<
    Array<{
      id: string;
      eventType: string;
      targetKind: string;
      targetId: string;
      recipientMasked: string;
      actor: {
        actorUserId: string;
        fullName: string;
        email: string;
      } | null;
      errorMessage: string | null;
      queuedAt: Date;
      attempts: number;
    }>
  > {
    const n = Math.max(1, Math.min(200, Math.floor(limit)));
    const { fromDate, toDate } = this.resolveRange(from, to);

    const rows = await this.auditLogRepo
      .createQueryBuilder('log')
      .select([
        'log.id',
        'log.eventType',
        'log.targetKind',
        'log.targetId',
        'log.recipientEmail',
        'log.errorMessage',
        'log.queuedAt',
        'log.attempts',
        'log.actorUserId',
      ])
      .where('log.status = :status', { status: 'failed' })
      .andWhere('log.queuedAt >= :from', { from: fromDate })
      .andWhere('log.queuedAt <= :to', { to: toDate })
      .orderBy('log.queuedAt', 'DESC')
      .limit(n)
      .getMany();

    // Hydrate actor users in a single round-trip.
    const actorIds = Array.from(
      new Set(rows.map((r) => r.actorUserId).filter((x): x is string => !!x)),
    );
    const actors = actorIds.length
      ? await this.userRepo
          .createQueryBuilder('u')
          .select(['u.id', 'u.firstname', 'u.lastname', 'u.email'])
          .where('u.id IN (:...ids)', { ids: actorIds })
          .getMany()
      : [];
    const actorById = new Map(actors.map((u) => [u.id, u]));

    return rows.map((r) => {
      const aid = r.actorUserId ?? null;
      const a = aid ? actorById.get(aid) : undefined;
      const actor = aid
        ? {
            actorUserId: aid,
            fullName: this.buildFullName(a),
            // Mask email — the dashboard is super-admin but we still
            // default to masking per §17 PII guidance.
            email: maskEmail(a?.email ?? null),
          }
        : null;
      return {
        id: r.id,
        eventType: r.eventType,
        targetKind: r.targetKind,
        targetId: r.targetId,
        recipientMasked: maskEmail(r.recipientEmail ?? null),
        actor,
        errorMessage: r.errorMessage ?? null,
        queuedAt: r.queuedAt,
        attempts: r.attempts ?? 0,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Wave 97 — Combined quota window aggregation
  // ---------------------------------------------------------------------------

  /**
   * Wave 97 — quota-window aggregation for the super-admin dashboard.
   *
   * Returns counts grouped by `status` + a top-50 `byEvent` breakdown for
   * the inclusive `[from, to]` range. Caller resolves the window (default
   * = today UTC) and passes Date objects directly so the controller can
   * stamp the same `windowStart` / `windowEnd` into the response envelope.
   *
   * NOT a refactor of the existing `getOverview` — this is an additive
   * method that returns the exact shape required by `GET /admin/notifications/quota`.
   *
   * §4.1 / §17.2 — purely advisory; not used to gate any workflow.
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
    const statusRows = await this.auditLogRepo
      .createQueryBuilder('log')
      .select('log.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('log.queued_at >= :from', { from: fromDate })
      .andWhere('log.queued_at <= :to', { to: toDate })
      .groupBy('log.status')
      .getRawMany<{ status: string; count: string }>();

    const byStatus: Record<string, number> = {};
    for (const r of statusRows) {
      byStatus[r.status] = Number(r.count) || 0;
    }

    const eventRows = await this.auditLogRepo
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
      { eventType: string; sent: number; failed: number; skipped: number; total: number }
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
      if (r.status === 'sent') entry.sent += n;
      else if (r.status === 'failed') entry.failed += n;
      else if (r.status?.startsWith('skipped-')) entry.skipped += n;
      entry.total += n;
    }

    // Top-50 by total volume, drop the helper `total` column from the
    // outgoing shape. See §11 (cardinality limit).
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
   * Wave 97 — sum of `sent` rows in the given window. Used by the alert
   * worker to compute `percentUsed` against `EMAIL_DAILY_QUOTA` without
   * paying the full `getQuotaWindow` aggregation cost.
   */
  async getSentCount(fromDate: Date, toDate: Date): Promise<number> {
    const row = await this.auditLogRepo
      .createQueryBuilder('log')
      .select('COUNT(*)', 'count')
      .where('log.status = :status', { status: 'sent' })
      .andWhere('log.queued_at >= :from', { from: fromDate })
      .andWhere('log.queued_at <= :to', { to: toDate })
      .getRawOne<{ count: string }>();
    return Number(row?.count ?? 0) || 0;
  }

  /**
   * W97 visual amendment — daily `sent` series bucketed by **Asia/Bangkok**
   * day so the channel-comparison chart's "today" matches the operator's
   * local calendar. Mirrors `LineStatsService.getSentByDay`. Returns
   * sparse rows (zero-day buckets omitted); FE pads when rendering.
   *
   * Distinct from `getByDay` (which is UTC-bucketed and pivots all
   * statuses). Adding a parallel method here instead of modifying
   * `getByDay` so the W22 `/admin/email-stats` page remains stable.
   */
  async getSentByDay(
    fromDate: Date,
    toDate: Date,
  ): Promise<Array<{ bucket: string; sent: number }>> {
    const rows = await this.auditLogRepo
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
