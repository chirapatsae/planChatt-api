/**
 * SEC-W44-01 — Attack class #9: role escalation / role-bypass.
 *
 * Threat model:
 *  - Non-whitelisted roles (`user`, `staff-lead` literal) authenticate
 *    and POST to `/v1/ai/executive-chat/messages`. The guard chain is
 *    `JwtAuthGuard → ExecutiveRoleGuard → AiQuotaGuard → AiCooldownGuard`.
 *    `ExecutiveRoleGuard` is the first line of defense.
 *  - A c-level / staff / admin with `workStatus != approved` (suspended,
 *    move, pending) tries the same endpoint.
 *  - A super-admin tries to claim exemption from quota / cooldown
 *    (explicitly forbidden by §17.11).
 *
 * Defense:
 *  - `ExecutiveRoleGuard` allows ONLY {`staff`, `admin`, `super-admin`,
 *    `c-level`} with `workStatus == 'approved'`; rejects everyone else
 *    with 403 EXECUTIVE_ROLE_REQUIRED. The canonical executive role in
 *    this codebase is `c-level` (see `update-work-history.dto.ts` —
 *    `CLEVEL = 'c-level'`). Staff are included because the FE sidebar
 *    menu registers the route for `['staff','admin','super-admin',
 *    'c-level']`; excluding them would 403 on a visible menu entry.
 *  - `AiQuotaGuard` has NO role exemption — super-admin with exhausted
 *    quota still gets 429.
 *  - `AiCooldownGuard` has NO role exemption either.
 *
 * This spec tests `ExecutiveRoleGuard` directly against a mocked
 * WorkHistory repo (it's the landed code path). Quota/cooldown role-bypass
 * tests are structural/contract-based because the real guards require
 * a full DI-wired module (deferred to BE-W44-02 + BE-W44-03 integration).
 */

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { ExecutiveRoleGuard } from '../../guards/executive-role.guard';

type Repo = { findOne: jest.Mock };

function mkCtx(user: { userId?: string } | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
      getResponse: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

function mkWh(role: string, workStatus: string) {
  return {
    id: 'wh-1',
    isCurrent: true,
    workStatus: { name: workStatus },
    role: { name: role },
  };
}

describe('SEC-W44-01 / role-bypass (§17.11 integrity; role admission)', () => {
  let repo: Repo;
  let guard: ExecutiveRoleGuard;

  beforeEach(() => {
    repo = { findOne: jest.fn() };
    guard = new ExecutiveRoleGuard(repo as never);
  });

  describe('ExecutiveRoleGuard', () => {
    it('unauthenticated request (no req.user) → 401 UNAUTHENTICATED', async () => {
      await expect(
        guard.canActivate(mkCtx(undefined)),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('role = "user" → 403 EXECUTIVE_ROLE_REQUIRED', async () => {
      repo.findOne.mockResolvedValueOnce(mkWh('user', 'approved'));
      await expect(
        guard.canActivate(mkCtx({ userId: 'u1' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        guard.canActivate(mkCtx({ userId: 'u1' })),
      ).rejects.toThrow('EXECUTIVE_ROLE_REQUIRED');
    });

    it('role = "staff" + workStatus = "approved" → PASS (Wave 44 H1 fix)', async () => {
      // FE sidebar menu exposes the route to `staff`; BE must match.
      repo.findOne.mockResolvedValue(mkWh('staff', 'approved'));
      await expect(
        guard.canActivate(mkCtx({ userId: 'u1' })),
      ).resolves.toBe(true);
    });

    it('role = "staff-lead" → 403 (literal "staff-lead" is NOT a canonical role)', async () => {
      // `staff-lead` is a logical role aggregate in CLAUDE.md, not a
      // DB role name. The guard checks actual DB role names. If a
      // future row exists with literal `staff-lead`, it is rejected.
      repo.findOne.mockResolvedValue(mkWh('staff-lead', 'approved'));
      await expect(
        guard.canActivate(mkCtx({ userId: 'u1' })),
      ).rejects.toThrow('EXECUTIVE_ROLE_REQUIRED');
    });

    it('role = "c-level" + workStatus = "suspended" → 403', async () => {
      repo.findOne.mockResolvedValue(mkWh('c-level', 'suspended'));
      await expect(
        guard.canActivate(mkCtx({ userId: 'u1' })),
      ).rejects.toThrow('EXECUTIVE_ROLE_REQUIRED');
    });

    it('role = "c-level" + workStatus = "pending" → 403', async () => {
      repo.findOne.mockResolvedValue(mkWh('c-level', 'pending'));
      await expect(
        guard.canActivate(mkCtx({ userId: 'u1' })),
      ).rejects.toThrow('EXECUTIVE_ROLE_REQUIRED');
    });

    it('role = "c-level" + workStatus = "approved" → PASS', async () => {
      repo.findOne.mockResolvedValue(mkWh('c-level', 'approved'));
      await expect(
        guard.canActivate(mkCtx({ userId: 'u1' })),
      ).resolves.toBe(true);
    });

    it('legacy string "executive" → 403 (not a canonical role)', async () => {
      repo.findOne.mockResolvedValue(mkWh('executive', 'approved'));
      await expect(
        guard.canActivate(mkCtx({ userId: 'u1' })),
      ).rejects.toThrow('EXECUTIVE_ROLE_REQUIRED');
    });

    it('role = "admin" + workStatus = "approved" → PASS', async () => {
      repo.findOne.mockResolvedValue(mkWh('admin', 'approved'));
      await expect(
        guard.canActivate(mkCtx({ userId: 'u1' })),
      ).resolves.toBe(true);
    });

    it('role = "super-admin" + workStatus = "approved" → PASS', async () => {
      repo.findOne.mockResolvedValue(mkWh('super-admin', 'approved'));
      await expect(
        guard.canActivate(mkCtx({ userId: 'u1' })),
      ).resolves.toBe(true);
    });

    it('case-insensitive role match (DB row is "C-Level")', async () => {
      repo.findOne.mockResolvedValue(mkWh('C-Level', 'approved'));
      await expect(
        guard.canActivate(mkCtx({ userId: 'u1' })),
      ).resolves.toBe(true);
    });

    it('no current WorkHistory → 403 EXECUTIVE_ROLE_REQUIRED', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        guard.canActivate(mkCtx({ userId: 'u1' })),
      ).rejects.toThrow('EXECUTIVE_ROLE_REQUIRED');
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
        path.resolve(
          __dirname,
          '../../../ai/guards/ai-cooldown.guard.ts',
        ),
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

    it('role=user hitting POST /messages → 403 via ExecutiveRoleGuard BEFORE reaching the service', () => {
      /** Full supertest against the Nest app — confirms guard order. */
    });
  });
});
