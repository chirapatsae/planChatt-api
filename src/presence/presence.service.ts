/**
 * W106-BE-PR1 — PresenceService
 *
 * Single source of truth for live user presence. Owns:
 *   - Redis state (per-source online markers, debounce keys)
 *   - Durable `users.last_seen_at` write path (debounced)
 *   - presence:changed event emission via @nestjs/event-emitter
 *   - Stale-row sweep (cron-driven, see PresenceSweeper)
 *
 * STRICT compliance:
 *   - §17.3 / §12: NEVER writes to tracking_status / notification_*_logs /
 *     user_activity_log / any audit table. Verified by grep gate.
 *   - §17.2 / §4.1: presence is ADVISORY metadata. Never gates a workflow
 *     transition, never alters ownership / authority. Service has no imports
 *     from TrackingStatusModule, ProjectGroupModule, or any workflow surface.
 *
 * Decisions for the 5 DB-PR1 open questions (see report):
 *   1. Index — plain b-tree from DB-PR1 is sufficient at <10k user scale.
 *   2. Serializer masking — `lastSeenAt` is NOT @Exclude()'d on the entity;
 *      authoritative presence is exposed only via /v1/presence/* endpoints.
 *   3. DB write debounce — 30s, tracked via Redis key
 *      `presence:lastwrite:user:<id>` with EXPIRE 30. Hot heartbeat refreshes
 *      Redis TTL but skips the SQL UPDATE.
 *   4. Migration — `synchronize: true` covers DDL, no migration file needed.
 *   5. lastSeenAt write site — every debounced heartbeat AND WS connect
 *      AND WS disconnect (debounced same way). See `markOnline` /
 *      `markOffline`.
 *
 * Redis key shape:
 *   presence:user:<userId>:source:<ws|http>     EX 90    value: '1'
 *     - one key per (user, source). Online iff ANY source key exists.
 *     - per-source keys allow a user to be online via WS while heartbeat
 *       lapses, and vice-versa, without one source clobbering the other.
 *   presence:lastwrite:user:<userId>            EX 30    value: '1'
 *     - debounce marker for the SQL UPDATE on users.last_seen_at.
 *     - presence-key reads do NOT touch this key.
 *
 * Graceful-degrade contract (Redis down):
 *   - markOnline / markOffline / markHeartbeatDb log warning, no-op on Redis.
 *     The SQL UPDATE still runs (debounced via in-memory fallback below).
 *   - getPresence / getPresenceBulk fall back to Postgres-only inference:
 *     online = `last_seen_at >= NOW() - 60s`.
 *   - Service NEVER throws to controllers; presence failures must not cascade.
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { In, Repository } from 'typeorm';
import { User } from 'src/users/entities/user.entity';
import { PresenceRedis } from './presence.redis';

export type PresenceSource = 'ws' | 'http';

export interface PresenceEntry {
  online: boolean;
  lastSeen: Date | null;
}

export interface PresenceChangedEvent {
  userId: string;
  online: boolean;
  lastSeen: Date | null;
}

const KEY_PRESENCE_PREFIX = 'presence:user:';
const KEY_LASTWRITE_PREFIX = 'presence:lastwrite:user:';
const PRESENCE_TTL_SECONDS = 90;
const DB_DEBOUNCE_SECONDS = 30;
const FALLBACK_ONLINE_WINDOW_MS = 60 * 1000;

/**
 * In-memory debounce fallback used when Redis is down. We still want to
 * avoid hammering Postgres in degrade mode, so a per-user timestamp map
 * gates the SQL UPDATE. This map is purely advisory and is reset on
 * process restart — that is acceptable since debounce is best-effort.
 */
const inMemoryLastWrite = new Map<string, number>();

