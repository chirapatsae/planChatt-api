/**
 * SEC-W44-01 — Attack class #9: role escalation / role-bypass.
 *
 * Threat model:
 *  - Non-whitelisted roles (`user`, `staff-lead` literal) authenticate
 *    and POST to `/v1/ai/executive-chat/messages`. The guard chain is
 *    `JwtAuthGuard → RolesGuard → WorkStatusApprovedGuard → AiQuotaGuard
 *    → AiCooldownGuard`. Together `RolesGuard` + `WorkStatusApprovedGuard`
 *    are the first two lines of defense.
 *  - A c-level / staff / admin with `workStatus != approved` (suspended,
 *    move, pending) tries the same endpoint.
 *  - A super-admin tries to claim exemption from quota / cooldown
 *    (explicitly forbidden by §17.11).
 *
 * Defense (post auth-roles-guard-unification BE-04):
 *  - The bespoke `ExecutiveRoleGuard` was retired. Executive-scope
 *    admission is now the canonical pair `@Roles(...EXEC_READ)` +
 *    `RolesGuard` (token-claim role check) followed by
 *    `WorkStatusApprovedGuard` (live `workStatus = approved` DB read).
 *    `EXEC_READ = staff + admin + super-admin + c-level` (see
 *    `src/auth/role-groups.ts`); rejects everyone else with
 *    403 FORBIDDEN_ROLE. `WorkStatusApprovedGuard` rejects non-approved
 *    workStatus with 403 WORK_STATUS_NOT_APPROVED.
 *  - `AiQuotaGuard` has NO role exemption — super-admin with exhausted
 *    quota still gets 429.
 *  - `AiCooldownGuard` has NO role exemption either.
 *
 * This spec tests `RolesGuard` + `WorkStatusApprovedGuard` directly
 * against a mocked WorkHistory repo (the landed code path post-BE-04).
 * Quota/cooldown role-bypass tests are structural/contract-based because
 * the real guards require a full DI-wired module (deferred to BE-W44-02
 * + BE-W44-03 integration).
 *
 * BE-06 note: this spec previously tested the bespoke `ExecutiveRoleGuard`
 * directly. After BE-04 retired that guard, BE-06 rewrote the spec to
 * exercise the canonical pair against the same matrix (every prior
 * assertion has a counterpart below).
 */

import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as fs from 'fs';
import * as path from 'path';
import { Role } from '../../../auth/roles.enum';
import { ROLES_KEY } from '../../../auth/roles.decorator';
import { RolesGuard } from '../../../auth/roles.guard';
import { WorkStatusApprovedGuard } from '../../../auth/work-status-approved.guard';
import { EXEC_READ } from '../../../auth/role-groups';

type Repo = { findOne: jest.Mock };

function mkCtx(
  user: { userId?: string; role?: string } | undefined,
): ExecutionContext {
  const handler = (): void => undefined;
  class FakeController {}
  return {
    getHandler: () => handler,
    getClass: () => FakeController,
    switchToHttp: () => ({
      getRequest: () => ({ user }),
      getResponse: () => ({}),
      getNext: () => ({}),
    }),
    switchToRpc: () => ({}) as never,
    switchToWs: () => ({}) as never,
    getArgs: () => [] as never,
    getArgByIndex: () => undefined as never,
    getType: () => 'http' as never,
  } as unknown as ExecutionContext;
}

function mkWh(workStatus: string) {
  return {
    id: 'wh-1',
    isCurrent: true,
    workStatus: { name: workStatus },
  };
}

/**
 * Run the canonical executive-scope guard chain (the post-BE-04 landed
 * shape):
 *   1. RolesGuard with `@Roles(...EXEC_READ)` metadata
 *   2. WorkStatusApprovedGuard live DB read
 *
 * Both must pass for admission. Either rejection short-circuits with the
 * appropriate error.
 */
async function runChain(
  rolesGuard: RolesGuard,
  workStatusGuard: WorkStatusApprovedGuard,
  ctx: ExecutionContext,
): Promise<true> {
  const rolesOk = rolesGuard.canActivate(ctx);
  if (rolesOk !== true) throw new Error('RolesGuard returned non-true');
  const wsOk = await workStatusGuard.canActivate(ctx);
  if (wsOk !== true)
    throw new Error('WorkStatusApprovedGuard returned non-true');
  return true;
}

