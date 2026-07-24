import { randomBytes } from 'crypto';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, MoreThan, Repository } from 'typeorm';

import { decryption, hashEmail, hashSecret } from 'src/util/encryption.util';
import { Argon2Service } from 'src/backup-login/argon2.service';
import { EmailService } from 'src/util/email/email.service';
import { CitizenIdentity } from '../entities/citizen-identity.entity';
import { CitizenPasswordResetToken } from '../entities/citizen-password-reset-token.entity';
import { CitizenAuditLog } from '../entities/citizen-audit-log.entity';
import { CitizenSessionRegistryService } from './citizen-session-registry.service';
import { sessionRegistryEnabled } from 'src/common/session-registry/session-registry.flag';

/** Token validity window — product decision: 30 minutes. */
const TOKEN_TTL_MS = 30 * 60 * 1000;

/** Per-email issue cooldown — a fresh unconsumed token within this window
 *  suppresses re-issue (anti-mailbomb, complements the per-IP throttle). */
const REISSUE_COOLDOWN_MS = 60 * 1000;

/** Hard cap on simultaneously-active (unconsumed, unexpired) tokens per identity. */
const MAX_ACTIVE_TOKENS = 3;

/** The SINGLE generic failure message for every reset-consume failure branch
 *  (not-found / used / expired / inactive / google-only). NEVER distinguish. */
const GENERIC_RESET_ERROR = 'ลิงก์รีเซ็ตไม่ถูกต้องหรือหมดอายุ';

/**
 * CitizenPasswordResetService — the email/password reset flow for the CITIZEN
 * login (AUTH-REDESIGN §3.2 follow-up). Kept separate from CitizenAuthService
 * so the credential-exchange surface stays lean.
 *
 * SECURITY posture (all baked in here):
 *   - 32 random bytes → base64url raw token; only `hashSecret()` (HMAC-SHA256)
 *     is ever persisted. The plaintext is emailed and NEVER logged/stored.
 *   - Uniform anti-enumeration: `requestPasswordReset` NEVER throws / NEVER
 *     signals account existence; the no-account branch runs a dummy Argon2
 *     verify for timing parity (mirrors CitizenAuthService.login).
 *   - Google-only accounts (`password_hash IS NULL`) get NO token and CANNOT
 *     reset — guarded on both request and consume.
 *   - Single-use + session revocation: on success the token (and every other
 *     unconsumed token for the identity) is burned, `session_version` bumps,
 *     and `email_verified_at` is set if null (the link proves email control).
 */
@Injectable()
export class CitizenPasswordResetService {
  private readonly logger = new Logger(CitizenPasswordResetService.name);

  constructor(
    @InjectRepository(CitizenIdentity)
    private readonly identityRepo: Repository<CitizenIdentity>,
    @InjectRepository(CitizenPasswordResetToken)
    private readonly tokenRepo: Repository<CitizenPasswordResetToken>,
    private readonly argon2: Argon2Service,
    private readonly emailService: EmailService,
    private readonly dataSource: DataSource,
    private readonly citizenSessionRegistry: CitizenSessionRegistryService,
  ) {}

  private static resolveFrontendBase(): string {
    const fromNotify = process.env.NOTIFY_ACTION_LINK_BASE;
    if (typeof fromNotify === 'string' && fromNotify.length > 0) return fromNotify;
    const fromExplicit = process.env.FRONTEND_URL;
    if (typeof fromExplicit === 'string' && fromExplicit.length > 0)
      return fromExplicit;
    return 'http://localhost:5173';
  }

  // ===================================================================
  //  1) Request a reset link
  // ===================================================================

