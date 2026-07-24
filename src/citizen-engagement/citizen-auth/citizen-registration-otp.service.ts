import { randomBytes, randomInt, timingSafeEqual } from 'crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, MoreThan, Not, Repository } from 'typeorm';

import {
  decryption,
  encryption,
  hashEmail,
  hashSecret,
} from 'src/util/encryption.util';
import { Argon2Service } from 'src/backup-login/argon2.service';
import { EmailService } from 'src/util/email/email.service';
import { CitizenIdentity } from '../entities/citizen-identity.entity';
import { CitizenRegistrationOtp } from '../entities/citizen-registration-otp.entity';
import { CitizenAuditLog } from '../entities/citizen-audit-log.entity';
import { citizenAvatarUrl } from '../media/citizen-avatar.util';
import type { CitizenProfile } from './citizen-auth.service';
import { CitizenSessionMintService } from './citizen-session-mint.service';

/** OTP validity window — product decision: 5 minutes (mirrors login-OTP). */
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

/** Short-lived token proving email ownership → hand-off to complete. 10 min. */
const REGISTRATION_TOKEN_TTL_SEC = 600;

/** The SINGLE generic failure message for every verify-otp failure branch
 *  (bad token / not-found / expired / consumed / already-verified /
 *  attempt-cap / wrong-code). NEVER distinguish. */
const GENERIC_VERIFY_ERROR = 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุ';

/** The SINGLE generic failure message for every complete-token failure branch
 *  (bad token / wrong purpose / not-verified / already-consumed / race). */
const GENERIC_COMPLETE_ERROR = 'ลิงก์สมัครหมดอายุ กรุณาเริ่มใหม่';

/** Current privacy-policy version accepted at registration (PDPA). */
const CONSENT_VERSION = process.env.PRIVACY_POLICY_VERSION || 'v1';

/** Signed step-1 challenge-token payload (NO `aud:'citizen'`). */
interface RegChallengePayload {
  sub: string;
  /** Always `'citizen-reg-challenge'` for legitimately-issued tokens. Typed as
   *  `string` (not the literal) so the runtime guard is not flagged always-false. */
  purpose: string;
  iat?: number;
  exp?: number;
}

/** Signed step-2 registration-token payload (NO `aud:'citizen'`). */
interface RegistrationTokenPayload {
  sub: string;
  purpose: string;
  /** email_hash of the verified challenge (defensive cross-check at complete). */
  eh: string;
  iat?: number;
  exp?: number;
}

/**
 * CitizenRegistrationOtpService — the "verify-email-first" 3-step CITIZEN
 * registration flow (replaces "create-account-then-OTP").
 *
 *   1) requestOtp  — email a 6-digit code, return a challengeToken. NO identity.
 *   2) verifyOtp   — prove email ownership, return a short-lived registrationToken.
 *   3) complete    — create the `citizen_identities` row (email already verified)
 *                    and mint the real session.
 *
 * SECURITY posture (mirrors CitizenLoginOtpService / CitizenPasswordResetService):
 *   - 6-digit numeric code (crypto.randomInt); only `hashSecret()`
 *     (HMAC-SHA256 hex) is ever persisted. The plaintext is emailed and NEVER
 *     logged / stored. No Argon2 on the code (cheap HMAC compare).
 *   - Anti-enumeration: `requestOtp` is UNIFORM in shape AND timing whether or
 *     not the email is already registered — same single indexed lookup + same
 *     insert; the existing-email branch stores a random DECOY code_hash (never
 *     emailed) and sends an "account already exists" email instead of the OTP.
 *     Both emails are fire-and-forget so neither branch is the slow outlier.
 *   - `verifyOtp` uses a timing-safe HMAC compare + per-challenge attempt cap
 *     (burn on the 5th fail) + a race-safe verified-mark; every failure throws
 *     ONE generic 401.
 *   - The registrationToken is signed with CITIZEN_JWT_SECRET but WITHOUT
 *     `aud:'citizen'`, so CitizenJwtGuard can NEVER accept it as a session.
 *   - `complete` burns the row single-use (race-safe `update({ id, verifiedAt:
 *     Not(IsNull()), consumedAt: IsNull() }, ...)` + `if (!affected) throw`) and
 *     backstops the email-hash unique violation (23505) with the generic error.
 *
 * §17.3 isolation: `citizen_registration_otp` has NO `identity_id` and NO FK —
 * the identity is created ONLY at complete, so there are never orphan identities.
 */
