// jwt.strategy.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

/**
 * `req.user` shape populated by Passport after JWT validation.
 *
 * Wave wave-backup-login-thaid-fallback / BE-01 (SECURITY-01 §7.7,
 * §7.8, §7.11) — added `loginMethod`, `mfaVerified`, `sessionVersion`,
 * `requirePasswordChange`. Defaults preserve backward compatibility for
 * tokens issued BEFORE this wave landed (treated as ThaiD + MFA OK +
 * sessionVersion 0 + no required change).
 */
export interface JwtPayloadUser {
  userId: string;
  citizenId: string;
  role: string;
  // AUTH-REDESIGN (2026-07-08): 'password' is the new primary staff login
  // method (email + password + TOTP via the promoted backup-login pipeline).
  // 'thaid' / 'backup' retained ONLY for backward-compat with tokens issued
  // before ThaID removal; those expire within the session window.
  loginMethod: 'thaid' | 'backup' | 'password';
  mfaVerified: boolean;
  sessionVersion: number;
  requirePasswordChange: boolean;
  // Per-session id (login-alerts / device-session-management). Optional so
  // legacy tokens minted BEFORE the registry landed (no `sid`) still parse and
  // authenticate during rollout. Attached to `req.user` so the guard can
  // enforce per-session revocation and device-manager controllers can identify
  // the CURRENT session.
  sid?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'defaultSecret',
    });
  }

  async validate(payload: any): Promise<JwtPayloadUser & { purpose?: string }> {
    // Dual-identity cross-rejection (civic-community plan D2): a CITIZEN token
    // (aud:'citizen', issued by CitizenAuthService) MUST NEVER satisfy an
    // internal staff route, even if CITIZEN_JWT_SECRET ever coincides with
    // JWT_SECRET in some env. The citizen strategy symmetrically rejects
    // internal tokens via its `audience: 'citizen'` option.
    if (payload?.aud === 'citizen') {
      throw new UnauthorizedException('Wrong token audience');
    }
    return {
      userId: payload.sub,
      citizenId: payload.citizenId,
      role: payload.role,
      // Wave wave-backup-login-thaid-fallback / BE-01 — propagate the
      // new claims so guards can discriminate ThaiD vs backup sessions
      // and so `RequirePasswordChangeNotPendingGuard` can read the
      // forced-change flag.
      loginMethod: payload.loginMethod ?? 'password',
      mfaVerified: payload.mfaVerified ?? true,
      sessionVersion: payload.sessionVersion ?? 0,
      requirePasswordChange: payload.requirePasswordChange ?? false,
      // Surface the current session id to the guard + controllers (undefined
      // for legacy tokens minted before the registry landed).
      ...(payload.sid ? { sid: payload.sid } : {}),
      // `purpose` is set on the short-lived `mfaChallengeToken`; the
      // JwtAuthGuard rejects any token that carries a `purpose` claim
      // (those tokens are only consumed by `/complete` which verifies
      // them manually without the guard).
      ...(payload.purpose ? { purpose: payload.purpose } : {}),
    };
  }
}
