import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Post,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { Request } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { Roles } from 'src/auth/roles.decorator';
import { RolesGuard } from 'src/auth/roles.guard';
import { SUPER_ADMIN_ONLY } from 'src/auth/role-groups';
import { LineUserBindingService } from 'src/line/line-user-binding.service';
import { User } from 'src/users/entities/user.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { EmailService } from 'src/util/email/email.service';
import { decryption, isLikelyCiphertext } from 'src/util/encryption.util';
import { maskEmail } from 'src/notifications/email/utils/mask-email.util';

import { ForceUnlinkLineBindingDto } from './dto/force-unlink-line-binding.dto';

/**
 * W97 — Super-admin LINE bindings admin controller.
 *
 * Source of truth:
 *   - docs/tasks/wave97/W97-API-FORCE-UNLINK.md (this file's force-unlink path)
 *   - docs/tasks/wave97/W97-API-BINDINGS.md (sibling list / reveal endpoints
 *     added by the parallel W97-API-BINDINGS node)
 *
 * Pattern (auth-roles-guard-unification BE-03b — W22 baseline updated):
 *   - Role gate: canonical `@UseGuards(JwtAuthGuard, RolesGuard)` +
 *     `@Roles(...SUPER_ADMIN_ONLY)` per the auth-roles-guard-unification
 *     migration. Inline `assertSuperAdmin()` and the local
 *     `SUPER_ADMIN_ROLES` set were removed; `RolesGuard` reads the JWT
 *     `role` claim and throws `ForbiddenException('FORBIDDEN_ROLE')`.
 *   - Inline `Map<string,number>` cooldown / rate limit — there is no
 *     shared throttling decorator. Force-unlink uses a 1-hour window
 *     with a 5-call burst (W97-API-FORCE-UNLINK §9). This is rate-limit
 *     logic, NOT a role gate, and intentionally remains inline.
 *
 * Source-of-truth guardrails (CLAUDE.md):
 *   - §4.1   — force-unlink is governance, not workflow authority.
 *              Project status / responsibleAgency / createdBy untouched.
 *   - §12    — force-unlink MUST NOT write `tracking_status`.
 *   - §17.3  — audit row goes to `line_binding_admin_actions`, no FK
 *              into project tables.
 *   - §17.11 — super-admin authority does not bypass the audit write
 *              (handled by the service transaction).
 *   - W83    — never log raw `lineUserId` / raw email; binding id +
 *              `maskEmail(...)` are the safe logging surfaces.
 *   - W86    — terminating consent is itself an auditable PDPA event.
 */

/**
 * W97-API-FORCE-UNLINK §9 — 5 force-unlinks per actor per hour.
 *
 * Implemented as a per-actor rolling-window queue of timestamps. NOT a
 * replacement for a real rate limiter — adequate for in-process defense
 * against mass-disruption (the action requires a confirmation modal in
 * the FE-DASHBOARD anyway).
 */
const FORCE_UNLINK_WINDOW_MS = 60 * 60 * 1_000;
const FORCE_UNLINK_MAX_PER_WINDOW = 5;

@Controller({
  path: 'admin/notifications/line-bindings',
  version: '1',
})
export class LineBindingsAdminController {
  private readonly logger = new Logger(LineBindingsAdminController.name);

  /** Per-actor sliding-window of force-unlink timestamps (epoch ms). */
  private readonly forceUnlinkWindow = new Map<string, number[]>();

  constructor(
    private readonly bindingService: LineUserBindingService,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,
    private readonly emailService: EmailService,
  ) {}

