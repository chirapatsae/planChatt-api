import { CitizenOptionalJwtGuard } from './citizen-optional-jwt.guard';

/**
 * Unit spec for CitizenOptionalJwtGuard (W-T1).
 *
 * The KEY invariant: it ENRICHES `req.user` on a valid citizen token but NEVER
 * rejects an anonymous / invalid-token request (it must always let the public
 * read through). We assert both halves: `canActivate` swallows a passport throw
 * and still returns true, and `handleRequest` returns the user-or-undefined
 * instead of throwing.
 */
describe('CitizenOptionalJwtGuard', () => {
  const makeContext = () =>
    ({
      switchToHttp: () => ({ getRequest: () => ({}) }),
      getHandler: () => undefined,
      getClass: () => undefined,
    }) as never;

  // `super.canActivate` resolves to the AuthGuard mixin prototype THIS guard
  // actually extends — i.e. the prototype directly above the guard's own. (Each
  // `AuthGuard('citizen-jwt')` call returns a NEW mixin class, so spying on a
  // fresh one would miss the guard's real super.) Spy on it per-test.
  const basePrototype = Object.getPrototypeOf(
    CitizenOptionalJwtGuard.prototype,
  );

  afterEach(() => jest.restoreAllMocks());

  it('returns true (proceeds) even when passport auth THROWS — anonymous never rejected', async () => {
    jest
      .spyOn(basePrototype, 'canActivate')
      .mockRejectedValue(new Error('no token'));
    const guard = new CitizenOptionalJwtGuard();
    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
  });

  it('returns true when passport auth succeeds (valid token)', async () => {
    jest.spyOn(basePrototype, 'canActivate').mockResolvedValue(true);
    const guard = new CitizenOptionalJwtGuard();
    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
  });

  describe('handleRequest', () => {
    const guard = new CitizenOptionalJwtGuard();

    it('returns undefined (anonymous) on auth error — does NOT throw', () => {
      expect(guard.handleRequest(new Error('bad'), undefined, undefined)).toBeUndefined();
    });

    it('returns undefined (anonymous) when there is no user', () => {
      expect(guard.handleRequest(null, undefined, undefined)).toBeUndefined();
    });

    it('returns the user (enriches) when a valid citizen token resolved', () => {
      const user = { identityId: 'identity-1', aud: 'citizen' };
      expect(guard.handleRequest(null, user, undefined)).toBe(user);
    });
  });
});