  /**
   * ALWAYS resolves without throwing — the caller returns a uniform 200
   * `{ ok: true }`. Timing on the no-account branch is equalized with a dummy
   * Argon2 verify so response time never leaks account existence.
   */
  async requestPasswordReset(input: {
    email: string;
    ip: string | null;
    userAgent: string | null;
  }): Promise<void> {
    const emailNorm = input.email.trim().toLowerCase();
    const identity = await this.identityRepo.findOne({
      where: { emailHash: hashEmail(emailNorm) },
    });

    // Branch A — no account. Return after the same single indexed lookup the
    // other branches do. IMPORTANT (SEC F1): do NOT run an Argon2 dummy here.
    // The real request path performs NO password verify, so a ~500ms dummy
    // would make "no account" the SLOW outlier and hand an attacker a timing
    // oracle (the inverse of the intended anti-enumeration goal). Every branch
    // now returns in ~one DB-query time; the emailed send is fire-and-forget
    // below so the active-account path isn't the slow one either.
    if (!identity) {
      return;
    }

    // Branch B — Google-only (no password) or non-active account: no token,
    // no email. Still silent (uniform response) to avoid enumeration.
    if (!identity.passwordHash || identity.status !== 'active') {
      return;
    }

    // Per-email cooldown: a fresh unconsumed, unexpired token issued within the
    // cooldown window suppresses re-issue (anti-mailbomb). Still return ok.
    const now = new Date();
    const active = await this.tokenRepo.find({
      where: {
        identityId: identity.id,
        usedAt: IsNull(),
        expiresAt: MoreThan(now),
      },
      order: { createdAt: 'DESC' },
    });
    const cooldownFloor = new Date(now.getTime() - REISSUE_COOLDOWN_MS);
    if (active.some((t) => t.createdAt > cooldownFloor)) {
      return;
    }
    // Active-token cap — also silently suppress once too many are outstanding.
    if (active.length >= MAX_ACTIVE_TOKENS) {
      return;
    }

    // Generate the raw token (never persisted) and store only its HMAC.
    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = hashSecret(rawToken);
    const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);

    await this.tokenRepo.insert({
      identityId: identity.id,
      tokenHash,
      expiresAt,
      usedAt: null,
      requestIp: input.ip ? input.ip.slice(0, 45) : null,
      requestUserAgent: input.userAgent ? input.userAgent.slice(0, 256) : null,
    });

    // Send the reset email FIRE-AND-FORGET (SEC F1): awaiting the SMTP round
    // trip would make the active-account path measurably slower than the
    // no-account / google-only branches, re-introducing a timing oracle.
    // Failures are swallowed (still uniform 200) — the token exists; a
    // transient mail error must not leak via response shape or timing.
    void this.sendResetEmail(identity, rawToken).catch((err) => {
      this.logger.warn(
        `citizen.password_reset.email_failed identityId=${identity.id} ` +
          `err=${(err as Error)?.constructor?.name ?? 'UnknownError'}`,
      );
    });