@Injectable()
export class CitizenRegistrationOtpService {
  private readonly logger = new Logger(CitizenRegistrationOtpService.name);

  constructor(
    @InjectRepository(CitizenIdentity)
    private readonly identityRepo: Repository<CitizenIdentity>,
    @InjectRepository(CitizenRegistrationOtp)
    private readonly otpRepo: Repository<CitizenRegistrationOtp>,
    private readonly jwtService: JwtService,
    private readonly argon2: Argon2Service,
    private readonly emailService: EmailService,
    private readonly dataSource: DataSource,
    // Batch 2 — records the per-session row + fires the new-device alert (both
    // flag-gated). Injected here because complete() is a citizen mint point.
    private readonly sessionMint: CitizenSessionMintService,
  ) {}

  private get citizenSecret(): string {
    return (
      process.env.CITIZEN_JWT_SECRET || process.env.JWT_SECRET || 'defaultSecret'
    );
  }

  private static resolveFrontendBase(): string {
    const fromNotify = process.env.NOTIFY_ACTION_LINK_BASE;
    if (typeof fromNotify === 'string' && fromNotify.length > 0) return fromNotify;
    const fromExplicit = process.env.FRONTEND_URL;
    if (typeof fromExplicit === 'string' && fromExplicit.length > 0)
      return fromExplicit;
    return 'http://localhost:5173';
  }

  /** 6-digit zero-padded numeric code. */
  private generateCode(): string {
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
  }

  /** "สมชาย มานะ" → "สมชาย ม." — never expose the full family name. */
  private maskAlias(displayName?: string): string {
    const parts = (displayName ?? '').trim().split(/\s+/).filter(Boolean);
    const given = parts[0] ?? '';
    const initial = (parts[1] ?? '').charAt(0);
    const alias = initial ? `${given} ${initial}.` : given;
    return (alias || 'ผู้ใช้ใหม่').slice(0, 64);
  }

  /** Fallback alias from an email local part (never exposes the domain). */
  private aliasFromEmail(email: string): string {
    const local = (email.split('@')[0] || '').trim();
    return (local || 'ผู้ใช้ใหม่').slice(0, 64);
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

  /**
   * Mint the REAL 30-day session (mirrors CitizenAuthService.sign). `sid` is
   * added ONLY when the session registry is enabled — undefined ⇒ byte-for-byte
   * identical to the pre-Batch-2 token.
   */
  private signSession(identity: CitizenIdentity, sid?: string): string {
    return this.jwtService.sign(
      {
        sub: identity.id,
        typ: 'citizen',
        loginMethod: 'password',
        sessionVersion: identity.sessionVersion ?? 0,
        ...(sid ? { sid } : {}),
      },
      { secret: this.citizenSecret, expiresIn: '30d', audience: 'citizen' },
    );
  }

  private signChallengeToken(challengeId: string): string {
    // TTL must outlast the row's resend-extended lifetime (initial 5m code +
    // up to 3 rotations at ~5m each), else a freshly-resent code would be
    // orphaned by an already-expired challenge token. The row's own
    // expiry/attempt/resend caps + throttles bound the actual window. [SEC P3-4]
    return this.jwtService.sign(
      { sub: challengeId, purpose: 'citizen-reg-challenge' } satisfies RegChallengePayload,
      { secret: this.citizenSecret, expiresIn: '30m' },
    );
  }

  private timingSafeHexEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }

  // ===================================================================
  //  1) Request a code (anti-enum, uniform)
  // ===================================================================

