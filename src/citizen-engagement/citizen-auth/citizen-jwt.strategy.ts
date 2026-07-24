import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Repository } from 'typeorm';

import { CitizenIdentity } from '../entities/citizen-identity.entity';
import { CitizenSessionRegistryService } from './citizen-session-registry.service';
import { sessionRegistryEnabled } from '../../common/session-registry/session-registry.flag';

/** `req.user` shape for an authenticated CITIZEN (never carries `role`). */
export interface CitizenJwtUser {
  identityId: string;
  // AUTH-REDESIGN (2026-07-08): ThaID removed → 'password' | 'google'.
  // Kept as a widened string so in-flight pre-redesign tokens still parse.
  loginMethod: string;
  sessionVersion: number;
  aud: 'citizen';
  // Per-session id (login-alerts / device-session-management). Optional so
  // legacy tokens minted BEFORE the registry landed (no `sid`) still parse and
  // authenticate during rollout. Attached to `req.user` so device-manager
  // controllers can identify the CURRENT session.
  sid?: string;
}

/**
 * CitizenJwtStrategy — validates the `aud:'citizen'` token signed by
 * CITIZEN_JWT_SECRET. Registered under the named strategy `'citizen-jwt'` so it
 * is completely separate from the internal `'jwt'` strategy.
 *
 * Dual-identity cross-rejection (plan D2): the `audience: 'citizen'` option
 * makes passport-jwt REJECT any token without `aud:'citizen'` (i.e. every
 * internal staff token), and the distinct secret rejects it at the signature
 * layer too. The internal `JwtStrategy` symmetrically rejects `aud:'citizen'`.
 *
 * BE-5 session revocation: `validate()` loads the identity by PK (single
 * indexed lookup) and rejects the token if the identity is missing, its
 * `session_version` no longer matches the token's, or the account is
 * unambiguously dead (`blocked` / `deleted`) — so bumping `session_version`
 * (e.g. after a password reset) revokes ALL issued tokens.
 *
 * `suspended` is DELIBERATELY passed through here: the W-T3 offender ladder
 * keeps a suspended citizen's session valid (they may still READ) and the
 * strict `CitizenJwtGuard` owns the distinct 403 `CITIZEN_SUSPENDED` on the
 * WRITE surfaces. Rejecting `suspended` in the strategy would collapse that
 * nuance to a 401 and drop the viewer's read personalization under the
 * optional guard — so we scope the status gate to blocked/deleted only.
 */
@Injectable()
export class CitizenJwtStrategy extends PassportStrategy(Strategy, 'citizen-jwt') {
  constructor(
    @InjectRepository(CitizenIdentity)
    private readonly identityRepo: Repository<CitizenIdentity>,
    private readonly citizenSessionRegistry: CitizenSessionRegistryService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey:
        process.env.CITIZEN_JWT_SECRET || process.env.JWT_SECRET || 'defaultSecret',
      audience: 'citizen',
    });
  }

  async validate(payload: any): Promise<CitizenJwtUser> {
    // Belt-and-suspenders even if secrets ever coincide across envs.
    if (payload.aud !== 'citizen') {
      throw new UnauthorizedException('Wrong token audience');
    }

    const tokenSessionVersion = payload.sessionVersion ?? 0;

    // BE-5 — enforce session revocation. Single PK lookup; runs on every
    // citizen-authenticated request (only when a token is present). Select
    // just the columns we need.
    const identity = await this.identityRepo.findOne({
      where: { id: payload.sub },
      select: { id: true, status: true, sessionVersion: true },
    });
    // SEC F6 — explicit ALLOW-list (fail-closed as the status enum grows):
    // only 'active' + 'suspended' pass the strategy. The strict write-guard
    // still owns the suspended 403 and the optional guard only narrows a
    // suspended viewer's reads; every other/unknown status (blocked, deleted,
    // or any future value) is rejected here.
    const statusOk =
      identity?.status === 'active' || identity?.status === 'suspended';
    if (
      !identity ||
      !statusOk ||
      (identity.sessionVersion ?? 0) !== tokenSessionVersion
    ) {
      throw new UnauthorizedException('Citizen session is no longer valid');
    }

    // Per-session revocation (login-alerts / device-session-management).
    // Flag-gated + legacy-safe: only enforced when SESSION_REGISTRY_ENABLED is
    // exactly 'true' AND the token actually carries a `sid`. Flag OFF or a
    // legacy token (no `sid`) ⇒ this is a no-op and behavior is UNCHANGED.
    if (sessionRegistryEnabled() && payload.sid) {
      await this.citizenSessionRegistry.assertCitizenActive(
        payload.sid,
        identity.id,
      );
    }

    return {
      identityId: payload.sub,
      loginMethod: payload.loginMethod ?? 'password',
      sessionVersion: tokenSessionVersion,
      aud: 'citizen',
      // Surface the current session id to controllers (undefined for legacy
      // tokens). Present regardless of the flag so Batch 2's device-manager can
      // still identify "this device" once minting embeds `sid`.
      ...(payload.sid ? { sid: payload.sid } : {}),
    };
  }
}
