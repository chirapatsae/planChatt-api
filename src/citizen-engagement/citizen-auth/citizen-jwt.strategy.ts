import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

/** `req.user` shape for an authenticated CITIZEN (never carries `role`). */
export interface CitizenJwtUser {
  identityId: string;
  loginMethod: 'thaid';
  sessionVersion: number;
  aud: 'citizen';
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
 */
@Injectable()
export class CitizenJwtStrategy extends PassportStrategy(Strategy, 'citizen-jwt') {
  constructor() {
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
    return {
      identityId: payload.sub,
      loginMethod: 'thaid',
      sessionVersion: payload.sessionVersion ?? 0,
      aud: 'citizen',
    };
  }
}
