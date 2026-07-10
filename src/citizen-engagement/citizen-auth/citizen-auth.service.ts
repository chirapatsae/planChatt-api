import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OAuth2Client } from 'google-auth-library';

import { encryption, hashEmail, hashSecret } from 'src/util/encryption.util';
import { Argon2Service } from 'src/backup-login/argon2.service';
import { CitizenIdentity } from '../entities/citizen-identity.entity';
import { citizenAvatarUrl } from '../media/citizen-avatar.util';

/** Current privacy-policy version accepted at registration (PDPA). */
const CONSENT_VERSION = process.env.PRIVACY_POLICY_VERSION || 'v1';

/**
 * Public citizen identity returned to the FE. Carries NO national ID / real
 * name — `displayAlias` is the only name (plan D4, alias-only privacy).
 */
export interface CitizenProfile {
  id: string;
  displayAlias: string;
  /** Axios-relative profile-photo URL (cache-busted), or null when none. */
  avatarUrl: string | null;
  /** AUTH-REDESIGN — whether the login email has been verified. */
  emailVerified: boolean;
}

/**
 * CitizenAuthService — AUTH-REDESIGN (2026-07-08).
 *
 * ThaID is removed. Citizens now authenticate via:
 *   - self-registration (email + password), or
 *   - "Login with Google" (Google OIDC id_token, verified against JWKS).
 *
 * The SEPARATION (plan D1/D2) is preserved: this service upserts
 * `citizen_identities` (NEVER `users` / `work_history`), issues a JWT with
 * `aud:'citizen'` signed by `CITIZEN_JWT_SECRET`, and carries NO
 * `role` / `workStatus`.
 *
 * PDPA (plan D4 / §6): email is AES-encrypted at rest (`email_enc`) and
 * HMAC-indexed (`email_hash`); passwords are Argon2id; `national_id_enc` /
 * `full_name_enc` stay NULL. Consent version + timestamp are recorded.
 */
@Injectable()
export class CitizenAuthService {
  private readonly logger = new Logger(CitizenAuthService.name);
  private readonly googleClient: OAuth2Client;

  constructor(
    @InjectRepository(CitizenIdentity)
    private readonly identityRepo: Repository<CitizenIdentity>,
    private readonly jwtService: JwtService,
    private readonly argon2: Argon2Service,
  ) {
    this.googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
  }

  private get citizenSecret(): string {
    return process.env.CITIZEN_JWT_SECRET || process.env.JWT_SECRET || 'defaultSecret';
  }

