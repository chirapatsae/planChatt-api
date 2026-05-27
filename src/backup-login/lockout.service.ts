import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * SECURITY-01 §7.3 lockout escalation ladder.
 *
 *   - 3 consecutive failures      → 30-min lock
 *   - 5 consecutive failures /24h → 24-hour lock
 *   - 10 failures /24h rolling    → indefinite FREEZE (super-admin
 *                                   unfreeze required)
 *
 * Counters live in Redis for fast read; `BackupCredential.lockedUntil`
 * + `frozenAt` are the durable DB backstop (Redis restart MUST NOT
 * reset the freeze).
 *
 * If Redis is unavailable, fall back to in-memory `Map`. Process
 * restart loses the in-memory state but the DB backstop preserves
 * lock / freeze state across restarts.
 */
export type EscalationLevel = 'none' | 'lock30m' | 'lock24h' | 'freeze';

export interface EscalationResult {
  level: EscalationLevel;
  consecutiveFailures: number;
  rolling24hFailures: number;
  /** When `level` is lock30m / lock24h, the absolute expiry time. */
  lockedUntil: Date | null;
}

const REDIS_PREFIX = 'backup-login:';

/**
 * In-memory fallback entry. Each user has a small ring buffer of
 * failure timestamps (epoch ms). Entries older than 24h are evicted
 * lazily on read.
 */
interface InMemoryEntry {
  failures: number[]; // epoch ms timestamps
}

@Injectable()
export class LockoutService {
  private readonly logger = new Logger(LockoutService.name);
  private redis: Redis | null = null;
  private readonly memory = new Map<string, InMemoryEntry>();

  constructor() {
    try {
      this.redis = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT) || 6379,
        maxRetriesPerRequest: 1,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        retryStrategy: (_times) => null, // do not retry — fall back to memory
        lazyConnect: true,
      });
      // Fire-and-forget connect; on failure the per-call try/catch
      // path triggers the in-memory fallback.
      this.redis.connect().catch((err) => {
        this.logger.warn(
          `[LockoutService] Redis connect failed (${err?.message ?? 'unknown'}); using in-memory fallback`,
        );
      });
    } catch (err) {
      this.logger.warn(
        `[LockoutService] Redis init failed (${(err as Error)?.message}); using in-memory fallback`,
      );
      this.redis = null;
    }
  }

  /**
   * Record one failure (credential OR TOTP — caller decides which
   * stage; the lockout counter is unified per SECURITY-01 §7.3.2).
   * Returns the escalation triggered, if any.
   */
  async recordFailure(userId: string): Promise<EscalationResult> {
    const now = Date.now();
    const ts = await this.appendFailure(userId, now);
    const consecutive = ts.length;
    const rolling = ts.filter((t) => now - t < 24 * 3600_000).length;

    let level: EscalationLevel = 'none';
    let lockedUntil: Date | null = null;

    if (rolling >= 10) {
      level = 'freeze';
    } else if (rolling >= 5) {
      level = 'lock24h';
      lockedUntil = new Date(now + 24 * 3600_000);
    } else if (consecutive >= 3) {
      level = 'lock30m';
      lockedUntil = new Date(now + 30 * 60_000);
    }

    return {
      level,
      consecutiveFailures: consecutive,
      rolling24hFailures: rolling,
      lockedUntil,
    };
  }

  /** Reset the failure counter for a user on successful login. */
  async recordSuccess(userId: string): Promise<void> {
    const key = this.userKey(userId);
    if (this.redis && this.redis.status === 'ready') {
      try {
        await this.redis.del(key);
        return;
      } catch (err) {
        this.logger.warn(
          `[LockoutService] redis recordSuccess failed: ${(err as Error).message}`,
        );
      }
    }
    this.memory.delete(userId);
  }

  /**
   * Append a failure timestamp; returns the list of timestamps within
   * the last 24h (older entries evicted).
   */
  private async appendFailure(
    userId: string,
    nowMs: number,
  ): Promise<number[]> {
    const cutoff = nowMs - 24 * 3600_000;

    if (this.redis && this.redis.status === 'ready') {
      try {
        const key = this.userKey(userId);
        await this.redis
          .multi()
          .zadd(key, nowMs.toString(), `${nowMs}-${Math.random()}`)
          .zremrangebyscore(key, '-inf', cutoff.toString())
          .expire(key, 24 * 3600)
          .exec();
        const scores = await this.redis.zrange(key, 0, -1, 'WITHSCORES');
        // scores is [member, score, member, score, ...]
        const ts: number[] = [];
        for (let i = 1; i < scores.length; i += 2) {
          ts.push(Number(scores[i]));
        }
        return ts.sort((a, b) => a - b);
      } catch (err) {
        this.logger.warn(
          `[LockoutService] redis appendFailure failed: ${(err as Error).message}; falling back to memory`,
        );
      }
    }

    let entry = this.memory.get(userId);
    if (!entry) {
      entry = { failures: [] };
      this.memory.set(userId, entry);
    }
    entry.failures.push(nowMs);
    entry.failures = entry.failures.filter((t) => t >= cutoff);
    return [...entry.failures];
  }

  private userKey(userId: string): string {
    return `${REDIS_PREFIX}user:${userId}:fails`;
  }
}
