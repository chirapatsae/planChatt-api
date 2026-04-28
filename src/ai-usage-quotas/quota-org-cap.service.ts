import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiUsageLog } from 'src/ai-usage-logs/entities/ai-usage-log.entity';

/**
 * Wave 44 / BE-W44-03 — org-wide monthly AI spend accumulator (task
 * §7.9).
 *
 * Project Bank is single-tenant today, so "org" ≡ entire system. The
 * service sums `ai_usage_logs.cost_bath` for the current calendar month
 * (by `used_at`, the log's creation column) and compares against
 * `AI_ORG_MONTHLY_CAP_THB` (default 50000 THB).
 *
 * A 60-second in-memory cache sits in front of the SUM query because
 * the query scans every row for the month and lives on the AI hot
 * path. The 60 s window is acceptable slack on a blunt 50 000 THB cap
 * — ops would notice a month-end overshoot of O(100 THB) long before
 * a real overspend.
 *
 * Per §17.3 audit separation, no FK is followed; this service reads
 * `ai_usage_logs` only. Per §17.11, there is no role exemption — even
 * a super-admin hits `AI_ORG_QUOTA_EXHAUSTED` once the cap is reached.
 */
@Injectable()
export class QuotaOrgCapService {
  private readonly logger = new Logger(QuotaOrgCapService.name);
  private readonly CACHE_TTL_MS = 60_000;

  private cache: { value: number; expiresAt: number } | null = null;

  constructor(
    @InjectRepository(AiUsageLog)
    private readonly aiUsageLogRepository: Repository<AiUsageLog>,
  ) {}

  /**
   * Returns the configured cap in THB. Reads `AI_ORG_MONTHLY_CAP_THB`
   * per call so ops can rotate without a restart. Falls back to 50000
   * on missing / invalid / non-positive env values.
   */
  getOrgCapThb(): number {
    const raw = process.env.AI_ORG_MONTHLY_CAP_THB;
    const parsed = raw !== undefined && raw !== '' ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 50_000;
  }

  /**
   * Sum of `cost_bath` for the current calendar month. Cached for 60 s.
   */
  async getOrgMonthlyConsumedThb(): Promise<number> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.value;
    }

    try {
      // `date_trunc('month', now())` on the server side keeps the
      // boundary consistent with DB time and avoids JS/TZ drift.
      // `used_at` is the log's create column (see entity).
      const row = await this.aiUsageLogRepository
        .createQueryBuilder('log')
        .select('COALESCE(SUM(log.costBaht), 0)', 'total')
        .where(`log.used_at >= date_trunc('month', now())`)
        .getRawOne<{ total: string | number }>();

      const total = Number(row?.total ?? 0);
      const value = Number.isFinite(total) && total >= 0 ? total : 0;
      this.cache = { value, expiresAt: now + this.CACHE_TTL_MS };
      return value;
    } catch (err) {
      this.logger.warn(
        `[quota-org-cap] getOrgMonthlyConsumedThb failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // Fail-open on read errors: returning 0 lets the AI call proceed
      // rather than bricking the entire system on a transient DB hiccup.
      // Per-user quota is still enforced by the primary guard.
      return 0;
    }
  }

  /**
   * Convenience wrapper for the guard: one-call check with the snapshot
   * of both sides of the comparison for error-body construction.
   */
  async checkOrgCap(): Promise<{
    withinCap: boolean;
    usedThb: number;
    capThb: number;
  }> {
    const capThb = this.getOrgCapThb();
    const usedThb = await this.getOrgMonthlyConsumedThb();
    return {
      withinCap: usedThb < capThb,
      usedThb,
      capThb,
    };
  }

  /** Test hook — discard the cache (also safe in prod). */
  invalidateCache(): void {
    this.cache = null;
  }
}
