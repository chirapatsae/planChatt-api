import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';

import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';

import { EmailStatsService } from '../email/email-stats.service';
import { LineStatsService } from '../line/line-stats.service';
import { QuotaQueryDto } from './dto/quota-query.dto';

/**
 * Wave 97 — Combined email + LINE quota endpoint.
 *
 * Source-of-truth guardrails (CLAUDE.md):
 *   - §4.1   — read-only advisory; no workflow gating
 *   - §12    — no `tracking_status` writes
 *   - §17.2  — staff retains final decision authority; this is display data
 *   - §17.3  — aggregation only; no FK touch
 *
 * Auth model: staff-lead (staff / admin / super-admin) read access. The
 * data exposed is aggregate counts only — no `lineUserId`, no email
 * address, no PII. Per-channel `byEvent` cardinality is capped at 50 by
 * the underlying service.
 *
 * In-memory cache: 30s TTL keyed by `{from, to, channel}`. Mirrors the
 * Wave 22 / Wave 21 admin-controller cooldown footprint (Map-based, no
 * Redis dependency — see W97-API-QUOTA §7).
 */

const STAFF_LEAD_ROLES = new Set(['staff', 'admin', 'super-admin']);
const COOLDOWN_MS = 1_000;
const CACHE_TTL_MS = 30_000;
const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

const WARN_THRESHOLD = 80;
const CRITICAL_THRESHOLD = 95;

interface ChannelEnvelope {
  windowStart: string;
  windowEnd: string;
  provider: string;
  quotaTotal: number;
  sentCount: number;
  remaining: number;
  percentUsed: number;
  threshold: { warn: number; critical: number };
  bandStatus: 'ok' | 'warn' | 'critical';
  byStatus: Record<string, number>;
  byEvent: Array<{
    eventType: string;
    sent: number;
    failed: number;
    skipped: number;
  }>;
}

interface QuotaResponse {
  email?: ChannelEnvelope;
  line?: ChannelEnvelope;
  fetchedAt: string;
}

@Controller({
  path: 'admin/notifications',
  version: '1',
})
export class NotificationQuotaController {
  private readonly lastCall = new Map<string, number>();
  private readonly cache = new Map<
    string,
    { value: QuotaResponse; expiresAt: number }
  >();

