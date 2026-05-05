/**
 * W106-BE-PR1 — thin ioredis wrapper for the presence subsystem.
 *
 * Why a dedicated client (and not Bull's connection)?
 *  - Bull manages its own connection pool for queue blocking commands; reusing
 *    that connection for ad-hoc MGET/SET would interleave with BLPOP/BRPOP
 *    and degrade queue latency. The Wave 106 plan (§ "Critical context")
 *    explicitly calls this out: "create a separate ioredis client for
 *    presence — don't share Bull's connection pool".
 *  - Bull also doesn't expose its connection in a stable way across versions.
 *
 * Connection config mirrors Bull's (host/port from env, fallback to
 * `localhost:6379` to match `app.module.ts` BullModule.forRoot defaults).
 *
 * Health: every command is wrapped by callers in try/catch and falls back
 * to graceful-degrade mode (see `PresenceService`). This module deliberately
 * does NOT throw on connect errors — it logs and exposes a `healthy` flag.
 *
 * §17.3 / §12 — this client never writes to tracking_status, audit tables,
 * or any project-owning table. Redis is purely ephemeral presence state.
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import IORedis, { Redis as RedisClient } from 'ioredis';

@Injectable()
export class PresenceRedis implements OnModuleDestroy {
  private readonly logger = new Logger(PresenceRedis.name);
  private client: RedisClient | null = null;
  /**
   * `false` until first successful connect, then tracks runtime health.
   * `PresenceService` reads this flag to decide degrade vs proceed.
   */
  private _healthy = false;

  constructor() {
    const host = process.env.REDIS_HOST || 'localhost';
    const port = Number(process.env.REDIS_PORT) || 6379;
    const password = process.env.REDIS_PASSWORD || undefined;

    try {
      this.client = new IORedis({
        host,
        port,
        password,
        // Lazy connect so a Redis outage at boot doesn't crash the app —
        // graceful degrade is the contract per W106 plan §11 R-redis-down.
        lazyConnect: false,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => Math.min(1000 * Math.pow(2, times), 30000),
      });

      this.client.on('connect', () => {
        this._healthy = true;
        this.logger.log(`[presence] Redis connected at ${host}:${port}`);
      });
      this.client.on('error', (err) => {
        // Avoid log-flood: only flip flag, single-line message.
        this._healthy = false;
        this.logger.warn(`[presence] Redis error: ${err.message}`);
      });
      this.client.on('end', () => {
        this._healthy = false;
        this.logger.warn('[presence] Redis connection closed');
      });
    } catch (e: any) {
      this.logger.error(
        `[presence] Failed to construct Redis client: ${e?.message ?? e}`,
      );
      this.client = null;
      this._healthy = false;
    }
  }

  isHealthy(): boolean {
    return this._healthy && !!this.client;
  }

  raw(): RedisClient | null {
    return this.client;
  }

  async onModuleDestroy() {
    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        // ignore — shutdown best-effort
      }
    }
  }
}
