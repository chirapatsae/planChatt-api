import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { refreshLiveFx } from './fx-config';

/**
 * FxRefreshService — P3 (2026-05-17) periodic FX refresh.
 *
 * Behavior:
 *   - On app boot: fire one async refresh (non-blocking) so the first
 *     AI call after boot already has live rate cached.
 *   - Scheduled cron: every day at 02:00 (server local time) refresh
 *     the rate. Predictable schedule independent of boot time.
 *   - Gated by env `OPENAI_FX_USE_LIVE === 'true'`. When unset/false,
 *     this service is a no-op — `getUsdToThbFx()` returns the env or
 *     static fallback per its existing precedence chain.
 *
 * Failure handling:
 *   - `refreshLiveFx()` returns `null` on any failure; the cache stays
 *     stale (within TTL) OR empty (forcing env/static fallback). Either
 *     way, AI cost path NEVER blocks on FX I/O.
 *   - §17.2 advisory — FX miss never gates a workflow transition.
 *
 * Uses `@nestjs/schedule` (already wired via `ScheduleModule.forRoot()`
 * in app.module.ts) so the schedule survives across app restarts in a
 * predictable manner.
 */
@Injectable()
export class FxRefreshService implements OnApplicationBootstrap {
  private readonly logger = new Logger(FxRefreshService.name);

  /** Run once on boot so the cache is warm before the first AI call. */
  async onApplicationBootstrap(): Promise<void> {
    if (process.env.OPENAI_FX_USE_LIVE !== 'true') {
      this.logger.log(
        'Live FX disabled (OPENAI_FX_USE_LIVE !== true). Using env/static fallback.',
      );
      return;
    }
    // Fire-and-forget initial fetch; do not block app boot.
    void this.refresh('boot');
  }

  /**
   * Daily refresh at 02:00 server-local time. Picked at low-traffic
   * hour to minimize any (negligible) impact of the external HTTP call.
   * Schedule fires regardless of OPENAI_FX_USE_LIVE; the guard lives
   * inside `refresh()` so flipping the env at runtime takes effect on
   * the next tick without redeploy.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async scheduledRefresh(): Promise<void> {
    if (process.env.OPENAI_FX_USE_LIVE !== 'true') return;
    await this.refresh('cron');
  }

  private async refresh(trigger: 'boot' | 'cron'): Promise<void> {
    const rate = await refreshLiveFx();
    if (rate !== null) {
      this.logger.log(
        `Live USD→THB FX refreshed (${trigger}): ${rate.toFixed(4)} ฿/$`,
      );
    } else {
      this.logger.warn(
        `Live USD→THB FX refresh failed (${trigger}); falling back to env/static value.`,
      );
    }
  }
}
