import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../auth/auth.guard';
import { CitizenModerateGrantGuard } from './citizen-moderate-grant.guard';
import { CitizenModerationInsightsService } from './citizen-moderation-insights.service';

/**
 * W-T4 — staff moderation RISK DASHBOARD (proactive, author-level view over the
 * existing W-T3 / C5 moderation signals).
 *
 * STAFF surface — INTERNAL identity ONLY. The guard chain is IDENTICAL to the
 * W-T3 / C5 staff moderation queue (`CitizenModerationController`):
 *
 *   JwtAuthGuard → CitizenModerateGrantGuard
 *
 * The `moderate` GRANT — not a global role — is the authority (§4.1 staff via
 * grant, NOT ownership): a missing live grant returns 403
 * `CITIZEN_MODERATE_NOT_GRANTED`. A citizen token (aud:'citizen') is rejected by
 * `JwtAuthGuard`, so a citizen can never reach these reads.
 *
 * §18.13 ZERO-WRITE read aggregator: every route is a pure grouped/counted read
 * over `citizen_*`. §17.2 advisory — the numbers gate NOTHING and auto-action
 * NOTHING (every action still goes through the existing T3 per-item flow).
 * §17.3 isolation — citizen_* only, alias-only authors, NO citizen PII.
 */
@Controller({ path: 'citizen-engagement/moderation/insights', version: '1' })
@UseGuards(JwtAuthGuard, CitizenModerateGrantGuard)
export class CitizenModerationInsightsController {
  constructor(
    private readonly insights: CitizenModerationInsightsService,
  ) {}

  /** Current queue pressure: open reports / appeals + shadowed / removed / suspended. */
  @Get('overview')
  overview() {
    return this.insights.overview();
  }

  /** Authors ranked by distinct reporters over the window (alias-only). */
  @Get('top-reported-authors')
  topReportedAuthors(
    @Query('windowDays') windowDays?: string,
    @Query('limit') limit?: string,
  ) {
    return this.insights.topReportedAuthors(
      this.parseInt(windowDays),
      this.parseInt(limit),
    );
  }

  /** Authors ranked by removed / shadowed post counts over the window (alias-only). */
  @Get('top-actioned-authors')
  topActionedAuthors(
    @Query('windowDays') windowDays?: string,
    @Query('limit') limit?: string,
  ) {
    return this.insights.topActionedAuthors(
      this.parseInt(windowDays),
      this.parseInt(limit),
    );
  }

  /** Recent staff moderation actions, newest first (alias-only author). */
  @Get('recent-actions')
  recentActions(@Query('limit') limit?: string) {
    return this.insights.recentActions(this.parseInt(limit));
  }

  /**
   * Parse a raw query string to a number; returns `undefined` for missing /
   * non-numeric input so the service applies its default + clamp. The service is
   * the single clamp authority (mirrors `CitizenInsightsController`).
   */
  private parseInt(raw?: string): number | undefined {
    if (raw === undefined || raw === null || raw === '') {
      return undefined;
    }
    const n = Number(raw);
    return Number.isNaN(n) ? undefined : n;
  }
}
