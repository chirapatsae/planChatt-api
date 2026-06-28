import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import * as passport from '@nestjs/passport';

import { CitizenJwtGuard } from './citizen-jwt.guard';

/**
 * Unit spec for the CitizenJwtGuard status branch (W-T3). The guard is the SHARED
 * write-gate for every citizen write (create / comment / react / repost / report /
 * follow / bookmark / story / poll / appeal). It runs passport first, then reads
 * the live `citizen_identities.status`:
 *   - `suspended` → 403 CITIZEN_SUSPENDED (offender ladder — distinct, clear copy)
 *   - other non-active (`blocked` / `deleted`) → 401 (existing behavior)
 *   - `active` → pass
 *
 * passport's `super.canActivate` is stubbed on the AuthGuard prototype so the
 * spec exercises ONLY the post-passport status branch.
 */
describe('CitizenJwtGuard — status branch', () => {
  const makeContext = (user: unknown) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as never;

  const makeGuard = (rows: Array<{ status: string; session_version: number }>) => {
    const dataSource = { query: jest.fn(async () => rows) };
    return new CitizenJwtGuard(dataSource as never);
  };

  let superSpy: jest.SpyInstance;

  beforeEach(() => {
    // Stub passport's AuthGuard.canActivate (the `super.canActivate`) to pass.
    superSpy = jest
      .spyOn(passport.AuthGuard('citizen-jwt').prototype, 'canActivate')
      .mockResolvedValue(true);
  });

  afterEach(() => superSpy.mockRestore());

  it('throws 403 CITIZEN_SUSPENDED for a suspended identity', async () => {
    const guard = makeGuard([{ status: 'suspended', session_version: 0 }]);
    await expect(
      guard.canActivate(makeContext({ identityId: 'id-1', sessionVersion: 0 })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws 401 for a blocked identity (existing behavior preserved)', async () => {
    const guard = makeGuard([{ status: 'blocked', session_version: 0 }]);
    await expect(
      guard.canActivate(makeContext({ identityId: 'id-1', sessionVersion: 0 })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('passes an active identity with a current session', async () => {
    const guard = makeGuard([{ status: 'active', session_version: 0 }]);
    expect(
      await guard.canActivate(makeContext({ identityId: 'id-1', sessionVersion: 0 })),
    ).toBe(true);
  });
});
