import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { WorkStatusApprovedGuard } from '../../auth/work-status-approved.guard';
import { Roles } from '../../auth/roles.decorator';
import { EXEC_READ } from '../../auth/role-groups';

import { CitizenInsightsService } from './citizen-insights.service';

/**
 * W-G3 — Executive insights over the citizen-engagement layer.
 *
 * STAFF / EXECUTIVE surface — INTERNAL identity ONLY. The guard chain MIRRORS
 * the canonical executive read aggregator `UnifiedProjectsController`
 * (`unified-projects.controller.ts`) and `AiExecutiveChatController`
 * (`ai-executive-chat.controller.ts`, auth-roles-guard-unification BE-04 canon):
 *
 *   JwtAuthGuard → RolesGuard → WorkStatusApprovedGuard   (+ @Roles(...EXEC_READ))
 *
 * `EXEC_READ` = staff + admin + super-admin + c-level (`auth/role-groups.ts`).
 * This is NOT the citizen JWT guard — a citizen token (aud:'citizen') is
 * rejected by `JwtAuthGuard`, so a citizen can never reach these reads.
 *
 * §18.13 ZERO-WRITE read aggregator: every route is a pure grouped/counted read
 * over `citizen_*`. §17.2 advisory — the numbers gate NOTHING (no workflow
 * transition, no permission decision). §17.3 isolation — citizen_* only, no
 * project / users / tracking_status touch, alias-only + aggregate (NO citizen
 * PII). All routes clamp `?windowDays=` to [1, 365] (default 30) at the service
 * layer.
 */
@Controller({ path: 'citizen-engagement/insights', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
@Roles(...EXEC_READ)
export class CitizenInsightsController {
  constructor(private readonly insights: CitizenInsightsService) {}

  /** Headline totals + per-kind split + new-posts-by-day series. */
  @Get('overview')
  overview(@Query('windowDays') windowDays?: string) {
    return this.insights.overview(this.parseInt(windowDays));
  }

  /** Top idea categories (postCount + reactionCount) over the window. */
  @Get('top-categories')
  topCategories(@Query('windowDays') windowDays?: string) {
    return this.insights.topCategories(this.parseInt(windowDays));
  }

  /** Top hashtags (DISTINCT visible posts per tag) over the window. */
  @Get('top-hashtags')
  topHashtags(
    @Query('windowDays') windowDays?: string,
    @Query('limit') limit?: string,
  ) {
    return this.insights.topHashtags(
      this.parseInt(windowDays),
      this.parseInt(limit),
    );
  }

  /** Most-engaged visible posts (alias-only author) over the window. */
  @Get('top-posts')
  topPosts(
    @Query('windowDays') windowDays?: string,
    @Query('limit') limit?: string,
  ) {
    return this.insights.topPosts(
      this.parseInt(windowDays),
      this.parseInt(limit),
    );
  }

  /** Post count per amphoe (idea pins) over the window. */
  @Get('by-amphoe')
  byAmphoe(@Query('windowDays') windowDays?: string) {
    return this.insights.byAmphoe(this.parseInt(windowDays));
  }

  /**
   * Parse a raw query string to a number; returns `undefined` for missing /
   * non-numeric input so the service applies its default + clamp. The service
   * is the single clamp authority (mirrors `CitizenHashtagService`).
   */
  private parseInt(raw?: string): number | undefined {
    if (raw === undefined || raw === null || raw === '') {
      return undefined;
    }
    const n = Number(raw);
    return Number.isNaN(n) ? undefined : n;
  }
}