  /**
   * POST /v1/admin/notifications/line-bindings/:id/force-unlink
   *
   * Q6 / Q12.5 — central-authority termination of a LINE binding on
   * behalf of a user who can no longer self-unlink (left org, abuse,
   * cross-binding deadlock).
   *
   * Contract:
   *   - 200 — `{ ok, bindingId, userNotified, auditId }`
   *   - 400 — DTO failed (missing/oversize reason, unknown category)
   *   - 403 — caller is not super-admin
   *   - 404 — binding id does not exist
   *   - 409 — `BINDING_ALREADY_UNLINKED` or
   *           `SELF_UNLINK_REQUIRES_ACKNOWLEDGEMENT`
   *   - 429 — rate-limit window exhausted (5/hour per actor)
   *
   * The user-notification email is best-effort: a recipient with no
   * verified email (or `allowEmailNotification === false`, or the
   * MAIL kill-switch in `EmailService`) skips the send and surfaces
   * `userNotified: false` — the unlink itself still succeeds.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  @Post(':id/force-unlink')
  @HttpCode(HttpStatus.OK)
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async forceUnlink(
    @Req() req: Request & { user: JwtPayloadUser },
    @Param('id') id: string,
    @Body() body: ForceUnlinkLineBindingDto,
  ): Promise<{
    ok: true;
    bindingId: string;
    userNotified: boolean;
    auditId: string;
  }> {
    this.assertForceUnlinkRateLimit(req.user.userId);

    // Resolve actor's current WorkHistory (CLAUDE.md §4 — we record
    // org context at action time on the audit row). Best-effort: a
    // missing current WH is acceptable; the audit row carries the
    // userId regardless.
    const actorWorkHistory = await this.workHistoryRepo
      .findOne({
        where: {
          user: { id: req.user.userId },
          isCurrent: true,
          deletedAt: IsNull(),
        },
        select: ['id'],
      })
      .catch(() => null);

    const requestIp = this.extractIp(req);
    const requestUserAgent = (req.headers['user-agent'] as string) ?? null;

    const result = await this.bindingService.forceUnlinkByAdmin({
      bindingId: id,
      actorUserId: req.user.userId,
      actorWorkHistoryId: actorWorkHistory?.id ?? null,
      reasonCategory: body.reasonCategory,
      reason: body.reason,
      acknowledgeSelfUnlink: body.acknowledgeSelfUnlink,
      requestIp,
      requestUserAgent,
    });

    // Post-transaction email side-effect — best-effort. Failure does
    // NOT roll back the unlink; we only flip `userNotified` on the
    // response and log the skip reason.
    const userNotified = await this.notifyAffectedUser({
      targetUserId: result.targetUserId,
      reasonCategory: body.reasonCategory,
      unlinkedAt: result.unlinkedAt,
      bindingId: result.bindingId,
    });

    return {
      ok: true,
      bindingId: result.bindingId,
      userNotified,
      auditId: result.auditId,
    };
  }

  // ---------------------------------------------------------------------------
  // Notification side-effect
  // ---------------------------------------------------------------------------

  /**
   * Send the user-notification email directly via `EmailService` (the
   * W90 sandbox guard chokepoint). We bypass `queueEmail` because the
   * workflow allowlist + preference gates upstream are tuned for
   * project events; force-unlink is an admin governance action and
   * requires its own delivery path.
   *
   * Skip semantics:
   *   - User row missing or soft-deleted → skip.
   *   - `allowEmailNotification === false` → skip (per W86 PDPA — user
   *     opted out of email notifications globally; the audit row IS
   *     the canonical record of consent termination).
   *   - Decrypted email empty / decryption failed → skip.
   *   - `EmailService.sendEmail` returns `success === false` → skip.
   *
   * Returns true ONLY on a non-sandboxed successful send; sandboxed
   * sends count as "delivered to the configured sandbox" and report
   * true. The W90 kill-switch (`MAIL_ENABLED !== 'true'`) returns
   * `sandboxed: true` AND `success: true`; that is intentional and we
   * do NOT downgrade it to false here — operators inspect server logs
   * for the sandbox-suppression line.
   */
  private async notifyAffectedUser(args: {
    targetUserId: string;
    reasonCategory: string;
    unlinkedAt: Date;
    bindingId: string;
  }): Promise<boolean> {
    try {
      const user = await this.userRepo.findOne({
        where: { id: args.targetUserId },
        select: [
          'id',
          'email',
          'emailHash',
          'emailVerifiedAt',
          'allowEmailNotification',
          'firstname',
          'lastname',
        ],
      });

      if (!user) {
        this.logger.log(
          `[ForceUnlink] notify-skip reason=user-missing bindingId=${args.bindingId}`,
        );
        return false;
      }

      if (user.allowEmailNotification === false) {
        this.logger.log(
          `[ForceUnlink] notify-skip reason=preference-off bindingId=${args.bindingId}`,
        );
        return false;
      }

      const plaintextEmail = await this.decryptEmailSafe(user.email);
      if (!plaintextEmail) {
        this.logger.log(
          `[ForceUnlink] notify-skip reason=no-email bindingId=${args.bindingId}`,
        );
        return false;
      }

      // Subject + body. Body intentionally references the
      // reasonCategory only; the operator's free-text reason is NOT
      // exposed to the user (privacy + safety per W97-API-FORCE-UNLINK
      // §7).
      const subject = `[Project Bank] บัญชี LINE ของท่านถูกยกเลิกการเชื่อมต่อโดยผู้ดูแลระบบ`;
      const fullName = `${user.firstname ?? ''} ${user.lastname ?? ''}`.trim();
      const categoryLabelTh = this.categoryLabelTh(args.reasonCategory);
      const whenTh = this.formatThaiTimestamp(args.unlinkedAt);
      const supportEmail =
        process.env.SUPPORT_CONTACT_EMAIL || 'support@projectbank.local';

      const text = [
        `เรียนคุณ${fullName ? ' ' + fullName : ''},`,
        '',
        'ระบบขอแจ้งให้ทราบว่าบัญชี LINE ของท่านถูกยกเลิกการเชื่อมต่อจากระบบ Project Bank โดยผู้ดูแลระบบ (super-admin) ของหน่วยงานกลาง',
        '',
        `เหตุผลของการดำเนินการ: ${categoryLabelTh}`,
        `วันและเวลา: ${whenTh}`,
        '',
        'ผลกระทบที่เกิดขึ้น:',
        '- การแจ้งเตือนผ่าน LINE ของท่านถูกยุติชั่วคราว',
        '- ท่านสามารถเชื่อมต่อบัญชี LINE ใหม่ได้จากหน้าโปรไฟล์ของท่าน หากต้องการรับการแจ้งเตือนต่อ',
        '',
        `หากท่านเห็นว่าการดำเนินการนี้ไม่ถูกต้อง หรือมีข้อสงสัย กรุณาติดต่อผู้ดูแลระบบที่ ${supportEmail}`,
        '',
        'ขอบคุณครับ/ค่ะ',
        'ทีมงาน Project Bank',
      ].join('\n');

      const html = `
<div style="font-family: Sarabun, Arial, sans-serif; line-height: 1.6; color: #1f2937;">
  <p>เรียนคุณ${fullName ? ' ' + this.escapeHtml(fullName) : ''},</p>
  <p>ระบบขอแจ้งให้ทราบว่าบัญชี LINE ของท่านถูกยกเลิกการเชื่อมต่อจากระบบ Project Bank
  โดยผู้ดูแลระบบ (super-admin) ของหน่วยงานกลาง</p>
  <ul>
    <li><strong>เหตุผลของการดำเนินการ:</strong> ${this.escapeHtml(categoryLabelTh)}</li>
    <li><strong>วันและเวลา:</strong> ${this.escapeHtml(whenTh)}</li>
  </ul>
  <p><strong>ผลกระทบที่เกิดขึ้น:</strong></p>
  <ul>
    <li>การแจ้งเตือนผ่าน LINE ของท่านถูกยุติชั่วคราว</li>
    <li>ท่านสามารถเชื่อมต่อบัญชี LINE ใหม่ได้จากหน้าโปรไฟล์ของท่าน หากต้องการรับการแจ้งเตือนต่อ</li>
  </ul>
  <p>หากท่านเห็นว่าการดำเนินการนี้ไม่ถูกต้อง หรือมีข้อสงสัย กรุณาติดต่อผู้ดูแลระบบที่
  <a href="mailto:${this.escapeHtml(supportEmail)}">${this.escapeHtml(supportEmail)}</a></p>
  <p>ขอบคุณครับ/ค่ะ<br/>ทีมงาน Project Bank</p>
</div>`.trim();

      const result = await this.emailService.sendEmail({
        to: plaintextEmail,
        subject,
        text,
        html,
      });

      if (!result.success) {
        this.logger.warn(
          `[ForceUnlink] notify-send-failed bindingId=${args.bindingId} to=${maskEmail(plaintextEmail)} error=${result.error ?? 'unknown'}`,
        );
        return false;
      }

      this.logger.log(
        `[ForceUnlink] notify-sent bindingId=${args.bindingId} to=${maskEmail(plaintextEmail)} sandboxed=${result.sandboxed === true}`,
      );
      return true;
    } catch (err) {
      // §4.1 — email side-effect MUST NOT throw out of this method;
      // the unlink itself already succeeded.
      this.logger.warn(
        `[ForceUnlink] notify-unexpected-error bindingId=${args.bindingId}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  private async decryptEmailSafe(
    raw: string | null | undefined,
  ): Promise<string | null> {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    if (isLikelyCiphertext(raw)) {
      try {
        const plain = await decryption(raw);
        const trimmed = (plain ?? '').trim();
        return trimmed.length > 0 ? trimmed : null;
      } catch {
        // W83 — never log the raw ciphertext.
        return null;
      }
    }
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private categoryLabelTh(category: string): string {
    switch (category) {
      case 'left-org':
        return 'ผู้ใช้พ้นจากหน่วยงาน';
      case 'abuse-report':
        return 'มีการรายงานการใช้งานที่ไม่เหมาะสม';
      case 'cross-binding-deadlock':
        return 'มีความขัดแย้งของการเชื่อมต่อบัญชี LINE';
      case 'user-request':
        return 'ผู้ใช้ร้องขอให้ดำเนินการ';
      case 'other':
      default:
        return 'อื่น ๆ ตามดุลพินิจของผู้ดูแลระบบ';
    }
  }

  private formatThaiTimestamp(d: Date): string {
    try {
      return d.toLocaleString('th-TH', {
        timeZone: 'Asia/Bangkok',
        dateStyle: 'medium',
        timeStyle: 'short',
      });
    } catch {
      return d.toISOString();
    }
  }

  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private extractIp(req: Request): string | null {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      // First IP in the X-Forwarded-For chain is the original client.
      return xff.split(',')[0].trim() || null;
    }
    if (Array.isArray(xff) && xff.length > 0) {
      return xff[0].split(',')[0].trim() || null;
    }
    return req.ip ?? req.socket?.remoteAddress ?? null;
  }

  // ---------------------------------------------------------------------------
  // Rate limit
  // ---------------------------------------------------------------------------

  /**
   * W97-API-FORCE-UNLINK §9 — 5 force-unlinks per actor per hour.
   * Sliding window over the per-actor timestamp list. We GC entries
   * older than the window each call, so the map stays bounded in
   * steady state.
   */
  private assertForceUnlinkRateLimit(userId: string): void {
    const now = Date.now();
    const entries = this.forceUnlinkWindow.get(userId) ?? [];
    const fresh = entries.filter((t) => now - t < FORCE_UNLINK_WINDOW_MS);
    if (fresh.length >= FORCE_UNLINK_MAX_PER_WINDOW) {
      const oldest = fresh[0] ?? now;
      const retryAfterMs = FORCE_UNLINK_WINDOW_MS - (now - oldest);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'เรียกใช้งานบ่อยเกินไป (จำกัด 5 ครั้งต่อชั่วโมง)',
          retryAfterMs,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    fresh.push(now);
    this.forceUnlinkWindow.set(userId, fresh);
  }
}