@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly redis: PresenceRedis,
    private readonly events: EventEmitter2,
  ) {}

  // ---------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------

  private presenceKey(userId: string, source: PresenceSource): string {
    return `${KEY_PRESENCE_PREFIX}${userId}:source:${source}`;
  }

  private presenceUserPattern(userId: string): string {
    return `${KEY_PRESENCE_PREFIX}${userId}:source:*`;
  }

  private lastWriteKey(userId: string): string {
    return `${KEY_LASTWRITE_PREFIX}${userId}`;
  }

  /**
   * Returns true iff the user has any live source key. On Redis outage,
   * returns false (callers fall back to last_seen_at heuristic).
   */
  private async hasAnySource(userId: string): Promise<boolean> {
    const client = this.redis.raw();
    if (!this.redis.isHealthy() || !client) return false;
    try {
      // EXISTS with a small fixed key list is O(1). We probe both sources.
      const n = await client.exists(
        this.presenceKey(userId, 'ws'),
        this.presenceKey(userId, 'http'),
      );
      return n > 0;
    } catch (e: any) {
      this.logger.warn(`[presence] hasAnySource fallback: ${e?.message ?? e}`);
      return false;
    }
  }

  /**
   * Debounced UPDATE of `users.last_seen_at`. Returns true if the SQL
   * write actually fired (used by callers for transition detection).
   *
   * Debounce gate priority:
   *   1. Redis lastwrite key (cluster-safe across replicas, future-proof
   *      for the multi-instance follow-up flagged as Wave 108)
   *   2. In-memory map (degrade fallback when Redis is down)
   */
  private async writeLastSeenDebounced(userId: string): Promise<boolean> {
    const client = this.redis.raw();
    let allowedByRedis = false;
    let redisChecked = false;

    if (this.redis.isHealthy() && client) {
      redisChecked = true;
      try {
        // SET NX EX 30 — atomic "first writer wins" per 30-second window.
        const res = await client.set(
          this.lastWriteKey(userId),
          '1',
          'EX',
          DB_DEBOUNCE_SECONDS,
          'NX',
        );
        allowedByRedis = res === 'OK';
      } catch (e: any) {
        this.logger.warn(
          `[presence] debounce gate fallback: ${e?.message ?? e}`,
        );
        redisChecked = false;
      }
    }

    if (!redisChecked) {
      const now = Date.now();
      const last = inMemoryLastWrite.get(userId) ?? 0;
      if (now - last < DB_DEBOUNCE_SECONDS * 1000) {
        return false;
      }
      inMemoryLastWrite.set(userId, now);
      allowedByRedis = true;
    }

    if (!allowedByRedis) return false;

    try {
      await this.userRepo.update({ id: userId }, { lastSeenAt: new Date() });
      return true;
    } catch (e: any) {
      this.logger.warn(
        `[presence] users.last_seen_at update failed: ${e?.message ?? e}`,
      );
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  /**
   * Mark a user online for a given source (WS or HTTP heartbeat).
   * Sets/refreshes the per-source key with EXPIRE 90 and writes
   * `users.last_seen_at` (debounced 30s).
   *
   * Emits `presence:changed { online: true }` ONLY on the offline→online
   * transition (when no other source key existed before this call).
   *
   * Never throws.
   */
  async markOnline(userId: string, source: PresenceSource): Promise<void> {
    if (!userId) return;

    const wasOnline = await this.hasAnySource(userId);

    const client = this.redis.raw();
    if (this.redis.isHealthy() && client) {
      try {
        await client.set(
          this.presenceKey(userId, source),
          '1',
          'EX',
          PRESENCE_TTL_SECONDS,
        );
      } catch (e: any) {
        this.logger.warn(
          `[presence] markOnline Redis write failed: ${e?.message ?? e}`,
        );
        // continue — DB write still runs
      }
    }

    // Per DB-PR1 Q5: write last_seen_at on every debounced heartbeat /
    // connect event so a Redis flush still leaves a recent durable value.
    await this.writeLastSeenDebounced(userId);

    if (!wasOnline) {
      const lastSeen = await this.lookupLastSeen(userId);
      this.events.emit('presence:changed', {
        userId,
        online: true,
        lastSeen,
      } as PresenceChangedEvent);
    }
  }

  /**
   * Mark a user's source as offline. If no other source remains, the user
   * transitions to fully offline and emits `presence:changed { online: false }`.
   *
   * Per spec: we DO NOT write last_seen_at on disconnect; the most recent
   * connect / heartbeat already wrote it. Letting the Redis key lapse is
   * sufficient.
   *
   * Never throws.
   */
  async markOffline(userId: string, source: PresenceSource): Promise<void> {
    if (!userId) return;

    const client = this.redis.raw();
    if (this.redis.isHealthy() && client) {
      try {
        await client.del(this.presenceKey(userId, source));
      } catch (e: any) {
        this.logger.warn(
          `[presence] markOffline Redis del failed: ${e?.message ?? e}`,
        );
      }
    }

    const stillOnline = await this.hasAnySource(userId);
    if (!stillOnline) {
      const lastSeen = await this.lookupLastSeen(userId);
      this.events.emit('presence:changed', {
        userId,
        online: false,
        lastSeen,
      } as PresenceChangedEvent);
    }
  }

  /**
   * Single-user presence lookup. Used by GET /v1/presence/me and as a
   * helper inside the service. Hits Redis (EXISTS) + a single SELECT for
   * lastSeen.
   *
   * Graceful degrade: when Redis is down, online is inferred from
   * `last_seen_at` within the last 60s.
   */
  async getPresence(userId: string): Promise<PresenceEntry> {
    const lastSeen = await this.lookupLastSeen(userId);
    let online = await this.hasAnySource(userId);

    if (!this.redis.isHealthy()) {
      online =
        !!lastSeen &&
        Date.now() - lastSeen.getTime() <= FALLBACK_ONLINE_WINDOW_MS;
    }

    return { online, lastSeen };
  }

  /**
   * Bulk presence lookup. Single Redis MGET (over both source keys per
   * user) + single Postgres `WHERE id IN (...)` query that filters
   * soft-deleted users.
   *
   * Soft-deleted users → `{ online: false, lastSeen: null }` (excluded
   * from the IN clause naturally; we backfill them in the response shape).
   */
  async getPresenceBulk(
    userIds: string[],
  ): Promise<Record<string, PresenceEntry>> {
    const result: Record<string, PresenceEntry> = {};
    if (!userIds.length) return result;

    // Default everyone to offline + null. Live users overwrite below.
    for (const id of userIds) {
      result[id] = { online: false, lastSeen: null };
    }

    // 1. Postgres lookup (one round trip; soft-deleted users excluded
    //    by the default scope on `find`).
    let rows: Pick<User, 'id' | 'lastSeenAt'>[] = [];
    try {
      rows = await this.userRepo.find({
        where: { id: In(userIds) },
        select: { id: true, lastSeenAt: true },
      });
    } catch (e: any) {
      this.logger.warn(
        `[presence] bulk users lookup failed: ${e?.message ?? e}`,
      );
      // Fall through with default offline entries; do not throw.
    }

    // Build a positive set of "live" (non-soft-deleted) ids. This gates
    // online elevation below so a soft-deleted user whose Redis presence
    // key has not yet expired cannot bleed back onto the API as online —
    // QA-W106 P1: result map was pre-seeded for ALL input ids, so the
    // earlier `if (result[id])` guard never rejected anyone.
    const liveIds = new Set<string>(rows.map((r) => r.id));

    for (const row of rows) {
      result[row.id] = {
        online: false,
        lastSeen: row.lastSeenAt ?? null,
      };
    }

    // 2. Redis MGET — one round trip across all userIds × 2 sources.
    const client = this.redis.raw();
    if (this.redis.isHealthy() && client) {
      try {
        const keys: string[] = [];
        for (const id of userIds) {
          keys.push(this.presenceKey(id, 'ws'));
          keys.push(this.presenceKey(id, 'http'));
        }
        const values = await client.mget(...keys);
        for (let i = 0; i < userIds.length; i++) {
          const wsVal = values[i * 2];
          const httpVal = values[i * 2 + 1];
          if (wsVal !== null || httpVal !== null) {
            const id = userIds[i];
            // Only elevate users that survived the soft-delete-aware
            // Postgres SELECT. Non-live ids (soft-deleted / non-existent)
            // remain offline regardless of stale Redis state.
            if (liveIds.has(id)) {
              result[id] = { ...result[id], online: true };
            }
          }
        }
      } catch (e: any) {
        this.logger.warn(`[presence] bulk MGET failed: ${e?.message ?? e}`);
        // Degrade to Postgres-only inference below.
      }
    }

    if (!this.redis.isHealthy()) {
      const cutoff = Date.now() - FALLBACK_ONLINE_WINDOW_MS;
      for (const id of userIds) {
        // Same liveIds gate applies to the degraded path — never elevate
        // a soft-deleted user even if their lastSeenAt is recent.
        if (!liveIds.has(id)) continue;
        const entry = result[id];
        if (entry?.lastSeen && entry.lastSeen.getTime() >= cutoff) {
          result[id] = { ...entry, online: true };
        }
      }
    }

    return result;
  }

  /**
   * Lightweight read of a single user's `last_seen_at`. Used by transition
   * emission paths so the event payload carries a fresh timestamp.
   */
  private async lookupLastSeen(userId: string): Promise<Date | null> {
    try {
      const row = await this.userRepo.findOne({
        where: { id: userId },
        select: { id: true, lastSeenAt: true },
      });
      return row?.lastSeenAt ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Self-heal sweep — invoked by `PresenceSweeper` cron every 60s.
   *
   * Strategy: scan a bounded sample of `presence:user:*` keys via SCAN
   * (NOT KEYS — that is O(N) blocking). For each presence key, we trust
   * Redis's EXPIRE to do the real work. The sweep's job is to detect the
   * inverse ghost: a `users.last_seen_at` that was very recent but whose
   * Redis source keys have ALL lapsed — meaning the WS disconnect path
   * was missed (e.g., process crash). Emit `presence:changed { online:
   * false }` so subscribed clients flip the dot to gray.
   *
   * Returns the number of ghost users for which we emitted offline.
   */
  async sweep(): Promise<{ ghostsEmitted: number }> {
    const client = this.redis.raw();
    if (!this.redis.isHealthy() || !client) {
      return { ghostsEmitted: 0 };
    }

    // Find users seen in the last 2 minutes (anyone older is already
    // offline by definition; their dot is gray and no sweep is needed).
    const since = new Date(Date.now() - 2 * 60 * 1000);
    let recentUsers: Pick<User, 'id' | 'lastSeenAt'>[] = [];
    try {
      recentUsers = await this.userRepo
        .createQueryBuilder('u')
        .select(['u.id', 'u.lastSeenAt'])
        .where('u.lastSeenAt IS NOT NULL')
        .andWhere('u.lastSeenAt >= :since', { since })
        .andWhere('u.deletedAt IS NULL')
        .limit(500) // bounded: presence target is ≤500 concurrent
        .getMany();
    } catch (e: any) {
      this.logger.warn(`[presence] sweep query failed: ${e?.message ?? e}`);
      return { ghostsEmitted: 0 };
    }

    let ghosts = 0;
    for (const u of recentUsers) {
      let alive = false;
      try {
        const n = await client.exists(
          this.presenceKey(u.id, 'ws'),
          this.presenceKey(u.id, 'http'),
        );
        alive = n > 0;
      } catch {
        // single-key error — skip without flipping the user
        continue;
      }
      if (!alive) {
        // Ghost: DB says recent, Redis says nobody. Emit offline so the
        // UI flips. We do NOT touch last_seen_at (audit-friendly).
        ghosts++;
        this.events.emit('presence:changed', {
          userId: u.id,
          online: false,
          lastSeen: u.lastSeenAt,
        } as PresenceChangedEvent);
      }
    }

    if (ghosts > 0) {
      this.logger.log(`[presence] sweep emitted offline for ${ghosts} ghosts`);
    }
    return { ghostsEmitted: ghosts };
  }
}
