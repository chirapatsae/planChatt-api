import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import * as geoip from 'geoip-lite';
import { BackupLoginAuditLog } from './entities/backup-login-audit-log.entity';
import type { BackupAttemptOutcome } from './constants/error-messages';

/**
 * Single writer for `backup_login_audit_logs` (SECURITY-01 §7.12).
 *
 * Centralizes:
 *   - the row shape (no other module may INSERT into this table)
 *   - subnet derivation (/24 IPv4, /64 IPv6) — matches the LINE
 *     per-attempt notification masking
 *   - INSERT-on-failure-throws semantics (audit MUST NOT be
 *     best-effort)
 *
 * Reads + filtered listings power the super-admin audit panel
 * (controller `GET /v1/auth/backup-login/attempts`).
 */
@Injectable()
export class BackupAttemptAuditService {
  private readonly logger = new Logger(BackupAttemptAuditService.name);

  constructor(
    @InjectRepository(BackupLoginAuditLog)
    private readonly auditRepo: Repository<BackupLoginAuditLog>,
  ) {}

  async write(args: {
    userIdOrNull: string | null;
    usernameAttempted: string;
    stage: 'init' | 'complete' | 'bootstrap';
    ip: string;
    userAgent: string | null;
    outcome: BackupAttemptOutcome;
  }): Promise<void> {
    const subnet24 = maskSubnet(args.ip);
    const ipAddress = args.ip || '0.0.0.0';
    const geo = resolveGeo(ipAddress);
    try {
      await this.auditRepo.insert({
        userId: args.userIdOrNull,
        usernameAttempted: (args.usernameAttempted || '').slice(0, 256),
        stage: args.stage,
        ipAddress,
        subnet24,
        userAgent: args.userAgent ? args.userAgent.slice(0, 512) : null,
        outcome: args.outcome,
        geoCountry: geo.country,
        geoCity: geo.city,
        geoLat: geo.lat,
        geoLng: geo.lng,
      });
    } catch (err) {
      // Audit failure is a hard error — re-throw so the calling
      // request fails. We never want a backup-login flow to succeed
      // silently without an audit row.
      this.logger.error(
        `[BackupAttemptAudit] write failed outcome=${args.outcome} stage=${args.stage}: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  async list(filters: {
    userId?: string;
    outcome?: string;
    from?: Date;
    to?: Date;
    page?: number;
    limit?: number;
  }): Promise<{
    rows: BackupLoginAuditLog[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(100, Math.max(1, filters.limit ?? 25));
    const qb = this.auditRepo
      .createQueryBuilder('a')
      .leftJoinAndSelect('a.user', 'user')
      .orderBy('a.attemptedAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    qb.where(
      new Brackets((sb) => {
        sb.where('1 = 1');
        if (filters.userId) {
          sb.andWhere('a.userId = :uid', { uid: filters.userId });
        }
        if (filters.outcome) {
          sb.andWhere('a.outcome = :oc', { oc: filters.outcome });
        }
        if (filters.from) {
          sb.andWhere('a.attemptedAt >= :from', { from: filters.from });
        }
        if (filters.to) {
          sb.andWhere('a.attemptedAt <= :to', { to: filters.to });
        }
      }),
    );

    const [rows, total] = await qb.getManyAndCount();
    return { rows, total, page, limit };
  }

  /**
   * Aggregate the trailing `days`-window for the admin stats dashboard
   * (Wave 2026-05-27).
   *
   * Returns a compound object so the FE can render a multi-card stats
   * surface from one round-trip. All counts honor the same time window
   * (`now() - days` → `now()`).
   *
   * Performance: all aggregations are SQL-side `GROUP BY` queries
   * against the indexed columns (`outcome`, `subnet_24`, `attempted_at`).
   * For the expected backup-login volume (~thousands of rows / month)
   * this completes in <50ms and does NOT need a materialized view.
   *
   * Caveats:
   *   - `timeSeries` bucket is `date_trunc('day', attempted_at AT TIME
   *     ZONE 'Asia/Bangkok')`. Days with zero attempts are NOT present
   *     in the response — the FE fills gaps with 0.
   *   - `countryBreakdown` collapses NULL `geo_country` into the
   *     bucket `'??'` so it surfaces in the chart without dropping
   *     counts.
   *   - `topFailingSubnets` limits to 10 rows; failure = any outcome
   *     NOT in {success, bootstrap}.
   *   - `successRate` is computed FE-side from `kpis.success` /
   *     `kpis.total` to avoid float-rounding inconsistencies; only
   *     raw counts cross the wire.
   */
  async computeStats(days: number): Promise<{
    windowDays: number;
    windowStart: string;
    windowEnd: string;
    kpis: {
      total: number;
      todayTotal: number;
      success: number;
      failed: number;
      uniqueUsers: number;
      uniqueIps: number;
    };
    timeSeries: Array<{ date: string; success: number; failed: number }>;
    outcomeBreakdown: Array<{ outcome: string; count: number }>;
    countryBreakdown: Array<{ country: string; count: number }>;
    topFailingSubnets: Array<{ subnet: string; count: number }>;
    topAttemptingUsers: Array<{
      userId: string | null;
      usernameAttempted: string;
      total: number;
      success: number;
      failed: number;
    }>;
  }> {
    const clampedDays = Math.min(365, Math.max(1, Math.floor(days || 30)));
    const now = new Date();
    const start = new Date(now);
    start.setDate(start.getDate() - clampedDays);

    const TZ = 'Asia/Bangkok';
    const SUCCESS_SET = `('success','bootstrap')`;

    // --- KPI block ---------------------------------------------------
    const kpiRow: {
      total: string;
      today_total: string;
      success: string;
      failed: string;
      unique_users: string;
      unique_ips: string;
    } | undefined = await this.auditRepo
      .createQueryBuilder('a')
      .select('COUNT(*)::text', 'total')
      .addSelect(
        `COUNT(*) FILTER (WHERE (a.attempted_at AT TIME ZONE :tz)::date = (now() AT TIME ZONE :tz)::date)::text`,
        'today_total',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE a.outcome IN ${SUCCESS_SET})::text`,
        'success',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE a.outcome NOT IN ${SUCCESS_SET})::text`,
        'failed',
      )
      .addSelect(
        `COUNT(DISTINCT a.user_id) FILTER (WHERE a.user_id IS NOT NULL)::text`,
        'unique_users',
      )
      .addSelect(`COUNT(DISTINCT a.ip_address)::text`, 'unique_ips')
      .where('a.attempted_at >= :start AND a.attempted_at <= :end', {
        start,
        end: now,
      })
      .setParameter('tz', TZ)
      .getRawOne();

    const kpis = {
      total: Number(kpiRow?.total ?? 0),
      todayTotal: Number(kpiRow?.today_total ?? 0),
      success: Number(kpiRow?.success ?? 0),
      failed: Number(kpiRow?.failed ?? 0),
      uniqueUsers: Number(kpiRow?.unique_users ?? 0),
      uniqueIps: Number(kpiRow?.unique_ips ?? 0),
    };

    // --- Daily time series ------------------------------------------
    const tsRows: Array<{ d: string; success: string; failed: string }> =
      await this.auditRepo
        .createQueryBuilder('a')
        .select(
          `to_char(date_trunc('day', a.attempted_at AT TIME ZONE :tz), 'YYYY-MM-DD')`,
          'd',
        )
        .addSelect(
          `COUNT(*) FILTER (WHERE a.outcome IN ${SUCCESS_SET})::text`,
          'success',
        )
        .addSelect(
          `COUNT(*) FILTER (WHERE a.outcome NOT IN ${SUCCESS_SET})::text`,
          'failed',
        )
        .where('a.attempted_at >= :start AND a.attempted_at <= :end', {
          start,
          end: now,
        })
        .setParameter('tz', TZ)
        .groupBy(`date_trunc('day', a.attempted_at AT TIME ZONE :tz)`)
        .orderBy(`date_trunc('day', a.attempted_at AT TIME ZONE :tz)`, 'ASC')
        .getRawMany();

    const timeSeries = tsRows.map((r) => ({
      date: r.d,
      success: Number(r.success),
      failed: Number(r.failed),
    }));

    // --- Outcome breakdown ------------------------------------------
    const outcomeRows: Array<{ outcome: string; count: string }> =
      await this.auditRepo
        .createQueryBuilder('a')
        .select('a.outcome', 'outcome')
        .addSelect('COUNT(*)::text', 'count')
        .where('a.attempted_at >= :start AND a.attempted_at <= :end', {
          start,
          end: now,
        })
        .groupBy('a.outcome')
        .orderBy('COUNT(*)', 'DESC')
        .getRawMany();

    const outcomeBreakdown = outcomeRows.map((r) => ({
      outcome: r.outcome,
      count: Number(r.count),
    }));

    // --- Country breakdown (NULL → '??') ----------------------------
    const countryRows: Array<{ country: string | null; count: string }> =
      await this.auditRepo
        .createQueryBuilder('a')
        .select(`COALESCE(a.geo_country, '??')`, 'country')
        .addSelect('COUNT(*)::text', 'count')
        .where('a.attempted_at >= :start AND a.attempted_at <= :end', {
          start,
          end: now,
        })
        .groupBy(`COALESCE(a.geo_country, '??')`)
        .orderBy('COUNT(*)', 'DESC')
        .limit(12)
        .getRawMany();

    const countryBreakdown = countryRows.map((r) => ({
      country: r.country ?? '??',
      count: Number(r.count),
    }));

    // --- Top failing subnets ----------------------------------------
    const subnetRows: Array<{ subnet: string; count: string }> =
      await this.auditRepo
        .createQueryBuilder('a')
        .select('a.subnet_24::text', 'subnet')
        .addSelect('COUNT(*)::text', 'count')
        .where('a.attempted_at >= :start AND a.attempted_at <= :end', {
          start,
          end: now,
        })
        .andWhere(`a.outcome NOT IN ${SUCCESS_SET}`)
        .groupBy('a.subnet_24')
        .orderBy('COUNT(*)', 'DESC')
        .limit(10)
        .getRawMany();

    const topFailingSubnets = subnetRows.map((r) => ({
      subnet: r.subnet,
      count: Number(r.count),
    }));

    // --- Top attempting users (success / failed split) --------------
    // Group by (user_id, username_attempted). Multiple `usernameAttempted`
    // values for the SAME user_id are summed under the canonical email
    // — we MIN the username so the picked label is deterministic.
    // user_id IS NULL rows (unresolved username) keep their attempted
    // string as the identity key, which surfaces brute-force scans.
    const userRows: Array<{
      user_id: string | null;
      label: string;
      total: string;
      success: string;
      failed: string;
    }> = await this.auditRepo
      .createQueryBuilder('a')
      .select('a.user_id', 'user_id')
      .addSelect(
        `COALESCE(MIN(a.username_attempted), '')`,
        'label',
      )
      .addSelect('COUNT(*)::text', 'total')
      .addSelect(
        `COUNT(*) FILTER (WHERE a.outcome IN ${SUCCESS_SET})::text`,
        'success',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE a.outcome NOT IN ${SUCCESS_SET})::text`,
        'failed',
      )
      .where('a.attempted_at >= :start AND a.attempted_at <= :end', {
        start,
        end: now,
      })
      .groupBy('a.user_id')
      .addGroupBy(
        `CASE WHEN a.user_id IS NULL THEN a.username_attempted ELSE NULL END`,
      )
      .orderBy('COUNT(*)', 'DESC')
      .limit(10)
      .getRawMany();

    const topAttemptingUsers = userRows.map((r) => ({
      userId: r.user_id,
      usernameAttempted: r.label || '(ไม่ทราบ)',
      total: Number(r.total),
      success: Number(r.success),
      failed: Number(r.failed),
    }));

    return {
      windowDays: clampedDays,
      windowStart: start.toISOString(),
      windowEnd: now.toISOString(),
      kpis,
      timeSeries,
      outcomeBreakdown,
      countryBreakdown,
      topFailingSubnets,
      topAttemptingUsers,
    };
  }
}

