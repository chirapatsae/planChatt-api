/**
 * SystemUsageModule — W107.
 *
 * Wave-by-wave extension:
 *   - DB-PR1 — registered the entities:
 *       * SystemUsageDailyRollup  (W107-DB-PR1 §8.1)
 *       * StatsAccessLog          (W107-DB-PR1 §8.2)
 *   - BE-PR1 — added `RollupCronService` (nightly cron + backfill entry).
 *   - BE-PR2 (this wave) — adds the read-side REST surface:
 *       * SystemUsageController          (`/v1/system-usage/*`)
 *       * SystemUsageQueryService        (rollup-backed + on-the-fly reads)
 *       * StatsAccessLogService          (PDPA access trail writer)
 *       * AccessLogInterceptor           (fire-and-forget per-request log)
 *
 * Controller binds JwtAuthGuard + role gate inline (mirrors the W98 admin
 * notifications pattern). All endpoints are read-only; the only write
 * path is the access-log insert, which targets `stats_access_log` ONLY.
 *
 * §4.1 / §17.2 — module imports NO workflow services. Stats are advisory.
 * §17.3 — neither entity declares a FK; controller never writes to
 *         tracking_status or notification logs.
 * §17.11 — no role override; super-admin / admin / c-level all pass
 *         through the same auth + access-log path.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SystemUsageDailyRollup } from './entities/system-usage-daily-rollup.entity';
import { StatsAccessLog } from './entities/stats-access-log.entity';
import { RollupCronService } from './rollup-cron.service';

import { SystemUsageController } from './system-usage.controller';
import { SystemUsageQueryService } from './services/system-usage-query.service';
import { StatsAccessLogService } from './services/stats-access-log.service';
import { AccessLogInterceptor } from './interceptors/access-log.interceptor';

@Module({
  imports: [
    TypeOrmModule.forFeature([SystemUsageDailyRollup, StatsAccessLog]),
  ],
  controllers: [SystemUsageController],
  providers: [
    // W107-BE-PR1 — nightly cron + onModuleInit index ensure. The cron
    // runs at 02:00 ICT and rolls up the previous ICT day. Exported so
    // the backfill CLI can resolve the same provider via Nest's app
    // context and call rollupForDate(...) directly.
    RollupCronService,
    // W107-BE-PR2 — read-side stack.
    SystemUsageQueryService,
    StatsAccessLogService,
    AccessLogInterceptor,
  ],
  exports: [TypeOrmModule, RollupCronService, StatsAccessLogService],
})
export class SystemUsageModule {}
