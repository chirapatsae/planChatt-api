import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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

import { NotificationQuotaAlertsService } from './notification-quota-alerts.service';
import {
  CreateQuotaAlertDto,
  UpdateQuotaAlertDto,
} from './dto/quota-alert.dto';

/**
 * Wave 97 — Quota Alert CRUD admin surface.
 *
 * Auth model: super-admin only for CRUD writes (alert recipient is a real
 * mailbox, alert thresholds change paging behaviour). Reads are exec-read
 * (staff / admin / super-admin / c-level) per W98 PR2 widening.
 *
 * Source-of-truth guardrails:
 *   - §4.1   — alerts do not gate any workflow
 *   - §12    — no `tracking_status` writes
 *   - §17.11 — no role override on the super-admin gate
 *   - W83    — recipient_email is operator metadata; mask in any log
 *
 * BE-03 (auth-roles-guard-unification Phase 3): the prior inline
 * `assertSuperAdmin` / `assertExecRead` / `assertAdminOrAbove` helpers and
 * the local `SUPER_ADMIN_ROLES` / `ADMIN_OR_ABOVE_ROLES` constants are
 * replaced by the canonical `@Roles(...)` + `RolesGuard` pattern. The
 * pre-W98 `assertAdminOrAbove` helper was already dead code (no callsites)
 * and is removed in this migration. The `EXEC_READ_ROLES` import from
 * `./roles` is no longer referenced from this file but is still used by
 * `notification-quota.controller.ts` until BE-03 migrates that file too.
 */

const COOLDOWN_MS = 1_000;

@Controller({
  path: 'admin/notifications/alerts',
  version: '1',
})
export class NotificationAlertsController {
  private readonly lastCall = new Map<string, number>();

  constructor(private readonly alerts: NotificationQuotaAlertsService) {}

  /**
   * W98 amendment — LIST role gate widened from `admin-or-above` to
   * `EXEC_READ` (staff / admin / super-admin / c-level) so the
   * executive notifications-overview surface can render the same
   * alert rows the operations page sees, in read-only mode.
   *
   * The exposed fields (`thresholdPercent`, `recipientEmail`,
   * `lastFiredAt`, …) are **operator policy** — not user PII. The
   * recipient is an operator mailbox (e.g. `notifications@gov.th`),
   * not the project owner's email; thresholds are system tuning data.
   * Defense-in-depth: WRITE paths (POST / PATCH / DELETE) keep
   * `SUPER_ADMIN_ONLY`, so an exec viewer cannot mutate even if they
   * craft a request by hand. Frontend additionally passes
   * `readOnly: true` to `<QuotaAlertsPanel>` on the exec surface so
   * edit + trash icon buttons are absent from the DOM.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...EXEC_READ)
  @Get()
  @HttpCode(HttpStatus.OK)
  async list(@Req() req: Request & { user: JwtPayloadUser }) {
    this.assertCooldown(req.user.userId, 'list');
    return this.alerts.list();
  }

  /**
   * Wave 98 PR2 — per-channel armed + lastFiredAt summary for the new
   * executive notifications-overview page.
   *
   * Role gate: `EXEC_READ` (staff / admin / super-admin / c-level)
   * — strictly weaker than the alert LIST endpoint, which exposes
   * threshold values that c-level should not see. The summary returns
   * only counts + a fire-time timestamp; no PII, no operational tuning
   * data leaked.
   *
   * Cooldown: 1 s per `(userId, 'summary')` bucket. Mirrors the quota
   * controller's pattern; each role gets its own bucket since the key
   * includes `userId`.
   *
   * §4.1 — no workflow authority granted.
   * §12  — no `tracking_status` write.
   * §17.2 — advisory display data; not a workflow gate.
   * §17.3 — no FK to any project table; reads from
   *         `notification_quota_alerts` aggregate.
   * §17.11 — additive read access, not a write override.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...EXEC_READ)
  @Get('summary')
  @HttpCode(HttpStatus.OK)
  async summary(@Req() req: Request & { user: JwtPayloadUser }) {
    this.assertCooldown(req.user.userId, 'summary');
    return this.alerts.getSummaryByChannel();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async create(
    @Req() req: Request & { user: JwtPayloadUser },
    @Body() body: CreateQuotaAlertDto,
  ) {
    this.assertCooldown(req.user.userId, 'create');
    return this.alerts.create(req.user.userId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  @Patch(':id')
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
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateQuotaAlertDto,
  ) {
    this.assertCooldown(req.user.userId, 'patch');
    return this.alerts.update(id, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async remove(
    @Req() req: Request & { user: JwtPayloadUser },
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    this.assertCooldown(req.user.userId, 'remove');
    return this.alerts.remove(id);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

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