  /**
   * ALWAYS resolves without throwing (anti-enumeration). Normalizes the email,
   * does ONE indexed identity lookup to pick the branch, and returns a uniform
   * `{ challengeToken, expiresInSec, resendCooldownSec }`:
   *   (a) email NOT registered → store the REAL code_hash + email the 6-digit OTP.
   *   (b) email ALREADY registered → store a random DECOY code_hash (never
   *       emailed, can never be verified) + email an "account already exists"
   *       notice instead. Same lookups + same row shape as (a).
   *
   * Anti-mailbomb: if an active (unexpired, unconsumed) challenge already exists
   * for the same email, the row is REUSED (rotated) rather than duplicated; a
   * (re)issue within the 60s cooldown reuses the existing code + suppresses the
   * email. Both emails are fire-and-forget so neither branch is the slow outlier.
   */
  async requestOtp(
    email: string,
    ip: string | null,
    userAgent: string | null,
  ): Promise<{
    challengeToken: string;
    expiresInSec: number;
    resendCooldownSec: number;
  }> {
    const emailNorm = email.trim().toLowerCase();
    const emailHashed = hashEmail(emailNorm);
    const now = new Date();

    // ONE indexed lookup decides the branch (registered vs not). Nothing about
    // the result changes the SHAPE of the work below (same insert/rotate + same
    // fire-and-forget email), only WHICH code_hash is stored and WHICH template
    // is sent — so the response is indistinguishable either way.
    const existing = await this.identityRepo.findOne({
      where: { emailHash: emailHashed },
    });
    const isNew = !existing;

    // Reuse an active challenge for this email (anti-mailbomb / stable handle).
    const active = await this.otpRepo.findOne({
      where: {
        emailHash: emailHashed,
        consumedAt: IsNull(),
        expiresAt: MoreThan(now),
      },
      order: { createdAt: 'DESC' },
    });

    let challengeId: string;
    let code: string | null = null; // the code to email (null → suppress)

    if (active) {
      challengeId = active.challengeId;
      const lastIssuedMs = active.expiresAt.getTime() - OTP_TTL_MS;
      const withinCooldown =
        lastIssuedMs > now.getTime() - OTP_RESEND_COOLDOWN_MS;
      if (!withinCooldown) {
        // Past the cooldown → rotate a fresh code on the SAME row (new hash,
        // fresh TTL, reset attempts, clear any stale verified mark). `consumedAt:
        // IsNull()` guards a race with a concurrent complete/burn.
        code = this.generateCode();
        await this.otpRepo.update(
          { id: active.id, consumedAt: IsNull() },
          {
            codeHash: isNew ? hashSecret(code) : hashSecret(this.decoySecret()),
            expiresAt: new Date(now.getTime() + OTP_TTL_MS),
            verifiedAt: null,
            attemptCount: 0,
          },
        );
      }
      // Within the cooldown → reuse the existing code, suppress the email.
    } else {
      challengeId = randomBytes(32).toString('base64url');
      code = this.generateCode();
      await this.otpRepo.insert({
        challengeId,
        emailHash: emailHashed,
        emailEnc: await encryption(emailNorm),
        codeHash: isNew ? hashSecret(code) : hashSecret(this.decoySecret()),
        expiresAt: new Date(now.getTime() + OTP_TTL_MS),
        verifiedAt: null,
        consumedAt: null,
        attemptCount: 0,
        resendCount: 0,
        requestIp: ip ? ip.slice(0, 45) : null,
        requestUserAgent: userAgent ? userAgent.slice(0, 256) : null,
      });
    }

    // Fire-and-forget (timing parity + never leak deliverability). Neither
    // branch awaits SMTP, so the response time never distinguishes them.
    if (code !== null) {
      if (isNew) {
        const plainCode = code;
        void this.sendSignupOtpEmail(emailNorm, plainCode).catch((err) => {
          this.logger.warn(
            `citizen.register_otp.email_failed reason=signup ` +
              `err=${(err as Error)?.constructor?.name ?? 'UnknownError'}`,
          );
        });
      } else {
        void this.sendAlreadyRegisteredEmail(emailNorm).catch((err) => {
          this.logger.warn(
            `citizen.register_otp.email_failed reason=exists ` +
              `err=${(err as Error)?.constructor?.name ?? 'UnknownError'}`,
          );
        });
      }
    }

    // PII discipline — NEVER log the email / code; only the opaque challenge id.
    this.logger.log(
      `citizen.register_otp.requested cid=${challengeId} at=${now.toISOString()}`,
    );

    return {
      challengeToken: this.signChallengeToken(challengeId),
      expiresInSec: OTP_TTL_SEC,
      resendCooldownSec: OTP_RESEND_COOLDOWN_SEC,
    };
  }

