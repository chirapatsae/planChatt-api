import {
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as jwt from 'jsonwebtoken';
import { Repository } from 'typeorm';

import { hashCitizenId, hashSecret } from 'src/util/encryption.util';
import { CitizenIdentity } from '../entities/citizen-identity.entity';

const THAID_ISSUER = 'https://imauth.bora.dopa.go.th';
const CONSENT_VERSION = 'v1';
/** Clock-skew tolerance (seconds) when an `exp` claim is present. */
const THAID_EXP_CLOCK_TOLERANCE_SEC = 60;

/**
 * Public citizen identity returned to the FE. Carries NO national ID / real
 * name — `displayAlias` is the only name (plan D4, alias-only privacy).
 */
export interface CitizenProfile {
  id: string;
  displayAlias: string;
}

/**
 * CitizenAuthService — ThaID login for the CIVIC CITIZEN identity.
 *
 * Reuses the SAME production-proven principle as the internal staff login
 * (`AuthService.handleOAuthLogin`, auth.service.ts:26): the FE supplies the
 * ThaID `id_token`, the BE decodes it and validates `iss`, then maps the
 * national ID via `hashCitizenId`. This means NO separate ThaID OIDC client
 * needs provisioning — the citizen path rides the existing production ThaID.
 *
 * The SEPARATION (plan D1/D2) is in the identity STORE and the TOKEN:
 *  - upserts `citizen_identities` (NOT `users` / `work_history`),
 *  - issues a JWT with `aud:'citizen'` signed by `CITIZEN_JWT_SECRET`,
 *  - carries NO `role` / `workStatus` (a citizen is never internal).
 *
 * PII (PDPA / plan D4): stores only `national_id_hash` + `thaid_sub_hash` +
 * a masked `display_alias`. `national_id_enc` / `full_name_enc` stay NULL.
 */
@Injectable()
export class CitizenAuthService {
  private readonly logger = new Logger(CitizenAuthService.name);

  constructor(
    @InjectRepository(CitizenIdentity)
    private readonly identityRepo: Repository<CitizenIdentity>,
    private readonly jwtService: JwtService,
  ) {}

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

  private toProfile(identity: CitizenIdentity): CitizenProfile {
    return { id: identity.id, displayAlias: identity.displayAlias };
  }

  private sign(identity: CitizenIdentity): string {
    return this.jwtService.sign(
      {
        sub: identity.id,
        typ: 'citizen',
        loginMethod: 'thaid',
        sessionVersion: identity.sessionVersion ?? 0,
      },
      { secret: this.citizenSecret, expiresIn: '30d', audience: 'citizen' },
    );
  }

  /**
   * Decode the ThaID id_token, upsert the citizen identity, and issue a
   * citizen session token. Same decode+iss validation as the staff path.
   */
  async loginWithThaid(idToken: string): Promise<{ accessToken: string; profile: CitizenProfile }> {
    // ---------------------------------------------------------------------
    // CONFIG-GATED SIGNATURE-VERIFY SEAM (Q-COMM-1, follow-up).
    // We currently DECODE-ONLY (no RS256 signature check), matching the
    // production-proven staff ThaID path. Full JWKS signature verification is
    // a documented follow-up: it requires a NEW dependency (`jose` or
    // `jwks-rsa`) plus the DOPA JWKS endpoint, read from env `THAID_JWKS_URI`.
    // When that lands, verify the RS256 signature against the JWKS HERE, at the
    // decode site, BEFORE trusting any claim below. Until then the exp/iss/pid
    // claim checks are the only hardening on the token.
    // ---------------------------------------------------------------------
    const decoded = jwt.decode(idToken) as Record<string, unknown> | null;
    if (!decoded?.sub || decoded.iss !== THAID_ISSUER) {
      // W-OBS-1 — PII-safe: reason code + timestamp only, never the token.
      this.logger.warn(
        `citizen.thaid.login.reject reason=invalid_sub_or_iss at=${new Date().toISOString()}`,
      );
      throw new UnauthorizedException('Invalid id_token');
    }
    // W-SEC-1 — reject ONLY when `exp` is present AND already past (with a
    // small clock tolerance). `exp` absent is still allowed, preserving the
    // decode-only "matches production" contract and the dev test id_tokens.
    if (typeof decoded.exp === 'number') {
      const nowSec = Math.floor(Date.now() / 1000);
      if (decoded.exp + THAID_EXP_CLOCK_TOLERANCE_SEC < nowSec) {
        this.logger.warn(
          `citizen.thaid.login.reject reason=expired_exp at=${new Date().toISOString()}`,
        );
        throw new UnauthorizedException('Expired id_token');
      }
    }
    const pid = typeof decoded.pid === 'string' ? decoded.pid : '';
    if (!pid) {
      this.logger.warn(
        `citizen.thaid.login.reject reason=missing_pid at=${new Date().toISOString()}`,
      );
      throw new UnauthorizedException('Missing pid in id_token');
    }

    const thaidSubHash = hashSecret(String(decoded.sub));
    const nationalIdHash = hashCitizenId(pid);

    let identity = await this.identityRepo.findOne({ where: { thaidSubHash } });

    if (!identity) {
      identity = this.identityRepo.create({
        thaidSubHash,
        nationalIdHash,
        // national_id_enc / full_name_enc intentionally left NULL (plan D4).
        displayAlias: this.maskAlias(
          decoded.given_name as string | undefined,
          decoded.family_name as string | undefined,
        ),
        status: 'active',
        consentVersion: CONSENT_VERSION,
        consentAt: new Date(),
        lastLoginAt: new Date(),
      });
      try {
        identity = await this.identityRepo.save(identity);
      } catch (error) {
        // Race on the partial-unique (thaid_sub_hash) — re-fetch.
        if ((error as { code?: string }).code === '23505') {
          identity = await this.identityRepo.findOne({ where: { thaidSubHash } });
          if (!identity) {
            throw new InternalServerErrorException('Citizen identity upsert race could not resolve');
          }
        } else {
          throw error;
        }
      }
    } else {
      identity.lastLoginAt = new Date();
      identity = await this.identityRepo.save(identity);
    }

    // PII discipline — never log the pid / name / token; only the uuid.
    this.logger.log(`citizen.thaid.login identityId=${identity.id} at=${new Date().toISOString()}`);

    return { accessToken: this.sign(identity), profile: this.toProfile(identity) };
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
