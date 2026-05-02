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
// authority" surface per the original Q5 decision; admin can VIEW the list
// to see which thresholds are configured but cannot mutate them.
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

  @UseGuards(JwtAuthGuard)
  @Get()
  @HttpCode(HttpStatus.OK)
  async list(@Req() req: Request & { user: JwtPayloadUser }) {
    this.assertAdminOrAbove(req.user);
    this.assertCooldown(req.user.userId, 'list');
    return this.alerts.list();
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
