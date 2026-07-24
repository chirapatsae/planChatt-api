import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Not, Repository } from 'typeorm';

import { CitizenSession } from '../entities/citizen-session.entity';
import { SessionCache } from '../../common/session-registry/session-cache';
import {
  deviceHash,
  parseUserAgent,
} from '../../common/session-registry/session-device.util';
import {
  sessionDeviceLabel,
  sessionLocationLabel,
} from '../../common/session-registry/session-labels.util';
// Reuse the SINGLE geoip implementation (do NOT re-import geoip-lite here) +
// the /24 subnet mask. Pure functions — importing them is NOT a data FK and
// does not couple the citizen boundary to backup-login data (§17.3 intact).
import {
  maskSubnet,
  resolveGeo,
} from '../../backup-login/backup-attempt-audit.service';
import { encryption } from '../../util/encryption.util';

/** Args the mint point (Batch 2) passes to `record()`. */
export interface RecordCitizenSessionArgs {
  identityId: string;
  sessionVersion: number;
  loginMethod: string;
  ip: string | null;
  userAgent: string | null;
  /** Session expiry — caller sets it (citizen token lifetime). */
  expiresAt: Date;
}

/**
 * Result of a `record()` INSERT plus the two facts the Batch-2 mint helper needs
 * to decide whether to fire a new-device alert:
 *   - `isNewDevice`   — no PRIOR non-revoked session for the account shares this
 *                       row's `device_hash` (browser|os|subnet24).
 *   - `isFirstSession`— the account had ZERO prior sessions (first login / just
 *                       registered) → NEVER alert (no "new sign-in" on signup).
 * Both are computed against the state BEFORE this row was inserted.
 */
export interface RecordedCitizenSession {
  row: CitizenSession;
  isNewDevice: boolean;
  isFirstSession: boolean;
}

/** One row of the device-manager listing (GET /citizen-engagement/sessions). */
export interface CitizenSessionView {
  sid: string;
  /** `browser · os` for the device-manager row. */
  deviceLabel: string;
  /** `city, country` or the masked /24 subnet, or null when unknown. */
  location: string | null;
  lastSeenAt: Date;
  createdAt: Date;
  /** True for the caller's CURRENT session (sid === req.user.sid). */
  current: boolean;
}

/**
 * CitizenSessionRegistryService — the CITIZEN half of the per-session registry
 * (login-alerts / device-session-management). Owns `citizen_session` reads +
 * enforcement + revocation + the mint INSERT. Isolated under citizen-engagement
 * so it never shares a service/instance with the staff half (§17.3 spirit).
 *
 * Batch 1 wires ONLY the enforcement path (`assertCitizenActive`, called from
 * `CitizenJwtStrategy.validate` behind the `SESSION_REGISTRY_ENABLED` flag) and
 * exposes `record` / `revoke` / `revokeOthers` / `bust` for Batch 2's mint +
 * device-manager endpoints. No mint point calls `record()` yet.
 */
@Injectable()
export class CitizenSessionRegistryService {
  private readonly cache = new SessionCache(30_000);
  private static readonly LAST_SEEN_THROTTLE = "interval '5 minutes'";

  constructor(
    @InjectRepository(CitizenSession)
    private readonly repo: Repository<CitizenSession>,
  ) {}

  /**
   * Fail-closed per-session gate. Cache hit → verify not-revoked + not-expired.
   * Miss → single indexed PK lookup by `id` (== sid), verify owner match, not
   * revoked, not expired → cache + throttled last-seen touch. Any failure
   * (missing / revoked / expired / owner-mismatch) → generic 401.
   */
  async assertCitizenActive(sid: string, identityId: string): Promise<void> {
    const now = Date.now();

    const cached = this.cache.get(sid);
    if (cached) {
      if (cached.revokedAt !== null || cached.expiresAt <= now) {
        throw new UnauthorizedException('Citizen session is no longer valid');
      }
      return;
    }

    const row = await this.repo.findOne({
      where: { id: sid },
      select: {
        id: true,
        identityId: true,
        expiresAt: true,
        revokedAt: true,
      },
    });

    // Owner match guards against a token whose `sid` was minted for a DIFFERENT
    // identity (defense-in-depth beyond the signed `sub`). Missing / revoked /
    // expired all collapse to the same generic 401 (no enumeration signal).
    const expiresMs = row?.expiresAt ? new Date(row.expiresAt).getTime() : 0;
    if (
      !row ||
      row.identityId !== identityId ||
      row.revokedAt !== null ||
      expiresMs <= now
    ) {
      throw new UnauthorizedException('Citizen session is no longer valid');
    }

    this.cache.set(sid, {
      revokedAt: null,
      expiresAt: expiresMs,
      cachedAt: now,
    });

    // Touch on cache-refresh only (NOT per request), and only if stale >5min.
    await this.touchLastSeen(sid);
  }

