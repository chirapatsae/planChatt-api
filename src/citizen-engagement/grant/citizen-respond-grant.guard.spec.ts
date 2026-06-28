import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

import { CitizenRespondGrantGuard } from './citizen-respond-grant.guard';

/**
 * Unit spec for CitizenRespondGrantGuard (C4). The guard runs AFTER JwtAuthGuard
 * (which sets req.user.userId) and gates on a live `respond` grant.
 */
describe('CitizenRespondGrantGuard', () => {
  const makeContext = (user: unknown) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as never;

  it('throws 401 when req.user.userId is missing (auth-chain misconfig)', async () => {
    const grantService = { hasGrant: jest.fn() };
    const guard = new CitizenRespondGrantGuard(grantService as never);
    await expect(guard.canActivate(makeContext(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(grantService.hasGrant).not.toHaveBeenCalled();
  });

  it('throws 403 CITIZEN_RESPOND_NOT_GRANTED when no live respond grant', async () => {
    const grantService = { hasGrant: jest.fn(async () => false) };
    const guard = new CitizenRespondGrantGuard(grantService as never);
    await expect(
      guard.canActivate(makeContext({ userId: 'u1' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(grantService.hasGrant).toHaveBeenCalledWith('u1', 'respond');
  });

  it('allows when a live respond grant exists', async () => {
    const grantService = { hasGrant: jest.fn(async () => true) };
    const guard = new CitizenRespondGrantGuard(grantService as never);
    expect(await guard.canActivate(makeContext({ userId: 'u1' }))).toBe(true);
  });
});