  constructor(
    private readonly emailStats: EmailStatsService,
    private readonly lineStats: LineStatsService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get('quota')
  @HttpCode(HttpStatus.OK)
  async quota(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query() query: QuotaQueryDto,
  ): Promise<QuotaResponse> {
    this.assertStaffLead(req.user);
    this.assertCooldown(req.user.userId, 'quota');

    const channel = query.channel ?? 'both';

    // Validate range: 90-day cap (only when both endpoints are present).
    if (query.from && query.to) {
      const span = new Date(query.to).getTime() - new Date(query.from).getTime();
      if (Number.isNaN(span) || span < 0) {
        throw new BadRequestException('from / to ไม่ถูกต้อง');
      }
      if (span > MAX_RANGE_MS) {
        throw new BadRequestException(
          'ช่วงเวลาที่ขอเกิน 90 วัน — กรุณาลดช่วงให้สั้นลง',
        );
      }
    }

    // Resolve windows (UTC-based defaults per §7).
    const now = new Date();
    const emailWindow = this.resolveEmailWindow(query.from, query.to, now);
    const lineWindow = this.resolveLineWindow(query.from, query.to, now);

    // Cache key — channel + both windows (channel scoping prevents
    // a 'both' caller polluting a single-channel cache slot).
    const cacheKey = JSON.stringify({
      channel,
      ef: emailWindow.from.toISOString(),
      et: emailWindow.to.toISOString(),
      lf: lineWindow.from.toISOString(),
      lt: lineWindow.to.toISOString(),
    });

    const hit = this.cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      return hit.value;
    }

    const emailQuota = Number(process.env.EMAIL_DAILY_QUOTA ?? 500) || 500;
    const lineQuota = Number(process.env.LINE_MONTHLY_QUOTA ?? 1000) || 1000;

    const response: QuotaResponse = { fetchedAt: now.toISOString() };

    if (channel === 'email' || channel === 'both') {
      const agg = await this.emailStats.getQuotaWindow(
        emailWindow.from,
        emailWindow.to,
      );
      response.email = this.buildEnvelope({
        windowStart: emailWindow.from,
        windowEnd: emailWindow.to,
        provider: 'gmail',
        quotaTotal: emailQuota,
        sentCount: agg.byStatus['sent'] ?? 0,
        byStatus: agg.byStatus,
        byEvent: agg.byEvent,
      });
    }

    if (channel === 'line' || channel === 'both') {
      const agg = await this.lineStats.getQuotaWindow(
        lineWindow.from,
        lineWindow.to,
      );
      response.line = this.buildEnvelope({
        windowStart: lineWindow.from,
        windowEnd: lineWindow.to,
        provider: 'line',
        quotaTotal: lineQuota,
        sentCount: agg.byStatus['sent'] ?? 0,
        byStatus: agg.byStatus,
        byEvent: agg.byEvent,
      });
    }

    this.cache.set(cacheKey, {
      value: response,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    this.evictExpired();

    return response;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private buildEnvelope(args: {
    windowStart: Date;
    windowEnd: Date;
    provider: string;
    quotaTotal: number;
    sentCount: number;
    byStatus: Record<string, number>;
    byEvent: Array<{
      eventType: string;
      sent: number;
      failed: number;
      skipped: number;
    }>;
  }): ChannelEnvelope {
    const { quotaTotal, sentCount } = args;
    const remaining = Math.max(0, quotaTotal - sentCount);
    const rawPct = quotaTotal > 0 ? (sentCount / quotaTotal) * 100 : 0;
    const percentUsed = Math.min(100, Math.max(0, Math.round(rawPct * 100) / 100));

    let bandStatus: 'ok' | 'warn' | 'critical';
    if (percentUsed >= CRITICAL_THRESHOLD) bandStatus = 'critical';
    else if (percentUsed >= WARN_THRESHOLD) bandStatus = 'warn';
    else bandStatus = 'ok';

    return {
      windowStart: args.windowStart.toISOString(),
      windowEnd: args.windowEnd.toISOString(),
      provider: args.provider,
      quotaTotal,
      sentCount,
      remaining,
      percentUsed,
      threshold: { warn: WARN_THRESHOLD, critical: CRITICAL_THRESHOLD },
      bandStatus,
      byStatus: args.byStatus,
      byEvent: args.byEvent,
    };
  }

  /**
   * Email default window = today UTC (00:00 → now). Honours explicit
   * `from`/`to` when both supplied.
   */
  private resolveEmailWindow(
    from: string | undefined,
    to: string | undefined,
    now: Date,
  ): { from: Date; to: Date } {
    if (from && to) {
      return { from: new Date(from), to: new Date(to) };
    }
    const startOfDay = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        0,
        0,
        0,
        0,
      ),
    );
    return { from: startOfDay, to: now };
  }

  /**
   * LINE default window = current calendar month UTC (1st 00:00 → now).
   */
  private resolveLineWindow(
    from: string | undefined,
    to: string | undefined,
    now: Date,
  ): { from: Date; to: Date } {
    if (from && to) {
      return { from: new Date(from), to: new Date(to) };
    }
    const startOfMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
    );
    return { from: startOfMonth, to: now };
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.cache) {
      if (v.expiresAt <= now) this.cache.delete(k);
    }
  }

  // ---------------------------------------------------------------------------
  // Guards
  // ---------------------------------------------------------------------------

  private assertStaffLead(user: JwtPayloadUser): void {
    if (!user || !STAFF_LEAD_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'เฉพาะ staff / admin / super-admin เท่านั้นที่สามารถดูข้อมูลโควต้าได้',
      );
    }
  }

  private assertCooldown(userId: string, endpoint: string): void {
    const key = `${userId}:${endpoint}`;
    const last = this.lastCall.get(key) ?? 0;
    const now = Date.now();
    if (now - last < COOLDOWN_MS) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'เรียกถี่เกินไป กรุณาลองใหม่อีกครั้ง',
          retryAfterMs: COOLDOWN_MS - (now - last),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.lastCall.set(key, now);
  }
}