  /** Update `last_seen_at` only if it is older than 5 minutes (single UPDATE). */
  async touchLastSeen(sid: string): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .update(CitizenSession)
      .set({ lastSeenAt: () => 'now()' })
      .where('id = :sid', { sid })
      .andWhere(
        `last_seen_at < now() - ${CitizenSessionRegistryService.LAST_SEEN_THROTTLE}`,
      )
      .execute();
  }

  /**
   * INSERT a new session row and return it (plus new-device / first-session
   * facts). Batch 2's citizen mint point calls this. Encrypts the IP (PDPA),
   * derives subnet/geo/device-hash, parses UA.
   *
   * New-device detection runs BEFORE the INSERT: `isNewDevice` is true iff no
   * PRIOR non-revoked row for the identity shares this `device_hash`;
   * `isFirstSession` is true iff the identity had ZERO prior sessions at all
   * (so the mint helper can suppress the alert on a first/just-registered login).
   */
  async record(args: RecordCitizenSessionArgs): Promise<RecordedCitizenSession> {
    const subnet24 = args.ip ? maskSubnet(args.ip) : null;
    const geo = resolveGeo(args.ip);
    const { browser, os } = parseUserAgent(args.userAgent);
    const dHash = deviceHash(browser, os, subnet24);
    const ipEnc = args.ip ? await encryption(args.ip) : null;

    const [priorSameDevice, anyPrior] = await Promise.all([
      this.repo.count({
        where: {
          identityId: args.identityId,
          deviceHash: dHash,
          revokedAt: IsNull(),
        },
      }),
      this.repo.count({ where: { identityId: args.identityId } }),
    ]);

    const entity = this.repo.create({
      identityId: args.identityId,
      sessionVersion: args.sessionVersion,
      loginMethod: (args.loginMethod || 'password').slice(0, 16),
      deviceHash: dHash,
      browserLabel: browser,
      osLabel: os,
      ipEnc,
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
   * Device-manager listing: the identity's active (non-revoked, non-expired)
   * sessions, current-first then last-seen desc. `find` already orders by
   * `last_seen_at DESC`; a stable sort then floats the current session to the
   * top without disturbing the rest of the order.
   */
  async listForIdentity(
    identityId: string,
    currentSid: string | undefined,
  ): Promise<CitizenSessionView[]> {
    const rows = await this.repo.find({
      where: { identityId, revokedAt: IsNull(), expiresAt: MoreThan(new Date()) },
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
   * Revoke ONE session, but ONLY when the row belongs to `identityId` (no IDOR
   * — a caller can never revoke another account's device). Returns false when
   * the row is missing / not owned so the controller can answer a flat 404.
   */
  async revokeOwned(sid: string, identityId: string): Promise<boolean> {
    const row = await this.repo.findOne({
      where: { id: sid, identityId },
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
      .update(CitizenSession)
      .set({ revokedAt: () => 'now()', revokedReason: reason.slice(0, 32) })
      .where('id = :sid', { sid })
      .andWhere('revoked_at IS NULL')
      .execute();
    this.cache.bust(sid);
  }

  /** Revoke every OTHER active session of this identity ("sign out others").
   *  A legacy caller (token minted before the flag flip) has NO `sid` → an
   *  empty string can't cast to uuid, so we drop the `id <>` predicate and
   *  revoke ALL the identity's rows (their legacy token stays valid via
   *  session_version until it expires). [SEC P2-1] */
  async revokeOthers(identityId: string, currentSid: string): Promise<void> {
    const hasCurrent = !!currentSid;
    const others = await this.repo.find({
      where: hasCurrent
        ? { identityId, id: Not(currentSid), revokedAt: IsNull() }
        : { identityId, revokedAt: IsNull() },
      select: { id: true },
    });
    const qb = this.repo
      .createQueryBuilder()
      .update(CitizenSession)
      .set({ revokedAt: () => 'now()', revokedReason: 'revoke_others' })
      .where('identity_id = :identityId', { identityId })
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
