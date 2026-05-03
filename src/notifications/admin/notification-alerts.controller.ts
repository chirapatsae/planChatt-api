import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
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

import { NotificationQuotaAlertsService } from './notification-quota-alerts.service';
import {
  CreateQuotaAlertDto,
  UpdateQuotaAlertDto,
} from './dto/quota-alert.dto';
// Wave 98 PR2 — exec-read role set for the new `summary` endpoint. The
// LIST + CRUD paths keep their pre-W98 gates (admin-or-above for read,
// super-admin for write).
import { EXEC_READ_ROLES } from './roles';

/**
 * Wave 97 — Quota Alert CRUD admin surface.
 *
 * Auth model: super-admin only. CRUD writes are operationally
 * sensitive (alert recipient is a real mailbox, alert thresholds
 * change paging behaviour). Stricter than the read-only quota
 * endpoint which is staff-lead.
 *
 * Source-of-truth guardrails:
 *   - §4.1   — alerts do not gate any workflow
 *   - §12    — no `tracking_status` writes
 *   - §17.11 — no role override on the super-admin gate
 *   - W83    — recipient_email is operator metadata; mask in any log
 */

// W97 user-amendment: `admin` role gets READ access to the dashboard. Writes
// (alert CRUD) stay super-admin only — alerts management is a "central
// authority" surface per the original Q5 decision.
// W98 amendment: LIST role gate widened from `admin-or-above` to
// `EXEC_READ_ROLES` (see controller `list` JSDoc). The pre-W98
// `ADMIN_OR_ABOVE_ROLES` constant + `assertAdminOrAbove` helper are kept
// as **dead code** for one wave to make the diff easy to revert if the
// widening causes operator pushback. Schedule removal in W99.
const SUPER_ADMIN_ROLES = new Set(['super-admin']);
const ADMIN_OR_ABOVE_ROLES = new Set(['admin', 'super-admin']);
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
   * `EXEC_READ_ROLES` (staff / admin / super-admin / c-level) so the
   * executive notifications-overview surface can render the same
   * alert rows the operations page sees, in read-only mode.
   *
   * The exposed fields (`thresholdPercent`, `recipientEmail`,
   * `lastFiredAt`, …) are **operator policy** — not user PII. The
   * recipient is an operator mailbox (e.g. `notifications@gov.th`),
   * not the project owner's email; thresholds are system tuning data.
   * Defense-in-depth: WRITE paths (POST / PATCH / DELETE) keep
   * `assertSuperAdmin`, so an exec viewer cannot mutate even if they
   * craft a request by hand. Frontend additionally passes
   * `readOnly: true` to `<QuotaAlertsPanel>` on the exec surface so
   * edit + trash icon buttons are absent from the DOM.
   */
  @UseGuards(JwtAuthGuard)
  @Get()
  @HttpCode(HttpStatus.OK)
  async list(@Req() req: Request & { user: JwtPayloadUser }) {
    this.assertExecRead(req.user);
    this.assertCooldown(req.user.userId, 'list');
    return this.alerts.list();
  }

  /**
   * Wave 98 PR2 — per-channel armed + lastFiredAt summary for the new
   * executive notifications-overview page.
   *
   * Role gate: `EXEC_READ_ROLES` (staff / admin / super-admin / c-level)
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
  @UseGuards(JwtAuthGuard)
  @Get('summary')
  @HttpCode(HttpStatus.OK)
  async summary(@Req() req: Request & { user: JwtPayloadUser }) {
    this.assertExecRead(req.user);
    this.assertCooldown(req.user.userId, 'summary');
    return this.alerts.getSummaryByChannel();
  }

  @UseGuards(JwtAuthGuard)
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
    this.assertSuperAdmin(req.user);
    this.assertCooldown(req.user.userId, 'create');
    return this.alerts.create(req.user.userId, body);
  }

  @UseGuards(JwtAuthGuard)
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
    this.assertSuperAdmin(req.user);
    this.assertCooldown(req.user.userId, 'patch');
    return this.alerts.update(id, body);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async remove(
    @Req() req: Request & { user: JwtPayloadUser },
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    this.assertSuperAdmin(req.user);
    this.assertCooldown(req.user.userId, 'remove');
    return this.alerts.remove(id);
  }

  // ---------------------------------------------------------------------------
  // Guards
  // ---------------------------------------------------------------------------

  private assertSuperAdmin(user: JwtPayloadUser): void {
    if (!user || !SUPER_ADMIN_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'เฉพาะ super-admin เท่านั้นที่สามารถจัดการการแจ้งเตือนโควต้าได้',
      );
    }
  }

  // W97 user-amendment: read-only access for admin + super-admin.
  private assertAdminOrAbove(user: JwtPayloadUser): void {
    if (!user || !ADMIN_OR_ABOVE_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'การเข้าถึงนี้สงวนสำหรับ admin หรือ super-admin',
      );
    }
  }

  // Wave 98 PR2: exec-read access for the `/summary` endpoint.
  // W98 amendment: also reused by the LIST endpoint so the executive
  // overview can render alert rows in read-only mode (per user direction
  // post-PR2). Threshold + recipient values are operator policy data,
  // not user PII; widening is safe. CRUD writes still gate on
  // `assertSuperAdmin` — defense-in-depth.
  private assertExecRead(user: JwtPayloadUser): void {
    if (!user || !EXEC_READ_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'การเข้าถึงนี้สงวนสำหรับ staff / admin / super-admin / c-level',
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