  /** "สมชาย มานะ" → "สมชาย ม." — never expose the full family name. */
  private maskAlias(givenName?: string, familyName?: string): string {
    const given = (givenName ?? '').trim();
    const initial = (familyName ?? '').trim().charAt(0);
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

  private sign(identity: CitizenIdentity, loginMethod: 'password' | 'google'): string {
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

  /**
   * Reject any citizen whose account is not usable (blocked / suspended /
   * deleted). Mirrors the `status` CHECK on the entity.
   */
  private assertUsable(identity: CitizenIdentity): void {
    if (identity.status !== 'active') {
      throw new UnauthorizedException('บัญชีนี้ไม่สามารถใช้งานได้');
    }
  }

  // ===================================================================
  //  Registration (email/password)
  // ===================================================================

  async register(input: {
    email: string;
    password: string;
    displayName?: string;
    consentAccepted: boolean;
  }): Promise<{ accessToken: string; profile: CitizenProfile }> {
    if (!input.consentAccepted) {
      throw new BadRequestException('ต้องยอมรับนโยบายความเป็นส่วนตัวก่อนสมัครสมาชิก');
    }
    const emailNorm = input.email.trim().toLowerCase();
    const emailHashed = hashEmail(emailNorm);

    const existing = await this.identityRepo.findOne({
      where: { emailHash: emailHashed },
    });
    if (existing) {
      throw new ConflictException('อีเมลนี้ถูกใช้สมัครสมาชิกแล้ว');
    }

    const passwordHash = await this.argon2.hash(input.password);
    const emailEnc = await encryption(emailNorm);

    const identity = this.identityRepo.create({
      emailEnc,
      emailHash: emailHashed,
      passwordHash,
      authProvider: 'password',
      displayAlias: input.displayName
        ? this.maskAlias(input.displayName)
        : this.aliasFromEmail(emailNorm),
      status: 'active',
      // Email starts UNVERIFIED — a link-based verification flow is a
      // documented follow-up (docs/AUTH-REDESIGN.md §4.4).
      emailVerifiedAt: null,
      consentVersion: CONSENT_VERSION,
      consentAt: new Date(),
      lastLoginAt: new Date(),
    });

    let saved: CitizenIdentity;
    try {
      saved = await this.identityRepo.save(identity);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException('อีเมลนี้ถูกใช้สมัครสมาชิกแล้ว');
      }
      throw error;
    }

    // PII discipline — never log the email / password; only the uuid.
    this.logger.log(
      `citizen.register identityId=${saved.id} at=${new Date().toISOString()}`,
    );
    return { accessToken: this.sign(saved, 'password'), profile: this.toProfile(saved) };
  }

  // ===================================================================
  //  Login (email/password)
  // ===================================================================

  async login(input: {
    email: string;
    password: string;
  }): Promise<{ accessToken: string; profile: CitizenProfile }> {
    const emailNorm = input.email.trim().toLowerCase();
    const identity = await this.identityRepo.findOne({
      where: { emailHash: hashEmail(emailNorm) },
    });

    // Anti-enumeration: equalize timing on the not-found / no-password
    // branches with a dummy Argon2 verify, then return the SAME generic 401.
    if (!identity || !identity.passwordHash) {
      await this.argon2.verifyDummy(input.password);
      throw new UnauthorizedException('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    }

    const ok = await this.argon2.verify(identity.passwordHash, input.password);
    if (!ok) {
      throw new UnauthorizedException('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    }
    this.assertUsable(identity);

    identity.lastLoginAt = new Date();
    const saved = await this.identityRepo.save(identity);

    this.logger.log(
      `citizen.login identityId=${saved.id} at=${new Date().toISOString()}`,
    );
    return { accessToken: this.sign(saved, 'password'), profile: this.toProfile(saved) };
  }

  // ===================================================================
  //  Login with Google (OIDC)
  // ===================================================================

  async loginWithGoogle(
    idToken: string,
  ): Promise<{ accessToken: string; profile: CitizenProfile }> {
    if (!process.env.GOOGLE_CLIENT_ID) {
      this.logger.error('citizen.google.login GOOGLE_CLIENT_ID not configured');
      throw new InternalServerErrorException('Google login not configured');
    }

    let payload: import('google-auth-library').TokenPayload | undefined;
    try {
      const ticket = await this.googleClient.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch {
      this.logger.warn(
        `citizen.google.login.reject reason=verify_failed at=${new Date().toISOString()}`,
      );
      throw new UnauthorizedException('Google id_token ไม่ถูกต้อง');
    }

    if (!payload?.sub || payload.email_verified !== true || !payload.email) {
      this.logger.warn(
        `citizen.google.login.reject reason=invalid_payload at=${new Date().toISOString()}`,
      );
      throw new UnauthorizedException('บัญชี Google ไม่ผ่านการยืนยัน');
    }

    const googleSubHash = hashSecret(payload.sub);
    const emailNorm = payload.email.trim().toLowerCase();
    const emailHashed = hashEmail(emailNorm);

    // 1. Existing Google-linked identity → straight login.
    let identity = await this.identityRepo.findOne({ where: { googleSubHash } });

    // 2. Otherwise, link to an existing password account with the same email
    //    (non-destructive soft link → authProvider becomes 'both').
    if (!identity) {
      identity = await this.identityRepo.findOne({
        where: { emailHash: emailHashed },
      });
      if (identity) {
        identity.googleSubHash = googleSubHash;
        identity.authProvider = identity.passwordHash ? 'both' : 'google';
      }
    }

    // 3. Brand-new Google user → create identity (pre-verified email).
    if (!identity) {
      identity = this.identityRepo.create({
        googleSubHash,
        emailEnc: await encryption(emailNorm),
        emailHash: emailHashed,
        authProvider: 'google',
        displayAlias: this.maskAlias(payload.given_name, payload.family_name),
        status: 'active',
        emailVerifiedAt: new Date(),
        consentVersion: CONSENT_VERSION,
        consentAt: new Date(),
      });
    } else {
      // Google verifies the email → mark verified if not already.
      if (!identity.emailVerifiedAt) identity.emailVerifiedAt = new Date();
    }

    identity.lastLoginAt = new Date();

    let saved: CitizenIdentity;
    try {
      saved = await this.identityRepo.save(identity);
    } catch (error) {
      // Race on the partial-unique (google_sub_hash / email_hash) — re-fetch.
      if ((error as { code?: string }).code === '23505') {
        const resolved =
          (await this.identityRepo.findOne({ where: { googleSubHash } })) ??
          (await this.identityRepo.findOne({ where: { emailHash: emailHashed } }));
        if (!resolved) {
          throw new InternalServerErrorException('Citizen Google upsert race could not resolve');
        }
        saved = resolved;
      } else {
        throw error;
      }
    }
    this.assertUsable(saved);

    this.logger.log(
      `citizen.google.login identityId=${saved.id} at=${new Date().toISOString()}`,
    );
    return { accessToken: this.sign(saved, 'google'), profile: this.toProfile(saved) };
  }

  /** The authenticated citizen's own public profile. */
  async me(identityId: string): Promise<CitizenProfile> {
    const identity = await this.identityRepo.findOne({ where: { id: identityId } });
    if (!identity) {
      throw new UnauthorizedException('Citizen identity not found');
    }
    return this.toProfile(identity);
  }
}
