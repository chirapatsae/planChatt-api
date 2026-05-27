/**
 * Wave wave-backup-login-profile-self-enroll / BE-01 — controller
 * wiring tests for the three deltas.
 *
 * Verifies:
 *   1. GET /backup-credentials/me delegates with caller's userId
 *   2. POST /backup-credentials/self-enroll delegates with caller's
 *      userId + password, returns `{ok: true}` (HTTP 200 shape)
 *   3. POST /backup-credentials/change-password surfaces JWT's
 *      `loginMethod` to the service AND passes the optional `totpCode`
 */
import { BackupLoginController } from './backup-login.controller';

function makeRequest(user: { userId: string; loginMethod?: 'thaid' | 'backup' }) {
  return { user } as any;
}

describe('BackupLoginController — Wave wave-backup-login-profile-self-enroll', () => {
  let controller: BackupLoginController;
  let backupLogin: {
    getMyBackupStatus: jest.Mock;
    selfEnrollPassword: jest.Mock;
    changePassword: jest.Mock;
  };

  beforeEach(() => {
    backupLogin = {
      getMyBackupStatus: jest.fn(),
      selfEnrollPassword: jest.fn().mockResolvedValue(undefined),
      changePassword: jest.fn().mockResolvedValue({ accessToken: 'tok' }),
    };
    controller = new BackupLoginController(
      backupLogin as any,
      {} as any, // audit
      {} as any, // killSwitch
    );
  });

  describe('GET backup-credentials/me', () => {
    it('returns service result keyed by JWT subject', async () => {
      backupLogin.getMyBackupStatus.mockResolvedValue({
        hasCredential: true,
        mustChangeOnNextLogin: false,
        isFrozen: false,
        isRevoked: false,
        hasConfirmedTotp: true,
        passwordSetAt: '2026-01-01T00:00:00.000Z',
      });

      const result = await controller.myStatus(makeRequest({ userId: 'user-1' }));

      expect(backupLogin.getMyBackupStatus).toHaveBeenCalledWith('user-1');
      expect(result.hasCredential).toBe(true);
    });
  });

  describe('POST backup-credentials/self-enroll', () => {
    it('delegates with caller userId + password and returns {ok: true}', async () => {
      const result = await controller.selfEnroll(
        { password: 'Aa1!validNewPasswordSafe' } as any,
        makeRequest({ userId: 'user-1' }),
      );

      expect(backupLogin.selfEnrollPassword).toHaveBeenCalledWith(
        'user-1',
        'Aa1!validNewPasswordSafe',
      );
      // SECURITY-01 §7.1 row 2 — `{ok: true}` HTTP 200 (NOT 204).
      expect(result).toEqual({ ok: true });
    });
  });

  describe('POST backup-credentials/change-password', () => {
    it('propagates totpCode + loginMethod from JWT to service', async () => {
      await controller.changePassword(
        { oldPassword: 'old', newPassword: 'Aa1!validNewPasswordSafe', totpCode: '123456' } as any,
        makeRequest({ userId: 'user-1', loginMethod: 'backup' }),
      );

      expect(backupLogin.changePassword).toHaveBeenCalledWith(
        'user-1',
        'old',
        'Aa1!validNewPasswordSafe',
        '123456',
        'backup',
      );
    });

    it("defaults loginMethod to 'thaid' when JWT claim is absent (fail-closed)", async () => {
      // SECURITY-01 §7.2 — missing claim MUST default to 'thaid' so
      // the forced-flow exception does NOT silently fire. A 'thaid'
      // caller MUST always supply totpCode (or be rejected with
      // generic 401 anti-enum).
      await controller.changePassword(
        { oldPassword: 'old', newPassword: 'Aa1!validNewPasswordSafe' } as any,
        makeRequest({ userId: 'user-1' }),
      );

      expect(backupLogin.changePassword).toHaveBeenCalledWith(
        'user-1',
        'old',
        'Aa1!validNewPasswordSafe',
        undefined,
        'thaid',
      );
    });
  });
});
