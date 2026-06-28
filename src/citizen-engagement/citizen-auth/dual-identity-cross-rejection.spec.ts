import { UnauthorizedException } from '@nestjs/common';

import { JwtStrategy } from '../../auth/jwt.strategy';
import { CitizenJwtStrategy } from './citizen-jwt.strategy';

/**
 * The dual-identity hard boundary (civic-community plan D2): a citizen token
 * (aud:'citizen') must never satisfy an internal route, and an internal token
 * must never satisfy a citizen route. Verified at the strategy layer (the
 * separate secrets give a second, signature-level boundary in real traffic).
 */
describe('dual-identity cross-rejection', () => {
  describe('internal JwtStrategy', () => {
    const strategy = new JwtStrategy();

    it('REJECTS a citizen token (aud:citizen) on an internal route', async () => {
      await expect(strategy.validate({ sub: 'x', aud: 'citizen' })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('accepts a normal internal token', async () => {
      const user = await strategy.validate({ sub: 'u1', role: 'staff' });
      expect(user.userId).toBe('u1');
      expect(user.role).toBe('staff');
    });
  });

  describe('CitizenJwtStrategy', () => {
    const strategy = new CitizenJwtStrategy();

    it('REJECTS a token without aud:citizen (an internal token)', async () => {
      await expect(strategy.validate({ sub: 'u1', role: 'staff' })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('accepts a citizen token and exposes NO role', async () => {
      const user = await strategy.validate({ sub: 'identity-1', aud: 'citizen', sessionVersion: 3 });
      expect(user.identityId).toBe('identity-1');
      expect(user.sessionVersion).toBe(3);
      expect((user as unknown as Record<string, unknown>).role).toBeUndefined();
    });
  });
});
