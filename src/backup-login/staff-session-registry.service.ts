import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Not, Repository } from 'typeorm';

import { StaffSession } from './entities/staff-session.entity';
import { SessionCache } from '../common/session-registry/session-cache';
import {
  deviceHash,
  parseUserAgent,
} from '../common/session-registry/session-device.util';
// Reuse the SINGLE geoip implementation (do NOT re-import geoip-lite here) +
// the /24 subnet mask — both live in this same module's audit service.
import { maskSubnet, resolveGeo } from './backup-attempt-audit.service';
// Shared (neutral) device / location label formatters — same folder as
// session-device.util, so neither cohort imports the other's service.
import {
  sessionDeviceLabel,
  sessionLocationLabel,
} from '../common/session-registry/session-labels.util';

/** Args the staff mint point (Batch 2) passes to `record()`. */
export interface RecordStaffSessionArgs {
  userId: string;
  sessionVersion: number;
  loginMethod: string;
  ip: string | null;
  userAgent: string | null;
  /** Session expiry — caller sets created + 8h (staff session window). */
  expiresAt: Date;
}

/** Result of a staff `record()` INSERT + new-device / first-session facts. */
export interface RecordedStaffSession {
  row: StaffSession;
  isNewDevice: boolean;
  isFirstSession: boolean;
}

/** One row of the staff device-manager listing (GET /auth/sessions). */
export interface StaffSessionView {
  sid: string;
  deviceLabel: string;
  location: string | null;
  lastSeenAt: Date;
  createdAt: Date;
  current: boolean;
}

/**
 * StaffSessionRegistryService — the STAFF half of the per-session registry
 * (login-alerts / device-session-management). Owns `staff_session` reads +
 * enforcement + revocation + the mint INSERT. Distinct instance from the
 * citizen half (no cross-boundary service).
 *
 * Registered in the `@Global()` StaffSessionRegistryModule so the app-wide
 * `JwtAuthGuard` (used by ~40 modules) can inject it without every module
 * importing backup-login. Batch 1 wires ONLY the enforcement path
 * (`assertStaffActive`, called from `JwtAuthGuard.canActivate` behind the
 * `SESSION_REGISTRY_ENABLED` flag) and exposes `record` / `revoke` /
 * `revokeOthers` / `bust` for Batch 2. No mint point calls `record()` yet.
 */
@Injectable()
export class StaffSessionRegistryService {
  private readonly cache = new SessionCache(30_000);
  private static readonly LAST_SEEN_THROTTLE = "interval '5 minutes'";

  constructor(
    @InjectRepository(StaffSession)
    private readonly repo: Repository<StaffSession>,
  ) {}

  /**
   * Fail-closed per-session gate. Cache hit → verify not-revoked + not-expired.
   * Miss → single indexed PK lookup by `id` (== sid), verify owner match, not
   * revoked, not expired → cache + throttled last-seen touch. Any failure
   * (missing / revoked / expired / owner-mismatch) → generic 401.
   */
  async assertStaffActive(sid: string, userId: string): Promise<void> {
    const now = Date.now();

    const cached = this.cache.get(sid);
    if (cached) {
      if (cached.revokedAt !== null || cached.expiresAt <= now) {
        throw new UnauthorizedException('Session is no longer valid');
      }
      return;
    }

    const row = await this.repo.findOne({
      where: { id: sid },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        revokedAt: true,
      },
    });

    const expiresMs = row?.expiresAt ? new Date(row.expiresAt).getTime() : 0;
    if (
      !row ||
      row.userId !== userId ||
      row.revokedAt !== null ||
      expiresMs <= now
    ) {
      throw new UnauthorizedException('Session is no longer valid');
    }

    this.cache.set(sid, {
      revokedAt: null,
      expiresAt: expiresMs,
      cachedAt: now,
    });

