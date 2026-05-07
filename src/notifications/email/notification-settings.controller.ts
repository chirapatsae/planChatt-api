import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Patch,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { Request } from 'express';

import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { Roles } from 'src/auth/roles.decorator';
import { RolesGuard } from 'src/auth/roles.guard';
import { EXEC_READ, SUPER_ADMIN_ONLY } from 'src/auth/role-groups';

import { NotificationSettingsService } from './notification-settings.service';
import { UpdateEmailSettingsDto } from './dto/update-email-settings.dto';

/**
 * Wave 22 B2 — Global email kill-switch admin surface.
 *
 * Mirrors the Wave 22 B1 `EmailStatsController` shape:
 *   - `super-admin` ONLY (stricter than Wave 21's staff-lead preference
 *     endpoints — kill-switch is a system-wide operational flag)
 *   - 1-second per-caller per-endpoint cooldown to keep dashboard polling
 *     loops from hammering the DB
 *   - Thai 403 copy on non-super-admin callers
 *
 * Source-of-truth guardrails (CLAUDE.md):
 *   - §4.1   — kill-switch OFF MUST NOT fail any workflow transition
 *   - §12    — audit writes land in `notification_settings_audit`,
 *              NEVER in `tracking_status`
 *   - §17.11 — no role (including super-admin) may coerce the flag to
 *              bypass workflow authority
 */

// W97 user-amendment: GET allows admin to view kill-switch state for the
// unified `/admin/notifications` dashboard. PATCH (flipping the switch)
// stays super-admin-only — admins VIEW but only super-admin disables.
//
// Wave 98 PR2: GET widens further to EXEC_READ (adds c-level) for the
// executive notifications-overview page. PATCH gate is unchanged.
const COOLDOWN_MS = 1_000;

@Controller({
  path: 'admin/email-settings',
  version: '1',
})
export class NotificationSettingsController {
  private readonly lastCall = new Map<string, number>();

  constructor(private readonly settingsService: NotificationSettingsService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...EXEC_READ)
  @Get()
  @HttpCode(HttpStatus.OK)
  async get(@Req() req: Request & { user: JwtPayloadUser }) {
    this.assertCooldown(req.user.userId, 'get');
    return this.settingsService.getSettings();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  @Patch()
  @HttpCode(HttpStatus.OK)
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async patch(
    @Req() req: Request & { user: JwtPayloadUser },
    @Body() body: UpdateEmailSettingsDto,
  ) {
    this.assertCooldown(req.user.userId, 'patch');
    return this.settingsService.updateSettings(
      { userId: req.user.userId },
      {
        emailEnabled: body.emailEnabled,
        lineEnabled: body.lineEnabled,
        reason: body.reason,
        expectedUpdatedAt: body.expectedUpdatedAt,
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Lightweight per-user per-endpoint cooldown. Mirrors
   * `EmailStatsController` exactly so admin-dashboard polling behaves
   * identically across both surfaces.
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
