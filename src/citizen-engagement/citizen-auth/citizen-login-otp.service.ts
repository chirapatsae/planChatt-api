import { randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { decryption, hashSecret } from 'src/util/encryption.util';
import { EmailService } from 'src/util/email/email.service';
import { CitizenIdentity } from '../entities/citizen-identity.entity';
import { CitizenLoginOtp } from '../entities/citizen-login-otp.entity';
import { CitizenAuditLog } from '../entities/citizen-audit-log.entity';
import { citizenAvatarUrl } from '../media/citizen-avatar.util';
import type { CitizenProfile } from './citizen-auth.service';

/** OTP validity window — product decision: 5 minutes. */
const OTP_TTL_SEC = 300;
const OTP_TTL_MS = OTP_TTL_SEC * 1000;

/** Hard cap on failed verify attempts per challenge — the challenge is BURNED
 *  (consumed) on the MAX-th failure so it can never be guessed further. */
const OTP_MAX_ATTEMPTS = 5;

/** Hard cap on resends per challenge (anti-mailbomb). */
const OTP_MAX_RESENDS = 3;

/** Minimum gap between (re)issues of a code on the same challenge. */
const OTP_RESEND_COOLDOWN_SEC = 60;
const OTP_RESEND_COOLDOWN_MS = OTP_RESEND_COOLDOWN_SEC * 1000;

/** The SINGLE generic failure message for every verify failure branch
 *  (bad token / not-found / expired / consumed / attempt-cap / wrong-code).
 *  NEVER distinguish. */
const GENERIC_OTP_ERROR = 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุ';

/** The login path that opened a challenge. */
export type CitizenOtpLoginMethod = 'password' | 'google' | 'register';

/** Shape returned to the caller when a login step requires OTP. */
export interface CitizenOtpChallengeIssued {
  otpChallengeToken: string;
  expiresInSec: number;
  resendCooldownSec: number;
}

/** Signed challenge-token payload (NO `aud:'citizen'` — see `issueChallenge`). */
interface OtpChallengePayload {
  sub: string;
  /** Always `'citizen-otp-challenge'` for legitimately-issued tokens. Typed as
   *  `string` (not the literal) so the runtime guard is not flagged always-false. */
  purpose: string;
  cid: string;
  loginMethod: string;
  iat?: number;
  exp?: number;
}

/**
 * CitizenLoginOtpService — mandatory email-OTP 2FA for the CITIZEN login.
 *
 * SECURITY posture (mirrors CitizenPasswordResetService):
 *   - 6-digit numeric code (crypto.randomInt); only `hashSecret()`
 *     (HMAC-SHA256 hex) is ever persisted. The plaintext code is emailed and
 *     NEVER logged / stored.
 *   - The gate between step 1 (credential/Google/register OK) and step 2 is a
 *     short-lived JWT (`otpChallengeToken`) with NO session claims and NO
 *     `aud:'citizen'`, so CitizenJwtGuard can never accept it as a session.
 *   - Fire-and-forget email for timing parity; verify uses a timing-safe HMAC
 *     compare and a race-safe single-use burn (`update({ id, consumedAt:
 *     IsNull() }, ...)` + `if (!affected) throw`).
 *   - Per-challenge attempt cap (burn on the 5th fail), resend cap, and resend
 *     cooldown; every verify failure throws ONE generic 401.
 *   - Append-only `CitizenAuditLog` on success (no FK, no PII/code in detail).
 *
 * §17.3 isolation: `citizen_login_otp.identity_id` is a PLAIN uuid (NO FK).
 */
@Injectable()
export class CitizenLoginOtpService {
  private readonly logger = new Logger(CitizenLoginOtpService.name);

  constructor(
    @InjectRepository(CitizenIdentity)
    private readonly identityRepo: Repository<CitizenIdentity>,
    @InjectRepository(CitizenLoginOtp)
    private readonly otpRepo: Repository<CitizenLoginOtp>,
    @InjectRepository(CitizenAuditLog)
    private readonly auditRepo: Repository<CitizenAuditLog>,
    private readonly jwtService: JwtService,
    private readonly emailService: EmailService,
  ) {}

  private get citizenSecret(): string {
    return (
      process.env.CITIZEN_JWT_SECRET || process.env.JWT_SECRET || 'defaultSecret'
    );
  }

  /** 6-digit zero-padded numeric code. */
  private generateCode(): string {
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
  }

  private toProfile(identity: CitizenIdentity): CitizenProfile {
    return {
      id: identity.id,
      displayAlias: identity.displayAlias,
      avatarUrl: citizenAvatarUrl(
        identity.id,
        identity.avatarPath,
        identity.updatedAt,
      ),
      emailVerified: !!identity.emailVerifiedAt,
    };
  }

  /** Mint the REAL 30-day session — the ONLY place this happens post-OTP. */
  private signSession(
    identity: CitizenIdentity,
    loginMethod: 'password' | 'google',
  ): string {
    return this.jwtService.sign(
      {
        sub: identity.id,
        typ: 'citizen',
        loginMethod,
        sessionVersion: identity.sessionVersion ?? 0,
      },
      { secret: this.citizenSecret, expiresIn: '30d', audience: 'citizen' },
    );
  }

  /** Reject any citizen whose account is not usable (blocked/suspended/deleted). */
  private assertUsable(identity: CitizenIdentity): void {
    if (identity.status !== 'active') {
      throw new UnauthorizedException(GENERIC_OTP_ERROR);
    }
  }

  // ===================================================================
  //  1) Issue a challenge (step 1 → step 2 hand-off)
  // ===================================================================

  /**
   * Persist a fresh code (HMAC-only), fire-and-forget the OTP email, and return
   * a signed `otpChallengeToken`. NEVER awaits the SMTP round trip so the
   * login response time does not leak email deliverability.
   *
   * The token carries `purpose:'citizen-otp-challenge'` + the challenge id and
   * is signed with CITIZEN_JWT_SECRET but WITHOUT `audience:'citizen'`, so the
   * CitizenJwtGuard (which requires `aud:'citizen'`) can NEVER accept it as a
   * login session.
   */
  async issueChallenge(
    identity: CitizenIdentity,
    loginMethod: CitizenOtpLoginMethod,
    ip: string | null,
    userAgent: string | null,
  ): Promise<CitizenOtpChallengeIssued> {
    const now = new Date();
    const challengeId = randomBytes(32).toString('base64url');
    const code = this.generateCode();

    await this.otpRepo.insert({
      identityId: identity.id,
      challengeId,
      codeHash: hashSecret(code),
      loginMethod,
      expiresAt: new Date(now.getTime() + OTP_TTL_MS),
      consumedAt: null,
      attemptCount: 0,
      resendCount: 0,
      requestIp: ip ? ip.slice(0, 45) : null,
      requestUserAgent: userAgent ? userAgent.slice(0, 256) : null,
    });

    // Fire-and-forget (timing parity + never leak deliverability). The row
    // exists regardless; a transient mail error must not change the response.
    void this.sendOtpEmail(identity, code).catch((err) => {
      this.logger.warn(
        `citizen.login_otp.email_failed identityId=${identity.id} ` +
          `err=${(err as Error)?.constructor?.name ?? 'UnknownError'}`,
      );
    });

    const otpChallengeToken = this.jwtService.sign(
      {
        sub: identity.id,
        purpose: 'citizen-otp-challenge',
        cid: challengeId,
        loginMethod,
      } satisfies OtpChallengePayload,
      { secret: this.citizenSecret, expiresIn: '5m' },
    );

    // PII discipline — log the uuid + method only, never the code / email.
    this.logger.log(
      `citizen.login_otp.issued identityId=${identity.id} method=${loginMethod} at=${now.toISOString()}`,
    );

    return {
      otpChallengeToken,
      expiresInSec: OTP_TTL_SEC,
      resendCooldownSec: OTP_RESEND_COOLDOWN_SEC,
    };
  }

  // ===================================================================
  //  2) Verify a code → mint the real session
  // ===================================================================

  /**
   * Redeems a challenge. EVERY failure branch throws the SAME generic 401
   * (`GENERIC_OTP_ERROR`) — never distinguish bad-token / not-found / expired /
   * consumed / attempt-cap / wrong-code. On success mints the 30-day citizen
   * session (the ONLY place a login session is minted).
   */
  async verify(
    otpChallengeToken: string,
    code: string,
  ): Promise<{ accessToken: string; profile: CitizenProfile }> {
    let payload: OtpChallengePayload;
    try {
      payload = this.jwtService.verify<OtpChallengePayload>(otpChallengeToken, {
        secret: this.citizenSecret,
      });
    } catch {
      throw new UnauthorizedException(GENERIC_OTP_ERROR);
    }
    if (payload.purpose !== 'citizen-otp-challenge' || !payload.cid) {
      throw new UnauthorizedException(GENERIC_OTP_ERROR);
    }

    const now = new Date();
    const row = await this.otpRepo.findOne({
      where: { challengeId: payload.cid },
    });
    if (
      !row ||
      row.consumedAt ||
      row.expiresAt.getTime() < now.getTime() ||
      row.attemptCount >= OTP_MAX_ATTEMPTS
    ) {
      throw new UnauthorizedException(GENERIC_OTP_ERROR);
    }

    // Timing-safe HMAC compare (both are 64-char hex → equal length).
    const ok = this.timingSafeHexEqual(hashSecret(code), row.codeHash);
    if (!ok) {
      // Atomic increment so concurrent wrong-code requests can't each act on a
      // stale attemptCount and slip past the cap; re-read the true value to
      // decide the burn (P3-2 hardening).
      await this.otpRepo.increment({ id: row.id }, 'attemptCount', 1);
      const bumped = await this.otpRepo.findOne({
        where: { id: row.id },
        select: { id: true, attemptCount: true },
      });
      if (bumped && bumped.attemptCount >= OTP_MAX_ATTEMPTS) {
        // Burn on the MAX-th failure so the challenge can never be retried.
        const lock = await this.otpRepo.update(
          { id: row.id, consumedAt: IsNull() },
          { consumedAt: now },
        );
        // Tamper-evident record of a likely account-takeover attempt. Best-effort
        // — a logging failure must never turn a wrong-code 401 into a 500.
        if (lock.affected) {
          try {
            await this.auditRepo.insert({
              actorKind: 'citizen',
              actorId: row.identityId,
              action: 'login_otp_lockout',
              targetKind: 'identity',
              targetId: row.identityId,
              detail: { method: row.loginMethod, reason: 'attempt_cap_burn' },
            });
          } catch {
            /* audit is best-effort; never block the auth response */
          }
        }
      }
      throw new UnauthorizedException(GENERIC_OTP_ERROR);
    }

    // Race-safe single-use burn: two concurrent verifies of the same code race
    // on this UPDATE; the loser sees 0 rows affected and aborts.
    const burn = await this.otpRepo.update(
      { id: row.id, consumedAt: IsNull() },
      { consumedAt: now },
    );
    if (!burn.affected) {
      throw new UnauthorizedException(GENERIC_OTP_ERROR);
    }

    const identity = await this.identityRepo.findOne({
      where: { id: row.identityId },
    });
    if (!identity) {
      throw new UnauthorizedException(GENERIC_OTP_ERROR);
    }
    this.assertUsable(identity);

    // A 'register' OTP doubles as email verification — the code proves the
    // citizen controls the inbox.
    if (row.loginMethod === 'register' && !identity.emailVerifiedAt) {
      identity.emailVerifiedAt = now;
    }
    identity.lastLoginAt = now;
    const saved = await this.identityRepo.save(identity);

    // Append-only audit — no PII / code in `detail`, only the method + uuids.
    await this.auditRepo.insert({
      actorKind: 'citizen',
      actorId: saved.id,
      action: 'login_otp_verified',
      targetKind: 'identity',
      targetId: saved.id,
      detail: { method: row.loginMethod },
    });

    // Session label is 'password' for password/register, 'google' for google.
    const sessionMethod: 'password' | 'google' =
      row.loginMethod === 'google' ? 'google' : 'password';

    this.logger.log(
      `citizen.login_otp.verified identityId=${saved.id} method=${row.loginMethod} at=${now.toISOString()}`,
    );

    return {
      accessToken: this.signSession(saved, sessionMethod),
      profile: this.toProfile(saved),
    };
  }

  // ===================================================================
  //  3) Resend a code (rotate on the SAME challenge)
  // ===================================================================

  /**
   * Re-issues a fresh code on the SAME challenge row (so the caller's
   * `otpChallengeToken` stays valid). ALWAYS resolves to the uniform
   * `{ ok:true, resendCooldownSec }` — silent no-op on bad token / expired /
   * consumed / cooldown / resend-cap (anti-enumeration + anti-mailbomb).
   */
  async resend(
    otpChallengeToken: string,
  ): Promise<{ ok: true; resendCooldownSec: number }> {
    const uniform = {
      ok: true as const,
      resendCooldownSec: OTP_RESEND_COOLDOWN_SEC,
    };

    let payload: OtpChallengePayload;
    try {
      payload = this.jwtService.verify<OtpChallengePayload>(otpChallengeToken, {
        secret: this.citizenSecret,
      });
    } catch {
      return uniform; // silent
    }
    if (payload.purpose !== 'citizen-otp-challenge' || !payload.cid) {
      return uniform;
    }

    const now = new Date();
    const row = await this.otpRepo.findOne({
      where: { challengeId: payload.cid },
    });
    if (!row || row.consumedAt || row.expiresAt.getTime() < now.getTime()) {
      return uniform;
    }
    if (row.resendCount >= OTP_MAX_RESENDS) {
      return uniform; // cap reached — silent
    }

    // Cooldown: each (re)issue sets `expires_at = issuedAt + TTL`, so the last
    // issue time is `expires_at - TTL`. Suppress if that is within the cooldown.
    const lastIssuedMs = row.expiresAt.getTime() - OTP_TTL_MS;
    if (lastIssuedMs > now.getTime() - OTP_RESEND_COOLDOWN_MS) {
      return uniform; // still cooling down — silent
    }

    const identity = await this.identityRepo.findOne({
      where: { id: row.identityId },
    });
    if (!identity) {
      return uniform;
    }

    const code = this.generateCode();
    // Rotate the code on the same (still-unconsumed) row: new hash, fresh TTL,
    // reset attempts, bump resend counter. `consumedAt: IsNull()` guards a race
    // with a concurrent verify/burn.
    const rotated = await this.otpRepo.update(
      { id: row.id, consumedAt: IsNull() },
      {
        codeHash: hashSecret(code),
        expiresAt: new Date(now.getTime() + OTP_TTL_MS),
        attemptCount: 0,
        resendCount: row.resendCount + 1,
      },
    );
    if (!rotated.affected) {
      return uniform; // lost the race — silent
    }

    void this.sendOtpEmail(identity, code).catch((err) => {
      this.logger.warn(
        `citizen.login_otp.resend_email_failed identityId=${identity.id} ` +
          `err=${(err as Error)?.constructor?.name ?? 'UnknownError'}`,
      );
    });

    this.logger.log(
      `citizen.login_otp.resent identityId=${identity.id} at=${now.toISOString()}`,
    );
    return uniform;
  }

  // ===================================================================
  //  Email
  // ===================================================================

  private async sendOtpEmail(
    identity: CitizenIdentity,
    code: string,
  ): Promise<void> {
    // Decrypt the recipient ONLY at send time; never log / retain it.
    if (!identity.emailEnc) return;
    const recipient = await decryption(identity.emailEnc);

    const alias = identity.displayAlias || 'ผู้ใช้งาน';
    const subject = '[หนองกระทุ่ม] รหัสยืนยันการเข้าสู่ระบบบัญชีประชาชน';

    const text =
      `เรียน ${alias}\n\n` +
      `รหัสยืนยันการเข้าสู่ระบบบัญชีประชาชนของท่านกับเทศบาลตำบลหนองกระทุ่มคือ:\n\n` +
      `${code}\n\n` +
      `รหัสนี้จะหมดอายุใน 5 นาที\n\n` +
      `หากท่านไม่ได้เป็นผู้ร้องขอ โปรดละเว้นอีเมลฉบับนี้\n\n` +
      `ด้วยความเคารพ\nเทศบาลตำบลหนองกระทุ่ม`;

    // Google-style transactional layout — mirrors the citizen password-reset
    // card (light page, centered white card, "แผนชัด" wordmark, dividers,
    // municipal footer). Self-contained: the citizen namespace must NOT couple
    // to the staff notification templates (§17.3). The CTA button is swapped
    // for a large letter-spaced monospace code block.
    const safeAlias = this.escapeHtml(alias);
    const safeCode = this.escapeHtml(code);
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
      `<h1 style="font-size:18px;font-weight:600;color:#202124;margin:0 0 16px 0;line-height:1.5;">รหัสยืนยันการเข้าสู่ระบบบัญชีประชาชน</h1>` +
      `<p style="font-size:14px;line-height:1.7;margin:0 0 4px 0;color:#202124;">เรียน ${safeAlias}</p>` +
      `<p style="font-size:14px;line-height:1.7;margin:0 0 20px 0;color:#3c4043;">` +
      `กรุณากรอกรหัสยืนยัน 6 หลักด้านล่างเพื่อเข้าสู่ระบบบัญชีประชาชนของท่านกับเทศบาลตำบลหนองกระทุ่ม</p>` +
      // Code block (large letter-spaced monospace)
      `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;"><tr><td ` +
      `style="border-radius:8px;background-color:#f1f5f9;border:1px solid #e2e8f0;padding:16px 28px;">` +
      `<div style="font-family:'Courier New',Consolas,monospace;font-size:34px;font-weight:700;` +
      `letter-spacing:10px;color:#111827;text-align:center;line-height:1;">${safeCode}</div>` +
      `</td></tr></table>` +
      `<p style="font-size:13px;line-height:1.6;margin:0 0 6px 0;color:#3c4043;">` +
      `<strong>หมดอายุใน 5 นาที</strong> &middot; หากไม่ใช่ท่าน โปรดละเว้น</p>` +
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

  private timingSafeHexEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }
}
