/**
 * Public Engagement Controller.
 *
 * Anonymous POST surface for project likes + project / book views.
 * Mounted at `/v1/public/engagement/*`. Intentionally NOT decorated
 * with `@UseGuards(JwtAuthGuard)` — the public archive surface is
 * citizen-facing.
 *
 * Defenses applied here:
 *   - `EngagementRateLimitGuard` — 30 POSTs / min / IP, in memory only.
 *   - Bot User-Agent filter for views — returns 204 without recording.
 *   - DTO validation (class-validator) — UUID shape + closed enum.
 *   - Service-layer eligibility — returns 404 for unpublished targets.
 *
 * PDPA: IP and User-Agent are read for guard / bot-check ONLY and are
 * NEVER stored.
 *
 * CLAUDE.md §17.2 — engagement counters are advisory; this controller
 * does not gate any workflow transition.
 */

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';

import { RecordViewDto } from './dto/record-view.dto';
import { ToggleLikeDto } from './dto/toggle-like.dto';
import { EngagementRateLimitGuard } from './guards/engagement-rate-limit.guard';
import { PublicEngagementService } from './public-engagement.service';

@Controller({ path: 'public/engagement', version: '1' })
@UseGuards(EngagementRateLimitGuard)
export class PublicEngagementController {
  constructor(
    private readonly engagementService: PublicEngagementService,
  ) {}

  /**
   * POST /v1/public/engagement/like
   *
   * Toggle a like for (targetKind, targetId, deviceId). Idempotent —
   * the DB unique constraint serialises concurrent toggles. Returns
   * the post-state.
   */
  @Post('like')
  @HttpCode(HttpStatus.OK)
  async toggleLike(
    @Body() dto: ToggleLikeDto,
  ): Promise<{ liked: boolean; likeCount: number }> {
    return this.engagementService.toggleLike(dto);
  }

  /**
   * POST /v1/public/engagement/view
   *
   * Debounced view-increment. Bot User-Agent is filtered before
   * touching the DB and yields 204. Same-day repeat from the same
   * device yields `{ debounced: true }` and does NOT increment the
   * counter.
   */
  @Post('view')
  async recordView(
    @Body() dto: RecordViewDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // UA read for bot-check ONLY — never stored.
    const rawUa = req.headers['user-agent'];
    const ua = Array.isArray(rawUa) ? rawUa[0] : rawUa;
    if (this.engagementService.isBotUserAgent(ua)) {
      // 204 No Content — silent no-op so a polite crawler doesn't
      // retry. Per task §7.8.
      res.status(HttpStatus.NO_CONTENT).end();
      return;
    }
    const result = await this.engagementService.recordView(dto);
    res.status(HttpStatus.OK).json(result);
  }
}
