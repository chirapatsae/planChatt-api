import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  Req,
  UseGuards,
  HttpException,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';

import { EmailStatsService } from './email-stats.service';
import {
  EmailStatsByDayQueryDto,
  EmailStatsLimitRangeQueryDto,
  EmailStatsOverviewQueryDto,
} from './dto/email-stats-query.dto';

/**
 * Wave 22 B1 — Super-admin email-stats dashboard endpoints.
 *
 * All 5 endpoints are READ-ONLY and require `role === 'super-admin'`.
 * Stricter than Wave 21's staff-lead gate on preference endpoints —
 * stats expose aggregate actor/recipient data and must be restricted.
 *
 * Wave 22 QA C-1 — all range endpoints accept ISO 8601 `from` / `to`
 * (plus `bucket` on by-day and `limit` on list-style endpoints). The
 * global `forbidNonWhitelisted: true` pipe rejects any undeclared
 * param, so DTOs are the contract.
 *
 * Cooldown: 1-second minimum spacing per caller per endpoint to prevent
 * accidental DB hammering from dashboard polling loops. Mirrors the
 * admin-document-analysis controller cooldown pattern.
 *
 * Source-of-truth guardrails (CLAUDE.md):
 *   - §4.1  — no workflow gating from this surface
 *   - §12   — no tracking_status writes
 *   - §14   — no FK from advisory rows to project tables
 *   - §17.2 — advisory tooling; caller always retains final authority
 *   - §17.11 — no role can coerce a bypass; super-admin gate is explicit
 */

const SUPER_ADMIN_ROLES = new Set(['super-admin']);
const COOLDOWN_MS = 1_000;

@Controller({
  path: 'admin/email-stats',
  version: '1',
})
export class EmailStatsController {
  private readonly lastCall = new Map<string, number>();

  constructor(private readonly statsService: EmailStatsService) {}

  @UseGuards(JwtAuthGuard)
  @Get('overview')
  @HttpCode(HttpStatus.OK)
  async overview(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query() query: EmailStatsOverviewQueryDto,
  ) {
    this.assertSuperAdmin(req.user);
    this.assertCooldown(req.user.userId, 'overview');
    return this.statsService.getOverview(query.from, query.to);
  }

  @UseGuards(JwtAuthGuard)
  @Get('by-day')
  @HttpCode(HttpStatus.OK)
  async byDay(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query() query: EmailStatsByDayQueryDto,
  ) {
    this.assertSuperAdmin(req.user);
    this.assertCooldown(req.user.userId, 'by-day');
    const bucket = query.bucket ?? 'day';
    return this.statsService.getByDay(query.from, query.to, bucket);
  }

  @UseGuards(JwtAuthGuard)
  @Get('top-senders')
  @HttpCode(HttpStatus.OK)
  async topSenders(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query() query: EmailStatsLimitRangeQueryDto,
  ) {
    this.assertSuperAdmin(req.user);
    this.assertCooldown(req.user.userId, 'top-senders');
    const limit = typeof query.limit === 'number' ? query.limit : 20;
    return this.statsService.getTopSenders(limit, query.from, query.to);
  }

  @UseGuards(JwtAuthGuard)
  @Get('top-recipients')
  @HttpCode(HttpStatus.OK)
  async topRecipients(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query() query: EmailStatsLimitRangeQueryDto,
  ) {
    this.assertSuperAdmin(req.user);
    this.assertCooldown(req.user.userId, 'top-recipients');
    const limit = typeof query.limit === 'number' ? query.limit : 20;
    return this.statsService.getTopRecipients(limit, query.from, query.to);
  }

  @UseGuards(JwtAuthGuard)
  @Get('failures')
  @HttpCode(HttpStatus.OK)
  async failures(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query() query: EmailStatsLimitRangeQueryDto,
  ) {
    this.assertSuperAdmin(req.user);
    this.assertCooldown(req.user.userId, 'failures');
    const limit = typeof query.limit === 'number' ? query.limit : 50;
    return this.statsService.getFailures(limit, query.from, query.to);
  }

  // ---------------------------------------------------------------------------
  // Guards
  // ---------------------------------------------------------------------------

  private assertSuperAdmin(user: JwtPayloadUser): void {
    if (!user || !SUPER_ADMIN_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'เฉพาะ super-admin เท่านั้นที่สามารถเข้าถึงสถิติอีเมลได้',
      );
    }
  }

  /**
   * Lightweight per-user per-endpoint cooldown. NOT a replacement for a
   * proper rate-limiter — good enough to prevent dashboard polling loops
   * from hammering the DB. Distinct key per endpoint so a burst on one
   * endpoint does not starve the others.
   */
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