describe('SEC-W44-01 / role-bypass (§17.11 integrity; role admission)', () => {
  let repo: Repo;
  let rolesGuard: RolesGuard;
  let workStatusGuard: WorkStatusApprovedGuard;
  let reflector: Reflector;

  beforeEach(async () => {
    repo = { findOne: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [RolesGuard, Reflector],
    }).compile();
    rolesGuard = moduleRef.get(RolesGuard);
    reflector = moduleRef.get(Reflector);
    // Stub reflector to always return EXEC_READ (mirrors `@Roles(...EXEC_READ)`
    // metadata applied to every executive-chat endpoint).
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockImplementation((key: unknown) => {
        if (key === ROLES_KEY) return [...EXEC_READ] as never;
        return undefined as never;
      });
    workStatusGuard = new WorkStatusApprovedGuard(repo as never);
  });

  describe('Canonical RolesGuard + WorkStatusApprovedGuard chain', () => {
    it('unauthenticated request (no req.user) → 401 UNAUTHENTICATED at WorkStatusApprovedGuard', async () => {
      // RolesGuard rejects first because `req.user` is undefined → 403
      // FORBIDDEN_ROLE. (The pre-BE-04 ExecutiveRoleGuard short-circuited
      // with 401 UNAUTHENTICATED in the same scenario; the canonical
      // pair throws 403 because RolesGuard runs first and treats
      // missing user as a role mismatch. This is documented behavior —
      // the JwtAuthGuard upstream is the one that issues 401 in
      // production; the test bypasses that layer.)
      expect(() => rolesGuard.canActivate(mkCtx(undefined))).toThrow(
        ForbiddenException,
      );
      // WorkStatusApprovedGuard alone (skipping RolesGuard) issues 401:
      await expect(
        workStatusGuard.canActivate(mkCtx(undefined)),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('role = "user" → 403 FORBIDDEN_ROLE at RolesGuard', () => {
      // RolesGuard rejects before workStatus is read.
      expect(() =>
        rolesGuard.canActivate(mkCtx({ userId: 'u1', role: 'user' })),
      ).toThrow(ForbiddenException);
      try {
        rolesGuard.canActivate(mkCtx({ userId: 'u1', role: 'user' }));
      } catch (e) {
        expect((e as ForbiddenException).message).toBe('FORBIDDEN_ROLE');
      }
    });

    it('role = "staff" + workStatus = "approved" → PASS (Wave 44 H1 fix)', async () => {
      // FE sidebar menu exposes the route to `staff`; BE must match.
      repo.findOne.mockResolvedValue(mkWh('approved'));
      await expect(
        runChain(
          rolesGuard,
          workStatusGuard,
          mkCtx({ userId: 'u1', role: Role.STAFF }),
        ),
      ).resolves.toBe(true);
    });

    it('role = "staff-lead" → 403 FORBIDDEN_ROLE (literal "staff-lead" is NOT a canonical role)', () => {
      // `staff-lead` is a logical role aggregate in CLAUDE.md, not a
      // DB role name. RolesGuard checks against the Role enum strings
      // and rejects unknown values.
      expect(() =>
        rolesGuard.canActivate(mkCtx({ userId: 'u1', role: 'staff-lead' })),
      ).toThrow('FORBIDDEN_ROLE');
    });

    it('role = "c-level" + workStatus = "suspended" → 403 WORK_STATUS_NOT_APPROVED', async () => {
      // RolesGuard passes (c-level is in EXEC_READ). WorkStatusApprovedGuard
      // rejects on the live workStatus read.
      repo.findOne.mockResolvedValue(mkWh('suspended'));
      expect(
        rolesGuard.canActivate(mkCtx({ userId: 'u1', role: Role.C_LEVEL })),
      ).toBe(true);
      await expect(
        workStatusGuard.canActivate(
          mkCtx({ userId: 'u1', role: Role.C_LEVEL }),
        ),
      ).rejects.toThrow('WORK_STATUS_NOT_APPROVED');
    });

    it('role = "c-level" + workStatus = "pending" → 403 WORK_STATUS_NOT_APPROVED', async () => {
      repo.findOne.mockResolvedValue(mkWh('pending'));
      expect(
        rolesGuard.canActivate(mkCtx({ userId: 'u1', role: Role.C_LEVEL })),
      ).toBe(true);
      await expect(
        workStatusGuard.canActivate(
          mkCtx({ userId: 'u1', role: Role.C_LEVEL }),
        ),
      ).rejects.toThrow('WORK_STATUS_NOT_APPROVED');
    });

    it('role = "c-level" + workStatus = "approved" → PASS', async () => {
      repo.findOne.mockResolvedValue(mkWh('approved'));
      await expect(
        runChain(
          rolesGuard,
          workStatusGuard,
          mkCtx({ userId: 'u1', role: Role.C_LEVEL }),
        ),
      ).resolves.toBe(true);
    });

    it('legacy string "executive" → 403 FORBIDDEN_ROLE (not a canonical role)', () => {
      expect(() =>
        rolesGuard.canActivate(mkCtx({ userId: 'u1', role: 'executive' })),
      ).toThrow('FORBIDDEN_ROLE');
    });

    it('role = "admin" + workStatus = "approved" → PASS', async () => {
      repo.findOne.mockResolvedValue(mkWh('approved'));
      await expect(
        runChain(
          rolesGuard,
          workStatusGuard,
          mkCtx({ userId: 'u1', role: Role.ADMIN }),
        ),
      ).resolves.toBe(true);
    });

    it('role = "super-admin" + workStatus = "approved" → PASS', async () => {
      repo.findOne.mockResolvedValue(mkWh('approved'));
      await expect(
        runChain(
          rolesGuard,
          workStatusGuard,
          mkCtx({ userId: 'u1', role: Role.SUPER_ADMIN }),
        ),
      ).resolves.toBe(true);
    });

    it('mixed-case role claim "C-Level" → 403 FORBIDDEN_ROLE (case-sensitive match)', () => {
      // BEHAVIORAL DIFFERENCE vs the pre-BE-04 ExecutiveRoleGuard:
      // the bespoke guard normalized via `.toLowerCase()` and would
      // accept "C-Level". The canonical RolesGuard is case-sensitive
      // (per BE-01 / SEC-01 #2 — tokens MUST be issued with lowercase
      // hyphenated role values; case-normalization should happen at
      // the JWT chokepoint, NOT inside the guard). A token claim of
      // "C-Level" is treated as a mismatch and rejected. This is the
      // documented contract per `src/auth/README.md`.
      expect(() =>
        rolesGuard.canActivate(mkCtx({ userId: 'u1', role: 'C-Level' })),
      ).toThrow('FORBIDDEN_ROLE');
    });

    it('no current WorkHistory → 403 WORK_STATUS_NOT_APPROVED', async () => {
      // RolesGuard passes (role = c-level is in EXEC_READ).
      // WorkStatusApprovedGuard finds no row → workStatusName === '' →
      // rejects with WORK_STATUS_NOT_APPROVED.
      repo.findOne.mockResolvedValue(null);
      expect(
        rolesGuard.canActivate(mkCtx({ userId: 'u1', role: Role.C_LEVEL })),
      ).toBe(true);
      await expect(
        workStatusGuard.canActivate(
          mkCtx({ userId: 'u1', role: Role.C_LEVEL }),
        ),
      ).rejects.toThrow('WORK_STATUS_NOT_APPROVED');
    });
  });

  describe('§17.11 no-role-exemption contract (quota + cooldown)', () => {
    it('AiQuotaGuard source code contains no role-branching exemption for super-admin', () => {
      // Grep-gate: a role check in the quota guard would be a regression.
      const src = fs.readFileSync(
        path.resolve(
          __dirname,
          '../../../ai-usage-quotas/guards/ai-quota.guard.ts',
        ),
        'utf8',
      );
      expect(src).not.toMatch(/role\.name.*===.*['"]super-admin['"]/);
      expect(src).not.toMatch(/if\s*\(.*role.*super-admin.*\)\s*return\s+true/);
    });

    it('AiCooldownGuard source code contains no role-branching exemption', () => {
      const src = fs.readFileSync(
        path.resolve(__dirname, '../../../ai/guards/ai-cooldown.guard.ts'),
        'utf8',
      );
      expect(src).not.toMatch(/role\.name.*===.*['"]super-admin['"]/);
    });
  });

  describe.skip('E2E — pending BE-W44-02 + full DI wiring', () => {
    it('super-admin with exhausted quota → 429 AI_QUOTA_EXHAUSTED', () => {
      /** Wire AiQuotaGuard with a mocked AiUsageQuotasService that
       *  reports remainingQuota=0; assert 429 regardless of role. */
    });

    it('super-admin within cooldown window → 429 AI_COOLDOWN_ACTIVE', () => {
      /** Wire AiCooldownGuard with a pre-populated store entry; assert
       *  429 regardless of role. */
    });

    it('role=user hitting POST /messages → 403 via RolesGuard BEFORE reaching the service', () => {
      /** Full supertest against the Nest app — confirms guard order. */
    });
  });
});