    await this.touchLastSeen(sid);
  }

  /** Update `last_seen_at` only if it is older than 5 minutes (single UPDATE). */
  async touchLastSeen(sid: string): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .update(StaffSession)
      .set({ lastSeenAt: () => 'now()' })
      .where('id = :sid', { sid })
      .andWhere(
        `last_seen_at < now() - ${StaffSessionRegistryService.LAST_SEEN_THROTTLE}`,
      )
      .execute();
  }

  /**
   * INSERT a new session row and return it (plus new-device / first-session
   * facts). Batch 2's staff mint point calls this. IP is stored in the clear
   * (staff boundary); derives subnet/geo/device-hash, parses UA.
   *
   * New-device detection runs BEFORE the INSERT: `isNewDevice` is true iff no
   * PRIOR non-revoked row for the user shares this `device_hash`;
   * `isFirstSession` is true iff the user had ZERO prior sessions at all.
   */
  async record(args: RecordStaffSessionArgs): Promise<RecordedStaffSession> {
    const subnet24 = args.ip ? maskSubnet(args.ip) : null;
    const geo = resolveGeo(args.ip);
    const { browser, os } = parseUserAgent(args.userAgent);
    const dHash = deviceHash(browser, os, subnet24);

    const [priorSameDevice, anyPrior] = await Promise.all([
      this.repo.count({
        where: {
          userId: args.userId,
          deviceHash: dHash,
          revokedAt: IsNull(),
        },
      }),
      this.repo.count({ where: { userId: args.userId } }),
    ]);

    const entity = this.repo.create({
      userId: args.userId,
      sessionVersion: args.sessionVersion,
      loginMethod: (args.loginMethod || 'password').slice(0, 16),
      deviceHash: dHash,
      browserLabel: browser,
      osLabel: os,
      ipAddress: args.ip,
      subnet24,
      geoCountry: geo.country,
      geoCity: geo.city,
      expiresAt: args.expiresAt,
    });
    const row = await this.repo.save(entity);
    return {
      row,
      isNewDevice: priorSameDevice === 0,
      isFirstSession: anyPrior === 0,
    };
  }

  /**
   * Device-manager listing: the user's active (non-revoked, non-expired)
   * sessions, current-first then last-seen desc.
   */
  async listForUser(
    userId: string,
    currentSid: string | undefined,
  ): Promise<StaffSessionView[]> {
    const rows = await this.repo.find({
      where: { userId, revokedAt: IsNull(), expiresAt: MoreThan(new Date()) },
      order: { lastSeenAt: 'DESC' },
    });
    return rows
      .map((r) => ({
        sid: r.id,
        deviceLabel: sessionDeviceLabel(r.browserLabel, r.osLabel),
        location: sessionLocationLabel(r.geoCity, r.geoCountry, r.subnet24),
        lastSeenAt: r.lastSeenAt,
        createdAt: r.createdAt,
        current: !!currentSid && r.id === currentSid,
      }))
      .sort((a, b) => (a.current === b.current ? 0 : a.current ? -1 : 1));
  }

  /**
   * Revoke ONE session, but ONLY when the row belongs to `userId` (no IDOR).
   * Returns false when the row is missing / not owned so the controller can
   * answer a flat 404.
   */
  async revokeOwned(sid: string, userId: string): Promise<boolean> {
    const row = await this.repo.findOne({
      where: { id: sid, userId },
      select: { id: true },
    });
    if (!row) return false;
    await this.revoke(sid, 'user');
    return true;
  }

  /** Revoke a single session (device-manager "sign out this device"). */
  async revoke(sid: string, reason: string): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .update(StaffSession)
      .set({ revokedAt: () => 'now()', revokedReason: reason.slice(0, 32) })
      .where('id = :sid', { sid })
      .andWhere('revoked_at IS NULL')
      .execute();
    this.cache.bust(sid);
  }

  /** Revoke every OTHER active session of this user ("sign out others").
   *  A legacy caller (token minted before the flag flip) has NO `sid` → an
   *  empty string can't cast to uuid, so we drop the `id <>` predicate and
   *  revoke ALL the user's rows (their legacy token stays valid via
   *  session_version until it expires ≤8h). [SEC P2-1] */
  async revokeOthers(userId: string, currentSid: string): Promise<void> {
    const hasCurrent = !!currentSid;
    const others = await this.repo.find({
      where: hasCurrent
        ? { userId, id: Not(currentSid), revokedAt: IsNull() }
        : { userId, revokedAt: IsNull() },
      select: { id: true },
    });
    const qb = this.repo
      .createQueryBuilder()
      .update(StaffSession)
      .set({ revokedAt: () => 'now()', revokedReason: 'revoke_others' })
      .where('user_id = :userId', { userId })
      .andWhere('revoked_at IS NULL');
    if (hasCurrent) qb.andWhere('id <> :currentSid', { currentSid });
    await qb.execute();
    for (const o of others) this.cache.bust(o.id);
  }

  /** Evict a sid from the cache (used after out-of-band revokes). */
  bust(sid: string): void {
    this.cache.bust(sid);
  }
}