  /** A never-emailed random secret whose HMAC is stored for the existing-email
   *  branch, so an existing account produces an indistinguishable, unverifiable row. */
  private decoySecret(): string {
    return randomBytes(32).toString('hex');
  }

  // ===================================================================
  //  2) Verify a code → issue the registration token
  // ===================================================================

  /**
   * Redeems the 6-digit code against the challenge and proves email ownership.
   * EVERY failure branch throws the SAME generic 401 (`GENERIC_VERIFY_ERROR`) —
   * never distinguish bad-token / not-found / expired / consumed /
   * already-verified / attempt-cap / wrong-code. On success sets `verified_at`
   * and returns a short-lived `registrationToken`.
   */
  async verifyOtp(
    challengeToken: string,
    code: string,
  ): Promise<{ registrationToken: string; registrationTokenTtlSec: number }> {
    let payload: RegChallengePayload;
    try {
      payload = this.jwtService.verify<RegChallengePayload>(challengeToken, {
        secret: this.citizenSecret,
      });
    } catch {
      throw new UnauthorizedException(GENERIC_VERIFY_ERROR);
    }
    if (payload.purpose !== 'citizen-reg-challenge' || !payload.sub) {
      throw new UnauthorizedException(GENERIC_VERIFY_ERROR);
    }

    const now = new Date();
    const row = await this.otpRepo.findOne({
      where: { challengeId: payload.sub },
    });
    if (
      !row ||
      row.consumedAt ||
      row.verifiedAt ||
      row.expiresAt.getTime() < now.getTime() ||
      row.attemptCount >= OTP_MAX_ATTEMPTS
    ) {
      throw new UnauthorizedException(GENERIC_VERIFY_ERROR);
    }

    // Timing-safe HMAC compare (both are 64-char hex → equal length). The
    // existing-email DECOY branch stores a random hash, so its compare always
    // fails here → the same generic 401 → indistinguishable from a wrong code.
    const ok = this.timingSafeHexEqual(hashSecret(code), row.codeHash);
    if (!ok) {
      // Atomic increment so concurrent wrong-code requests can't each act on a
      // stale attemptCount and slip past the cap; re-read to decide the burn.
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
        // Tamper-evident trace of an anonymous pre-registration brute-force.
        // No identity exists yet → actorKind 'anon', null actorId; no PII in
        // detail (challengeId is a random token, not personal data). Best-effort
        // — a logging failure must never turn a wrong-code 401 into a 500. [SEC P3-3]
        if (lock.affected) {
          try {
            await this.otpRepo.manager.getRepository(CitizenAuditLog).insert({
              actorKind: 'anon',
              actorId: null,
              action: 'register_otp_lockout',
              targetKind: 'registration',
              targetId: null,
              detail: { reason: 'attempt_cap_burn', cid: row.challengeId },
            });
          } catch {
            /* audit is best-effort; never block the auth response */
          }
        }
      }
      throw new UnauthorizedException(GENERIC_VERIFY_ERROR);
    }

    // Race-safe verified-mark: two concurrent verifies race on this UPDATE; the
    // loser sees 0 rows affected and aborts. Only an unconsumed, not-yet-verified
    // row can be marked (so a decoy that somehow matched still could not proceed
    // — but it never matches).
    const mark = await this.otpRepo.update(
      { id: row.id, consumedAt: IsNull(), verifiedAt: IsNull() },
      { verifiedAt: now },
    );
    if (!mark.affected) {
      throw new UnauthorizedException(GENERIC_VERIFY_ERROR);
    }

    const registrationToken = this.jwtService.sign(
      {
        sub: row.challengeId,
        purpose: 'citizen-registration',
        eh: row.emailHash,
      } satisfies RegistrationTokenPayload,
      { secret: this.citizenSecret, expiresIn: '10m' },
    );

    this.logger.log(
      `citizen.register_otp.verified cid=${row.challengeId} at=${now.toISOString()}`,
    );

