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
  loginMethod: 'thaid' | 'backup';
  mfaVerified: boolean;
  sessionVersion: number;
  requirePasswordChange: boolean;
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
      loginMethod: payload.loginMethod ?? 'thaid',
      mfaVerified: payload.mfaVerified ?? true,
      sessionVersion: payload.sessionVersion ?? 0,
      requirePasswordChange: payload.requirePasswordChange ?? false,
      // `purpose` is set on the short-lived `mfaChallengeToken`; the
      // JwtAuthGuard rejects any token that carries a `purpose` claim
      // (those tokens are only consumed by `/complete` which verifies
      // them manually without the guard).
      ...(payload.purpose ? { purpose: payload.purpose } : {}),
    };
  }
}