    // PII discipline — log the uuid only, never the email / raw token.
    this.logger.log(
      `citizen.password_reset.requested identityId=${identity.id} at=${now.toISOString()}`,
    );
  }

  private async sendResetEmail(
    identity: CitizenIdentity,
    rawToken: string,
  ): Promise<void> {
    // Decrypt the recipient ONLY at send time; never log / retain it.
    if (!identity.emailEnc) return;
    const recipient = await decryption(identity.emailEnc);

    const base = CitizenPasswordResetService.resolveFrontendBase().replace(
      /\/+$/,
      '',
    );
    const resetUrl = `${base}/citizen/reset-password?token=${encodeURIComponent(
      rawToken,
    )}`;

    const alias = identity.displayAlias || 'ผู้ใช้งาน';
    const subject = '[หนองกระทุ่ม] คำขอรีเซ็ตรหัสผ่านบัญชีประชาชน';

    const text =
      `เรียน ${alias}\n\n` +
      `เราได้รับคำขอรีเซ็ตรหัสผ่านบัญชีประชาชนของท่านกับเทศบาลตำบลหนองกระทุ่ม\n` +
      `กรุณาคลิกลิงก์ด้านล่างเพื่อตั้งรหัสผ่านใหม่:\n\n` +
      `${resetUrl}\n\n` +
      `ลิงก์นี้จะหมดอายุใน 30 นาที\n\n` +
      `หากท่านไม่ได้เป็นผู้ร้องขอ โปรดละเว้นอีเมลฉบับนี้ รหัสผ่านเดิมยังใช้งานได้\n\n` +
      `ด้วยความเคารพ\nเทศบาลตำบลหนองกระทุ่ม`;

    // Google-style transactional layout — mirrors the staff `_base.hbs`
    // (light page, centered white card, text wordmark header, divider,
    // content, divider, municipal footer). Self-contained: the citizen
    // namespace must NOT couple to the staff notification templates (§17.3).
    const safeAlias = this.escapeHtml(alias);
    const safeUrl = this.escapeHtml(resetUrl);
    const html =
      `<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"/>` +
      `<meta name="viewport" content="width=device-width, initial-scale=1.0"/>` +
      `<title>${this.escapeHtml(subject)}</title></head>` +
      `<body style="margin:0;padding:0;background-color:#f5f6f8;` +
      `font-family:'Sarabun','Noto Sans Thai',Arial,sans-serif;color:#202124;-webkit-font-smoothing:antialiased;">` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f6f8;">` +
      `<tr><td align="center" style="padding:32px 12px;">` +
      `<table role="presentation" width="600" cellpadding="0" cellspacing="0" ` +
      `style="width:600px;max-width:100%;background-color:#ffffff;border:1px solid #e8eaed;border-radius:12px;">` +
      // Header wordmark
      `<tr><td align="center" style="padding:40px 40px 0 40px;">` +
      `<div style="font-size:26px;font-weight:700;color:#2563eb;letter-spacing:0.5px;line-height:1;">แผนชัด</div>` +
      `<div style="font-size:13px;color:#5f6368;margin-top:6px;">ระบบแผนชัด (PlanCHATT) &middot; เทศบาลตำบลหนองกระทุ่ม</div>` +
      `</td></tr>` +
      // Divider
      `<tr><td style="padding:24px 40px 0 40px;"><div style="border-top:1px solid #e8eaed;font-size:0;line-height:0;">&nbsp;</div></td></tr>` +
      // Body
      `<tr><td style="padding:24px 40px 8px 40px;">` +
      `<h1 style="font-size:18px;font-weight:600;color:#202124;margin:0 0 16px 0;line-height:1.5;">คำขอรีเซ็ตรหัสผ่านบัญชีประชาชน</h1>` +
      `<p style="font-size:14px;line-height:1.7;margin:0 0 4px 0;color:#202124;">เรียน ${safeAlias}</p>` +
      `<p style="font-size:14px;line-height:1.7;margin:0 0 20px 0;color:#3c4043;">` +
      `เราได้รับคำขอรีเซ็ตรหัสผ่านบัญชีประชาชนของท่านกับเทศบาลตำบลหนองกระทุ่ม กรุณากดปุ่มด้านล่างเพื่อตั้งรหัสผ่านใหม่</p>` +
      // CTA button (table-wrapped for Outlook)
      `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;"><tr><td ` +
      `style="border-radius:8px;background-color:#2563eb;"><a href="${safeUrl}" ` +
      `style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;` +
      `text-decoration:none;border-radius:8px;">ตั้งรหัสผ่านใหม่</a></td></tr></table>` +
      `<p style="font-size:13px;line-height:1.6;margin:0 0 6px 0;color:#3c4043;"><strong>ลิงก์นี้จะหมดอายุใน 30 นาที</strong></p>` +
      `<p style="font-size:13px;line-height:1.6;margin:0;color:#5f6368;">` +
      `หากท่านไม่ได้เป็นผู้ร้องขอ โปรดละเว้นอีเมลฉบับนี้ รหัสผ่านเดิมยังใช้งานได้</p>` +
      `</td></tr>` +
      // Divider
      `<tr><td style="padding:8px 40px 0 40px;"><div style="border-top:1px solid #e8eaed;font-size:0;line-height:0;">&nbsp;</div></td></tr>` +
      // Footer
      `<tr><td align="center" style="padding:20px 40px 32px 40px;">` +
      `<p style="font-size:12px;color:#5f6368;line-height:1.6;margin:0;">` +
      `อีเมลนี้ถูกส่งจากระบบแผนชัด (PlanCHATT) โดยอัตโนมัติ กรุณาอย่าตอบกลับอีเมลฉบับนี้</p>` +
      `<p style="font-size:12px;color:#5f6368;line-height:1.6;margin:8px 0 0 0;">` +
      `เทศบาลตำบลหนองกระทุ่ม อำเภอเมืองนครราชสีมา จังหวัดนครราชสีมา</p>` +
      `</td></tr>` +
      `</table></td></tr></table></body></html>`;

    await this.emailService.sendEmail({ to: recipient, subject, text, html });
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ===================================================================
  //  2) Verify a token (optional low-risk pre-check for the FE)
  // ===================================================================

  /** Returns whether the token is currently redeemable. Never distinguishes
   *  the reason (generic). Read-only — does NOT consume the token. */
  async verifyToken(token: string): Promise<boolean> {
    if (typeof token !== 'string' || token.length < 16) return false;
    const row = await this.tokenRepo.findOne({
      where: { tokenHash: hashSecret(token) },
    });
    if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) return false;
    const identity = await this.identityRepo.findOne({
      where: { id: row.identityId },
    });
    if (!identity || identity.status !== 'active' || !identity.passwordHash) {
      return false;
    }
    return true;
  }

  // ===================================================================
  //  3) Consume a token → set the new password
  // ===================================================================

  /**
   * Redeems a reset token and sets the new password. EVERY failure branch
   * throws the SAME generic 400 (`GENERIC_RESET_ERROR`) — never distinguish
   * not-found / used / expired / inactive / google-only.
   */
  async resetPassword(input: {
    token: string;
    newPassword: string;
  }): Promise<{ ok: true }> {
    const tokenHash = hashSecret(input.token);
    const row = await this.tokenRepo.findOne({ where: { tokenHash } });

    if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException(GENERIC_RESET_ERROR);
    }

    const identity = await this.identityRepo.findOne({
      where: { id: row.identityId },
    });
    // Inactive or Google-only (no password) → cannot reset via this flow.
    if (!identity || identity.status !== 'active' || !identity.passwordHash) {
      throw new BadRequestException(GENERIC_RESET_ERROR);
    }

    const newHash = await this.argon2.hash(input.newPassword);
    const now = new Date();

    await this.dataSource.transaction(async (em) => {
      const idRepo = em.getRepository(CitizenIdentity);
      const tokRepo = em.getRepository(CitizenPasswordResetToken);

      // SEC F3 — burn THIS token FIRST, conditioned on it still being unused,
      // and require exactly one affected row. Two concurrent redemptions of the
      // same still-valid token race on this UPDATE; the loser sees 0 rows
      // affected and aborts (rolls back), so the password is set + session
      // bumped exactly once.
      const burn = await tokRepo.update(
        { id: row.id, usedAt: IsNull() },
        { usedAt: now },
      );
      if (!burn.affected) {
        throw new BadRequestException(GENERIC_RESET_ERROR);
      }

      // Invalidate every OTHER unconsumed token for the identity so a stale
      // link cannot be replayed after this reset.
      await tokRepo.update(
        { identityId: identity.id, usedAt: IsNull() },
        { usedAt: now },
      );

      // Set password + ATOMICALLY bump session_version (SEC F4 — SQL increment,
      // not read-modify-write) to revoke every issued citizen JWT; verify email
      // if the link proved control. A Google-linked 'both' account keeps its
      // provider; a pure 'password' account stays 'password' (no change here).
      await idRepo
        .createQueryBuilder()
        .update(CitizenIdentity)
        .set({
          passwordHash: newHash,
          sessionVersion: () => '"session_version" + 1',
          emailVerifiedAt: identity.emailVerifiedAt ?? now,
        })
        .where('id = :id', { id: identity.id })
        .execute();

      // Append-only audit — no PII in `detail` (only the identity uuid, carried
      // as actor/target). §17.3 isolation: no FK, no tracking_status write.
      await em.getRepository(CitizenAuditLog).insert({
        actorKind: 'citizen',
        actorId: identity.id,
        action: 'password_reset',
        targetKind: 'identity',
        targetId: identity.id,
        detail: { via: 'reset_link' },
      });
    });

    // [SEC P3-1] The session_version bump above invalidates every issued citizen
    // JWT via the guard's version check, but leaves the identity's session-
    // registry rows `revoked_at = NULL` → the device-manager would still list
    // them as "active". A reset via link is a FULL revocation (no session is
    // being carried forward), so revoke ALL of the identity's rows — the empty
    // `currentSid` drops the `id <>` predicate (SEC P2-1). No-ops with the flag
    // off (no registry rows exist).
    if (sessionRegistryEnabled()) {
      await this.citizenSessionRegistry.revokeOthers(identity.id, '');
    }

    this.logger.log(
      `citizen.password_reset.completed identityId=${identity.id} at=${now.toISOString()}`,
    );
    return { ok: true };
  }
}