    return {
      registrationToken,
      registrationTokenTtlSec: REGISTRATION_TOKEN_TTL_SEC,
    };
  }

  // ===================================================================
  //  3) Resend a code (rotate on the SAME challenge)
  // ===================================================================

  /**
   * Re-issues a fresh code on the SAME challenge row (so the caller's
   * `challengeToken` stays valid). ALWAYS resolves to the uniform
   * `{ ok:true, resendCooldownSec }` — silent no-op on bad token / expired /
   * consumed / already-verified / cooldown / resend-cap (anti-enumeration +
   * anti-mailbomb). Only the signup (not-registered) branch ever re-emails a
   * code; the decoy (existing-email) branch has no code to send so stays silent.
   */
  async resend(
    challengeToken: string,
  ): Promise<{ ok: true; resendCooldownSec: number }> {
    const uniform = {
      ok: true as const,
      resendCooldownSec: OTP_RESEND_COOLDOWN_SEC,
    };

    let payload: RegChallengePayload;
    try {
      payload = this.jwtService.verify<RegChallengePayload>(challengeToken, {
        secret: this.citizenSecret,
      });
    } catch {
      return uniform; // silent
    }
    if (payload.purpose !== 'citizen-reg-challenge' || !payload.sub) {
      return uniform;
    }

    const now = new Date();
    const row = await this.otpRepo.findOne({
      where: { challengeId: payload.sub },
    });
    if (
      !row ||
      row.consumedAt ||
      row.verifiedAt ||
      row.expiresAt.getTime() < now.getTime()
    ) {
      return uniform;
    }
    if (row.resendCount >= OTP_MAX_RESENDS) {
      return uniform; // cap reached — silent
    }

    // Cooldown: each (re)issue sets `expires_at = issuedAt + TTL`. Suppress if
    // the last issue is within the cooldown window.
    const lastIssuedMs = row.expiresAt.getTime() - OTP_TTL_MS;
    if (lastIssuedMs > now.getTime() - OTP_RESEND_COOLDOWN_MS) {
      return uniform; // still cooling down — silent
    }

    // Is this email registered? (Same anti-enum decision as requestOtp — a
    // registered email keeps a decoy hash and is never re-emailed a code.)
    const existing = await this.identityRepo.findOne({
      where: { emailHash: row.emailHash },
    });
    const isNew = !existing;

    const code = this.generateCode();
    const rotated = await this.otpRepo.update(
      { id: row.id, consumedAt: IsNull(), verifiedAt: IsNull() },
      {
        codeHash: isNew ? hashSecret(code) : hashSecret(this.decoySecret()),
        expiresAt: new Date(now.getTime() + OTP_TTL_MS),
        attemptCount: 0,
        resendCount: row.resendCount + 1,
      },
    );
    if (!rotated.affected) {
      return uniform; // lost the race — silent
    }

    // Decrypt the recipient UNCONDITIONALLY (never log / retain it) so the
    // scrypt-backed KDF cost is identical for registered and unregistered
    // emails. A registered email is never re-emailed a code, but it must pay
    // the same decrypt cost — otherwise resend response time is an
    // enumeration oracle (registered = fast, unregistered = slow). [SEC P1-1]
    let recipient: string | null = null;
    try {
      recipient = await decryption(row.emailEnc);
    } catch {
      recipient = null;
    }
    if (isNew && recipient) {
      const plainCode = code;
      void this.sendSignupOtpEmail(recipient, plainCode).catch((err) => {
        this.logger.warn(
          `citizen.register_otp.resend_email_failed ` +
            `err=${(err as Error)?.constructor?.name ?? 'UnknownError'}`,
        );
      });
    }

    this.logger.log(
      `citizen.register_otp.resent cid=${row.challengeId} at=${now.toISOString()}`,
    );
    return uniform;
  }

  // ===================================================================
  //  4) Complete — create the identity + mint the session
  // ===================================================================

  /**
   * Redeems the `registrationToken` (email already verified), creates the
   * `citizen_identities` row, and mints the real 30-day session. EVERY token
   * failure throws the SAME generic error (`GENERIC_COMPLETE_ERROR`). The row is
   * burned single-use inside the transaction (race-safe), and a concurrent
   * duplicate-email create is backstopped by the 23505 unique-violation catch.
   */
  async complete(
    registrationToken: string,
    input: { password: string; displayName?: string; consentAccepted: boolean },
    ip: string | null = null,
    userAgent: string | null = null,
  ): Promise<{ accessToken: string; profile: CitizenProfile }> {
    if (input.consentAccepted !== true) {
      throw new BadRequestException(
        'ต้องยอมรับนโยบายความเป็นส่วนตัวก่อนสมัครสมาชิก',
      );
    }

    let payload: RegistrationTokenPayload;
    try {
      payload = this.jwtService.verify<RegistrationTokenPayload>(
        registrationToken,
        { secret: this.citizenSecret },
      );
    } catch {
      throw new UnauthorizedException(GENERIC_COMPLETE_ERROR);
    }
    if (payload.purpose !== 'citizen-registration' || !payload.sub) {
      throw new UnauthorizedException(GENERIC_COMPLETE_ERROR);
    }

    const now = new Date();
    const row = await this.otpRepo.findOne({
      where: { challengeId: payload.sub },
    });
    // Must exist, be verified, not yet consumed, and its email_hash must match
    // the token's `eh` claim (defensive — the token can't be swapped onto a
    // different challenge row).
    if (
      !row ||
      !row.verifiedAt ||
      row.consumedAt ||
      row.emailHash !== payload.eh
    ) {
      throw new UnauthorizedException(GENERIC_COMPLETE_ERROR);
    }

    // Hash the password OUTSIDE the transaction (Argon2 is ~hundreds of ms; keep
    // the DB transaction short). The decrypt is needed for the fallback alias.
    const passwordHash = await this.argon2.hash(input.password);
    let emailNorm: string;
    try {
      emailNorm = await decryption(row.emailEnc);
    } catch {
      throw new UnauthorizedException(GENERIC_COMPLETE_ERROR);
    }
    const alias = input.displayName
      ? this.maskAlias(input.displayName)
      : this.aliasFromEmail(emailNorm);

    let saved: CitizenIdentity;
    try {
      saved = await this.dataSource.transaction(async (em) => {
        const otpRepo = em.getRepository(CitizenRegistrationOtp);
        const idRepo = em.getRepository(CitizenIdentity);

        // Burn THIS row FIRST, conditioned on it still being VERIFIED + unconsumed,
        // requiring exactly one affected row. Two concurrent completes race here;
        // the loser sees 0 rows affected and aborts (rolls back), so the identity
        // is created exactly once.
        const burn = await otpRepo.update(
          { id: row.id, verifiedAt: Not(IsNull()), consumedAt: IsNull() },
          { consumedAt: now },
        );
        if (!burn.affected) {
          throw new UnauthorizedException(GENERIC_COMPLETE_ERROR);
        }

        const identity = idRepo.create({
          emailEnc: row.emailEnc,
          emailHash: row.emailHash,
          passwordHash,
          authProvider: 'password',
          displayAlias: alias,
          status: 'active',
          // Email is ALREADY verified — the OTP proved inbox control (step 2).
          emailVerifiedAt: now,
          consentVersion: CONSENT_VERSION,
          consentAt: now,
          lastLoginAt: now,
        });
        const persisted = await idRepo.save(identity);

        // Append-only audit — no PII in `detail`, only the identity uuid.
        await em.getRepository(CitizenAuditLog).insert({
          actorKind: 'citizen',
          actorId: persisted.id,
          action: 'register_completed',
          targetKind: 'identity',
          targetId: persisted.id,
          detail: { via: 'verify_first' },
        });

        return persisted;
      });
    } catch (error) {
      // Race backstop: a concurrent create of the same email hits the partial
      // unique on email_hash. Surface the SAME generic error (never leak that
      // the account now exists).
      if ((error as { code?: string }).code === '23505') {
        throw new UnauthorizedException(GENERIC_COMPLETE_ERROR);
      }
      throw error;
    }

    // Batch 2 — record the per-session row (flag-gated). This is a first-ever
    // session for a just-created identity, so the mint helper NEVER fires a
    // new-device alert here (no "new sign-in" email on signup).
    const sid = await this.sessionMint.establish({
      identity: saved,
      loginMethod: 'register',
      ip,
      userAgent,
    });

    this.logger.log(
      `citizen.register.completed identityId=${saved.id} at=${now.toISOString()}`,
    );

    return {
      accessToken: this.signSession(saved, sid),
      profile: this.toProfile(saved),
    };
  }

  // ===================================================================
  //  Email templates (self-contained — §17.3, no staff-template coupling)
  // ===================================================================

  private async sendSignupOtpEmail(
    recipient: string,
    code: string,
  ): Promise<void> {
    const alias = this.aliasFromEmail(recipient);
    const subject = '[หนองกระทุ่ม] รหัสยืนยันการสมัครบัญชีประชาชน';

    const text =
      `เรียน ${alias}\n\n` +
      `รหัสยืนยันการสมัครบัญชีประชาชนกับเทศบาลตำบลหนองกระทุ่มของท่านคือ:\n\n` +
      `${code}\n\n` +
      `รหัสนี้จะหมดอายุใน 5 นาที\n\n` +
      `หากท่านไม่ได้เป็นผู้ร้องขอ โปรดละเว้นอีเมลฉบับนี้\n\n` +
      `ด้วยความเคารพ\nเทศบาลตำบลหนองกระทุ่ม`;

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
      `<tr><td align="center" style="padding:40px 40px 0 40px;">` +
      `<div style="font-size:26px;font-weight:700;color:#2563eb;letter-spacing:0.5px;line-height:1;">แผนชัด</div>` +
      `<div style="font-size:13px;color:#5f6368;margin-top:6px;">ระบบแผนชัด (PlanCHATT) &middot; เทศบาลตำบลหนองกระทุ่ม</div>` +
      `</td></tr>` +
      `<tr><td style="padding:24px 40px 0 40px;"><div style="border-top:1px solid #e8eaed;font-size:0;line-height:0;">&nbsp;</div></td></tr>` +
      `<tr><td style="padding:24px 40px 8px 40px;">` +
      `<h1 style="font-size:18px;font-weight:600;color:#202124;margin:0 0 16px 0;line-height:1.5;">รหัสยืนยันการสมัครบัญชีประชาชน</h1>` +
      `<p style="font-size:14px;line-height:1.7;margin:0 0 4px 0;color:#202124;">เรียน ${safeAlias}</p>` +
      `<p style="font-size:14px;line-height:1.7;margin:0 0 20px 0;color:#3c4043;">` +
      `กรุณากรอกรหัสยืนยัน 6 หลักด้านล่างเพื่อยืนยันอีเมลและสมัครบัญชีประชาชนกับเทศบาลตำบลหนองกระทุ่ม</p>` +
      `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;"><tr><td ` +
      `style="border-radius:8px;background-color:#f1f5f9;border:1px solid #e2e8f0;padding:16px 28px;">` +
      `<div style="font-family:'Courier New',Consolas,monospace;font-size:34px;font-weight:700;` +
      `letter-spacing:10px;color:#111827;text-align:center;line-height:1;">${safeCode}</div>` +
      `</td></tr></table>` +
      `<p style="font-size:13px;line-height:1.6;margin:0 0 6px 0;color:#3c4043;">` +
      `<strong>หมดอายุใน 5 นาที</strong> &middot; หากไม่ใช่ท่าน โปรดละเว้น</p>` +
      `</td></tr>` +
      `<tr><td style="padding:8px 40px 0 40px;"><div style="border-top:1px solid #e8eaed;font-size:0;line-height:0;">&nbsp;</div></td></tr>` +
      `<tr><td align="center" style="padding:20px 40px 32px 40px;">` +
      `<p style="font-size:12px;color:#5f6368;line-height:1.6;margin:0;">` +
      `อีเมลนี้ถูกส่งจากระบบแผนชัด (PlanCHATT) โดยอัตโนมัติ กรุณาอย่าตอบกลับอีเมลฉบับนี้</p>` +
      `<p style="font-size:12px;color:#5f6368;line-height:1.6;margin:8px 0 0 0;">` +
      `เทศบาลตำบลหนองกระทุ่ม อำเภอเมืองนครราชสีมา จังหวัดนครราชสีมา</p>` +
      `</td></tr>` +
      `</table></td></tr></table></body></html>`;

    await this.emailService.sendEmail({ to: recipient, subject, text, html });
  }

  private async sendAlreadyRegisteredEmail(recipient: string): Promise<void> {
    const alias = this.aliasFromEmail(recipient);
    const subject = '[หนองกระทุ่ม] บัญชีประชาชนนี้มีอยู่แล้ว';

    const base = CitizenRegistrationOtpService.resolveFrontendBase().replace(
      /\/+$/,
      '',
    );
    const loginUrl = `${base}/citizen/login`;
    const resetUrl = `${base}/citizen/forgot-password`;

    const text =
      `เรียน ${alias}\n\n` +
      `มีการพยายามสมัครบัญชีประชาชนกับเทศบาลตำบลหนองกระทุ่มด้วยอีเมลนี้ ` +
      `แต่อีเมลนี้ถูกใช้สมัครไว้แล้ว\n\n` +
      `หากเป็นท่าน กรุณาเข้าสู่ระบบที่:\n${loginUrl}\n\n` +
      `หากลืมรหัสผ่าน กรุณารีเซ็ตรหัสผ่านที่:\n${resetUrl}\n\n` +
      `หากท่านไม่ได้เป็นผู้ร้องขอ โปรดละเว้นอีเมลฉบับนี้\n\n` +
      `ด้วยความเคารพ\nเทศบาลตำบลหนองกระทุ่ม`;

    const safeAlias = this.escapeHtml(alias);
    const safeLoginUrl = this.escapeHtml(loginUrl);
    const safeResetUrl = this.escapeHtml(resetUrl);
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
      `<tr><td align="center" style="padding:40px 40px 0 40px;">` +
      `<div style="font-size:26px;font-weight:700;color:#2563eb;letter-spacing:0.5px;line-height:1;">แผนชัด</div>` +
      `<div style="font-size:13px;color:#5f6368;margin-top:6px;">ระบบแผนชัด (PlanCHATT) &middot; เทศบาลตำบลหนองกระทุ่ม</div>` +
      `</td></tr>` +
      `<tr><td style="padding:24px 40px 0 40px;"><div style="border-top:1px solid #e8eaed;font-size:0;line-height:0;">&nbsp;</div></td></tr>` +
      `<tr><td style="padding:24px 40px 8px 40px;">` +
      `<h1 style="font-size:18px;font-weight:600;color:#202124;margin:0 0 16px 0;line-height:1.5;">บัญชีประชาชนนี้มีอยู่แล้ว</h1>` +
      `<p style="font-size:14px;line-height:1.7;margin:0 0 4px 0;color:#202124;">เรียน ${safeAlias}</p>` +
      `<p style="font-size:14px;line-height:1.7;margin:0 0 20px 0;color:#3c4043;">` +
      `มีการพยายามสมัครบัญชีประชาชนกับเทศบาลตำบลหนองกระทุ่มด้วยอีเมลนี้ แต่อีเมลนี้ถูกใช้สมัครไว้แล้ว ` +
      `หากเป็นท่าน กรุณาเข้าสู่ระบบด้วยปุ่มด้านล่าง</p>` +
      `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px 0;"><tr><td ` +
      `style="border-radius:8px;background-color:#2563eb;"><a href="${safeLoginUrl}" ` +
      `style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;` +
      `text-decoration:none;border-radius:8px;">เข้าสู่ระบบ</a></td></tr></table>` +
      `<p style="font-size:13px;line-height:1.6;margin:0 0 6px 0;color:#3c4043;">` +
      `หากลืมรหัสผ่าน <a href="${safeResetUrl}" style="color:#2563eb;text-decoration:none;">รีเซ็ตรหัสผ่าน</a></p>` +
      `<p style="font-size:13px;line-height:1.6;margin:0;color:#5f6368;">` +
      `หากท่านไม่ได้เป็นผู้ร้องขอ โปรดละเว้นอีเมลฉบับนี้</p>` +
      `</td></tr>` +
      `<tr><td style="padding:8px 40px 0 40px;"><div style="border-top:1px solid #e8eaed;font-size:0;line-height:0;">&nbsp;</div></td></tr>` +
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
}