/**
 * Expand an IPv6 address to its full 8-group form, handling the `::`
 * shorthand correctly per RFC 4291 (only one `::` allowed per address).
 *
 * Examples:
 *   `::1`           → ['0','0','0','0','0','0','0','1']
 *   `::`            → ['0','0','0','0','0','0','0','0']
 *   `2001:db8::1`   → ['2001','db8','0','0','0','0','0','1']
 *   `fe80::1:2:3:4` → ['fe80','0','0','0','1','2','3','4']
 */
function expandIpv6(ip: string): string[] {
  if (ip.includes('::')) {
    const [head, tail] = ip.split('::');
    const headGroups = head ? head.split(':') : [];
    const tailGroups = tail ? tail.split(':') : [];
    const missing = Math.max(0, 8 - headGroups.length - tailGroups.length);
    return [...headGroups, ...new Array(missing).fill('0'), ...tailGroups];
  }
  return ip.split(':');
}

/**
 * Mask IP to /24 (IPv4) or /64 (IPv6).
 *
 * The PG `inet` type accepts these as CIDR strings. Returning a plain
 * IPv4 host address when input is unparseable preserves the NOT NULL
 * constraint without crashing on bad input.
 *
 * IPv6 inputs MUST be fully expanded before slicing — the `::`
 * shorthand can only appear once per address, so naively appending
 * `::/64` to the first 4 groups produces invalid CIDR like
 * `::1:0::/64` when the input was `::1`.
 */
