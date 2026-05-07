import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Role } from './roles.enum';
import { ROLES_KEY } from './roles.decorator';
import { RolesGuard } from './roles.guard';

/**
 * Unit tests for RolesGuard — Phase 1 acceptance per
 * docs/tasks/auth-roles-guard-unification.md §10.
 *
 * Test matrix (BE-01):
 *   - No @Roles() decorator           → returns true
 *   - Empty @Roles()                  → returns true (treated as no metadata)
 *   - Match (single required role)    → returns true
 *   - Mismatch                        → 403 FORBIDDEN_ROLE
 *   - Match (multiple required roles) → returns true
 *   - Missing req.user                → 403 FORBIDDEN_ROLE
 *   - Missing req.user.role           → 403 FORBIDDEN_ROLE
 *   - Case sensitivity ('Admin' vs 'admin') → 403 FORBIDDEN_ROLE
 */
describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: Reflector;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [RolesGuard, Reflector],
    }).compile();

    guard = moduleRef.get(RolesGuard);
    reflector = moduleRef.get(Reflector);
  });

  /**
   * Build a minimal ExecutionContext stub. We only need:
   *   - getHandler() / getClass() (Reflector.getAllAndOverride consumes them)
   *   - switchToHttp().getRequest() returning { user }
   */
  const buildContext = (user: unknown): ExecutionContext => {
    const handler = (): void => undefined;
    class FakeController {}
    const httpCtx = {
      getRequest: <T = unknown>(): T => ({ user }) as T,
      getResponse: <T = unknown>(): T => ({}) as T,
      getNext: <T = unknown>(): T => ({}) as T,
    };
    return {
      getHandler: () => handler,
      getClass: () => FakeController,
      switchToHttp: () => httpCtx,
      switchToRpc: () => ({}) as never,
      switchToWs: () => ({}) as never,
      getArgs: () => [] as never,
      getArgByIndex: () => undefined as never,
      getType: () => 'http' as never,
    } as unknown as ExecutionContext;
  };

  /**
   * Stub `reflector.getAllAndOverride(ROLES_KEY, ...)` to return the desired
   * required-roles list (or undefined for the "no decorator" case).
   */
  const stubReflector = (required: Role[] | undefined) => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockImplementation((key: unknown) => {
        if (key === ROLES_KEY) return required as never;
        return undefined as never;
      });
  };

  it('returns true when no @Roles() metadata is present', () => {
    stubReflector(undefined);
    const ctx = buildContext({ role: 'user' });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('returns true when @Roles() metadata is an empty array', () => {
    stubReflector([]);
    const ctx = buildContext({ role: 'user' });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('returns true when req.user.role matches a single required role', () => {
    stubReflector([Role.ADMIN]);
    const ctx = buildContext({ role: 'admin' });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('returns true when req.user.role is one of multiple required roles', () => {
    stubReflector([Role.ADMIN, Role.SUPER_ADMIN]);
    const ctx = buildContext({ role: 'super-admin' });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('throws ForbiddenException when req.user.role does not match', () => {
    stubReflector([Role.ADMIN]);
    const ctx = buildContext({ role: 'user' });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    try {
      guard.canActivate(ctx);
    } catch (e) {
      expect((e as ForbiddenException).message).toBe('FORBIDDEN_ROLE');
    }
  });

  it('throws ForbiddenException when req.user is missing entirely', () => {
    stubReflector([Role.ADMIN]);
    const ctx = buildContext(undefined);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('throws ForbiddenException when req.user.role is missing', () => {
    stubReflector([Role.ADMIN]);
    const ctx = buildContext({});
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('rejects mixed-case role claims (case-sensitive match)', () => {
    // Token claim "Admin" (mixed-case) MUST NOT pass for Role.ADMIN ('admin').
    stubReflector([Role.ADMIN]);
    const ctx = buildContext({ role: 'Admin' });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('rejects c-level when only super-admin is required', () => {
    stubReflector([Role.SUPER_ADMIN]);
    const ctx = buildContext({ role: 'c-level' });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('accepts c-level when included in required roles (EXEC_READ pattern)', () => {
    stubReflector([Role.STAFF, Role.ADMIN, Role.SUPER_ADMIN, Role.C_LEVEL]);
    const ctx = buildContext({ role: 'c-level' });
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