export function maskSubnet(ip: string | null | undefined): string {
  if (!ip) return '0.0.0.0';
  if (ip.includes(':')) {
    const groups = expandIpv6(ip);
    if (groups.length < 4) return '::/64';
    // First 4 groups (64 bits) + ::/64 — zero out the last 64 bits.
    return `${groups.slice(0, 4).join(':')}::/64`;
  }
  const parts = ip.split('.');
  if (parts.length !== 4) return '0.0.0.0/32';
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

/**
 * Resolve an IP address to a `{ country, city }` pair via the offline
 * MaxMind GeoLite2 DB bundled with `geoip-lite`. Returns `{ country:
 * null, city: null }` for IPs that the DB cannot resolve (private
 * ranges, IPv6 short-form, malformed input, etc.) so callers can store
 * NULL without distinguishing failure modes.
 *
 * Lookup is synchronous (the DB is in-memory after the first call) and
 * cheap (~50µs), so it's safe to call inline from the audit-write
 * critical path.
 *
 * IPv6 inputs flow through directly — `geoip-lite` accepts both
 * families. Private / link-local ranges (10.x, 192.168.x, ::1, fe80::)
 * return `null` from `geoip.lookup`, which we coalesce to the empty
 * pair.
 */
export function resolveGeo(ip: string | null | undefined): {
  country: string | null;
  city: string | null;
  lat: string | null;
  lng: string | null;
} {
  if (!ip) return { country: null, city: null, lat: null, lng: null };
  // Loopback / RFC 1918 private / link-local / IPv6 ULA + loopback
  // never resolve via geoip-lite — geo DBs only cover public IPs. We
  // tag these as `LAN` (sentinel) so the FE can render the bucket as
  // "เครือข่ายภายใน" instead of the generic "ไม่ทราบ" globe.
  // Without this, an admin testing the system from localhost / on-prem
  // would see every attempt fall into `??` with no explanation.
  if (isPrivateOrLoopback(ip)) {
    return { country: 'LAN', city: null, lat: null, lng: null };
  }
  try {
    const hit = geoip.lookup(ip);
    if (!hit) return { country: null, city: null, lat: null, lng: null };
    const country = (hit.country || '').slice(0, 2).toUpperCase() || null;
    const city = (hit.city || '').slice(0, 64) || null;
    // `ll` is `[lat, lng]` — defaults to `[0, 0]` for partial DB hits;
    // we treat a strict 0/0 pair as "no coords" to avoid pinning the
    // Atlantic Ocean for IPs the DB only resolved to country level.
    const ll = Array.isArray(hit.ll) ? hit.ll : [0, 0];
    const latNum = Number(ll[0] ?? 0);
    const lngNum = Number(ll[1] ?? 0);
    const haveCoords =
      Number.isFinite(latNum) && Number.isFinite(lngNum) &&
      !(latNum === 0 && lngNum === 0);
    return {
      country,
      city,
      lat: haveCoords ? latNum.toFixed(6) : null,
      lng: haveCoords ? lngNum.toFixed(6) : null,
    };
  } catch {
    return { country: null, city: null, lat: null, lng: null };
  }
}

/**
 * Detect IPs that geoip-lite will NEVER resolve — loopback, RFC 1918
 * private, link-local, IPv6 ULA. Used by `resolveGeo` so we can tag
 * them with the `LAN` sentinel instead of dropping into the generic
 * "unknown" bucket.
 *
 * Coverage:
 *   IPv4 loopback        — `127.0.0.0/8`
 *   IPv4 unspecified     — `0.0.0.0`
 *   IPv4 RFC 1918        — `10/8`, `172.16/12`, `192.168/16`
 *   IPv4 link-local      — `169.254/16`
 *   IPv4 CGNAT           — `100.64/10`
 *   IPv6 loopback        — `::1`
 *   IPv6 unspecified     — `::`
 *   IPv6 link-local      — `fe80::/10`
 *   IPv6 ULA             — `fc00::/7` (covers `fc**` + `fd**`)
 *   IPv6-mapped IPv4     — `::ffff:127.0.0.1` etc. — strip prefix + recurse
 */
export function isPrivateOrLoopback(ip: string | null | undefined): boolean {
  if (!ip) return true;
  const raw = ip.trim().toLowerCase();
  if (raw === '' || raw === '0.0.0.0' || raw === '::' || raw === '::1')
    return true;

  // IPv6-mapped IPv4 → unwrap and recurse on the IPv4 portion.
  if (raw.startsWith('::ffff:')) {
    const v4 = raw.slice('::ffff:'.length);
    return isPrivateOrLoopback(v4);
  }

  // IPv6 link-local + ULA.
  if (raw.startsWith('fe8') || raw.startsWith('fe9') || raw.startsWith('fea') ||
      raw.startsWith('feb')) return true; // fe80::/10
  if (raw.startsWith('fc') || raw.startsWith('fd')) return true; // fc00::/7

  // IPv4 dotted-quad.
  if (raw.includes('.') && !raw.includes(':')) {
    const parts = raw.split('.').map((p) => Number(p));
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      const [a, b] = parts;
      if (a === 127 || a === 10) return true;
      if (a === 192 && b === 168) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 169 && b === 254) return true;
      if (a === 100 && b >= 64 && b <= 127) return true;
    }
  }
  return false;
}

/** User-facing mask (drops the suffix). */
export function maskIpForDisplay(ip: string | null | undefined): string {
  if (!ip) return 'unknown';
  if (ip.includes(':')) {
    const groups = expandIpv6(ip);
    if (groups.length < 4) return '::';
    return `${groups.slice(0, 4).join(':')}::`;
  }
  const parts = ip.split('.');
  if (parts.length !== 4) return ip;
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}
