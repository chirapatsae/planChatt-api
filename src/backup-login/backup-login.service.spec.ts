/**
 * Wave wave-backup-login-profile-self-enroll / BE-01 — service tests
 * for the three deltas:
 *   1. `getMyBackupStatus` shape across credential states
 *   2. `selfEnrollPassword` insert + re-activate + anti-enum paths
 *   3. `changePassword` totpCode requirement + forced-flow exception
 *      (8-combination matrix per SECURITY-01 §7.2)
 *
 * Pattern: use `Test.createTestingModule` only when we need DI wiring.
 * For pure-logic methods we hand-construct the service with mocked
 * collaborators — faster and easier to read than the testing-module
 * dance.
 */
import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { BackupLoginService } from './backup-login.service';
import { BACKUP_OUTCOME } from './constants/error-messages';

function makeCredential(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'cred-1',
    userId: 'user-1',
    usernameEmailHash: 'hash-email',
    passwordHash: '$argon2id$dummy',
    passwordSetAt: new Date('2026-01-01T00:00:00.000Z'),
    passwordSetByUserId: 'user-1',
    mustChangeOnNextLogin: false,
    failedAttempts: 0,
    lockedUntil: null,
    frozenAt: null,
    frozenReason: null,
    revokedAt: null,
    revokedByUserId: null,
    revokedReason: null,
    ...overrides,
  };
}

function makeService(overrides: {
  credRepo?: Partial<{ findOne: jest.Mock; update: jest.Mock; insert: jest.Mock }>;
  totp?: Partial<{ hasConfirmed: jest.Mock; verifyCode: jest.Mock }>;
  userRepo?: Partial<{ findOne: jest.Mock }>;
  argon2?: Partial<{ verify: jest.Mock; verifyDummy: jest.Mock; hash: jest.Mock }>;
  passwordPolicy?: Partial<{ validate: jest.Mock; push: jest.Mock; reset: jest.Mock }>;
  audit?: Partial<{ write: jest.Mock }>;
  lineNotifier?: Partial<{ notifyEventToUser: jest.Mock }>;
  sessionVersion?: Partial<{ bump: jest.Mock; read: jest.Mock }>;
  dataSource?: { transaction: jest.Mock };
  jwtService?: Partial<{ sign: jest.Mock }>;
  whRepo?: Partial<{ findOne: jest.Mock; createQueryBuilder: jest.Mock }>;
} = {}) {
  const credRepo = {
    findOne: jest.fn(),
    update: jest.fn(),
    insert: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    increment: jest.fn(),
    ...(overrides.credRepo ?? {}),
  };
  const totp = {
    hasConfirmed: jest.fn().mockResolvedValue(false),
    verifyCode: jest.fn().mockResolvedValue(false),
    ...(overrides.totp ?? {}),
  };
  const userRepo = {
    findOne: jest.fn(),
    ...(overrides.userRepo ?? {}),
  };
  const argon2 = {
    verify: jest.fn().mockResolvedValue(true),
    verifyDummy: jest.fn().mockResolvedValue(undefined),
    hash: jest.fn().mockResolvedValue('$argon2id$new-hash'),
    ...(overrides.argon2 ?? {}),
  };
  const passwordPolicy = {
    validate: jest.fn().mockResolvedValue(undefined),
    push: jest.fn().mockResolvedValue(undefined),
    reset: jest.fn().mockResolvedValue(undefined),
    ...(overrides.passwordPolicy ?? {}),
  };
  const audit = {
    write: jest.fn().mockResolvedValue(undefined),
    ...(overrides.audit ?? {}),
  };
  const lineNotifier = {
    notifyEventToUser: jest.fn().mockResolvedValue(undefined),
    ...(overrides.lineNotifier ?? {}),
  };
  const sessionVersion = {
    bump: jest.fn().mockResolvedValue(1),
    read: jest.fn().mockResolvedValue(1),
    ...(overrides.sessionVersion ?? {}),
  };
  const jwtService = {
    sign: jest.fn().mockReturnValue('new-access-token'),
    ...(overrides.jwtService ?? {}),
  };
  // Default transaction runner: invoke the callback with an em that
  // exposes a getRepository spying on per-entity inserts/updates so
  // the in-transaction audit + credential writes are observable.
  const txInsert = jest.fn().mockResolvedValue(undefined);
  const txUpdate = jest.fn().mockResolvedValue(undefined);
  const dataSource = overrides.dataSource ?? {
    transaction: jest.fn(async (cb: any) => {
      const em = {
        getRepository: () => ({ insert: txInsert, update: txUpdate }),
      };
      return cb(em);
    }),
  };
  const whRepo = {
    findOne: jest.fn().mockResolvedValue({
      role: { name: 'user' },
      workStatus: { name: 'approved' },
      amphoe: { id: '', name: '' },
      localAdministrativeOrganization: { id: '', name: '' },
    }),
    createQueryBuilder: jest.fn(),
    ...(overrides.whRepo ?? {}),
  };

  // Cast to unknown then to the constructor signature — the service
  // accepts these injected collaborators positionally; the cast is
  // local to the test and never escapes.
  const service = new BackupLoginService(
    credRepo as any,
    {} as any, // totpRepo — service only touches it via totp.* (we mock at the service level via totp.hasConfirmed)
    userRepo as any,
    whRepo as any,
    jwtService as any,
    argon2 as any,
    passwordPolicy as any,
    {} as any, // lockoutService
    sessionVersion as any,
    totp as any,
    {} as any, // killSwitchService
    audit as any,
    lineNotifier as any,
    dataSource as any,
  );

  return { service, credRepo, totp, userRepo, argon2, passwordPolicy, audit, lineNotifier, sessionVersion, dataSource, txInsert, txUpdate };
}

describe('BackupLoginService — Wave wave-backup-login-profile-self-enroll', () => {
  describe('getMyBackupStatus', () => {
    it('returns all-false shape when no credential row exists', async () => {
      const { service, credRepo, totp } = makeService();
      credRepo.findOne.mockResolvedValue(null);

      const result = await service.getMyBackupStatus('user-1');

      expect(result).toEqual({
        hasCredential: false,
        mustChangeOnNextLogin: false,
        isFrozen: false,
        isRevoked: false,
        hasConfirmedTotp: false,
        passwordSetAt: null,
      });
      expect(totp.hasConfirmed).not.toHaveBeenCalled();
    });

    it('returns active shape when credential is healthy + TOTP confirmed', async () => {
      const { service, credRepo, totp } = makeService();
      credRepo.findOne.mockResolvedValue(makeCredential());
      totp.hasConfirmed.mockResolvedValue(true);

      const result = await service.getMyBackupStatus('user-1');

      expect(result.hasCredential).toBe(true);
      expect(result.isRevoked).toBe(false);
      expect(result.isFrozen).toBe(false);
      expect(result.mustChangeOnNextLogin).toBe(false);
      expect(result.hasConfirmedTotp).toBe(true);
      expect(result.passwordSetAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('reports isRevoked=true AND hasCredential=false when revoked', async () => {
      const { service, credRepo } = makeService();
      credRepo.findOne.mockResolvedValue(
        makeCredential({ revokedAt: new Date() }),
      );

      const result = await service.getMyBackupStatus('user-1');

      expect(result.isRevoked).toBe(true);
      // SECURITY-01 §7.7 row 3 — revoked is semantically "no credential"
      // so the FE renders State A.
      expect(result.hasCredential).toBe(false);
    });

    it('reports isFrozen=true when frozenAt is set', async () => {
      const { service, credRepo } = makeService();
      credRepo.findOne.mockResolvedValue(
        makeCredential({ frozenAt: new Date() }),
      );

      const result = await service.getMyBackupStatus('user-1');

      expect(result.isFrozen).toBe(true);
      expect(result.hasCredential).toBe(true);
    });

    it('reports mustChangeOnNextLogin=true when flag is set', async () => {
      const { service, credRepo } = makeService();
      credRepo.findOne.mockResolvedValue(
        makeCredential({ mustChangeOnNextLogin: true }),
      );

      const result = await service.getMyBackupStatus('user-1');

      expect(result.mustChangeOnNextLogin).toBe(true);
    });

    it('reports hasConfirmedTotp=false when TOTP enrollment is absent', async () => {
      const { service, credRepo, totp } = makeService();
      credRepo.findOne.mockResolvedValue(makeCredential());
      totp.hasConfirmed.mockResolvedValue(false);

      const result = await service.getMyBackupStatus('user-1');

      expect(result.hasConfirmedTotp).toBe(false);
    });
  });

  describe('selfEnrollPassword', () => {
    const validPassword = 'Aa1!verySafeValidLongPassword';

    it('inserts a fresh credential row when none exists', async () => {
      const { service, credRepo, userRepo, txInsert, passwordPolicy, lineNotifier } = makeService();
      userRepo.findOne.mockResolvedValue({ id: 'user-1', emailHash: 'hash-1' });
      credRepo.findOne.mockResolvedValue(null);

      await service.selfEnrollPassword('user-1', validPassword);

      expect(passwordPolicy.validate).toHaveBeenCalledWith(
        validPassword,
        'hash-1',
        'user-1',
      );
      // One insert for credential + one insert for audit row (both
      // observable via the transaction em's getRepository().insert
      // mock returned by makeService).
      expect(txInsert).toHaveBeenCalledTimes(2);
      expect(lineNotifier.notifyEventToUser).toHaveBeenCalledWith(
        'user-1',
        expect.stringContaining('คุณได้ตั้งค่ารหัสผ่านสำรอง'),
      );
    });

    it('re-activates a revoked credential row and resets history', async () => {
      const { service, credRepo, userRepo, txUpdate, passwordPolicy } = makeService();
      userRepo.findOne.mockResolvedValue({ id: 'user-1', emailHash: 'hash-1' });
      credRepo.findOne.mockResolvedValue(
        makeCredential({ revokedAt: new Date(), revokedByUserId: 'admin' }),
      );

      await service.selfEnrollPassword('user-1', validPassword);

      // On re-enroll, skipHistoryCheck=true → validate called with
      // userId=null so history-no-reuse does NOT fire on the old
      // (revoked-life) hashes.
      expect(passwordPolicy.validate).toHaveBeenCalledWith(
        validPassword,
        'hash-1',
        null,
      );
      // Update is called on the credential row (revive). The audit
      // insert still fires inside the transaction.
      expect(txUpdate).toHaveBeenCalledTimes(1);
      expect(passwordPolicy.reset).toHaveBeenCalledWith('user-1', expect.anything());
    });

    it('throws generic 401 (anti-enum) when caller already has active credential', async () => {
      const { service, credRepo, userRepo, audit, argon2 } = makeService();
      userRepo.findOne.mockResolvedValue({ id: 'user-1', emailHash: 'hash-1' });
      credRepo.findOne.mockResolvedValue(makeCredential());

      await expect(
        service.selfEnrollPassword('user-1', validPassword),
      ).rejects.toThrow(UnauthorizedException);

      // Timing-oracle defense — dummy hash burn on the anti-enum path.
      expect(argon2.verifyDummy).toHaveBeenCalledWith(validPassword);
      // Audit row with NOT_ELIGIBLE outcome (super-admin daily summary).
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          userIdOrNull: 'user-1',
          outcome: BACKUP_OUTCOME.NOT_ELIGIBLE,
        }),
      );
    });

    it('throws generic 401 (anti-enum) when user has no email hash', async () => {
      const { service, credRepo, userRepo, argon2 } = makeService();
      userRepo.findOne.mockResolvedValue({ id: 'user-1', emailHash: null });
      credRepo.findOne.mockResolvedValue(null);

      await expect(
        service.selfEnrollPassword('user-1', validPassword),
      ).rejects.toThrow(UnauthorizedException);

      // Timing parity preserved even on the no-email path.
      expect(argon2.verifyDummy).toHaveBeenCalled();
    });

    it('propagates password-policy rejection unchanged (specific message)', async () => {
      const { service, credRepo, userRepo, passwordPolicy } = makeService();
      userRepo.findOne.mockResolvedValue({ id: 'user-1', emailHash: 'hash-1' });
      credRepo.findOne.mockResolvedValue(null);
      passwordPolicy.validate.mockRejectedValue(new Error('weak-password'));

      await expect(
        service.selfEnrollPassword('user-1', 'weakpass'),
      ).rejects.toThrow('weak-password');
    });
  });

  describe('changePassword — forced-flow exception (8-combination matrix)', () => {
    // SECURITY-01 §7.2 — the exception applies ONLY when ALL THREE
    // conditions are true simultaneously:
    //   cond1 = credential.mustChangeOnNextLogin === true
    //   cond2 = hasConfirmedTotp === false
    //   cond3 = callerLoginMethod === 'backup'
    // All 8 combinations — only (T,T,T) skips the TOTP requirement.

    type Combo = {
      mustChange: boolean;
      hasTotp: boolean;
      isBackup: boolean;
      shouldSkipTotp: boolean;
    };

    const combos: Combo[] = [
      { mustChange: true,  hasTotp: false, isBackup: true,  shouldSkipTotp: true  },  // (T,T,T) — the ONE
      { mustChange: true,  hasTotp: false, isBackup: false, shouldSkipTotp: false }, // (T,T,F)
      { mustChange: true,  hasTotp: true,  isBackup: true,  shouldSkipTotp: false }, // (T,F,T)
      { mustChange: true,  hasTotp: true,  isBackup: false, shouldSkipTotp: false }, // (T,F,F)
      { mustChange: false, hasTotp: false, isBackup: true,  shouldSkipTotp: false }, // (F,T,T)
      { mustChange: false, hasTotp: false, isBackup: false, shouldSkipTotp: false }, // (F,T,F)
      { mustChange: false, hasTotp: true,  isBackup: true,  shouldSkipTotp: false }, // (F,F,T)
      { mustChange: false, hasTotp: true,  isBackup: false, shouldSkipTotp: false }, // (F,F,F)
    ];

    combos.forEach(({ mustChange, hasTotp, isBackup, shouldSkipTotp }) => {
      const label = `(mustChange=${mustChange}, hasTotp=${hasTotp}, isBackup=${isBackup})`;
      it(`${label} → ${shouldSkipTotp ? 'SKIPS' : 'REQUIRES'} TOTP`, async () => {
        const { service, credRepo, userRepo, totp } = makeService();
        userRepo.findOne.mockResolvedValue({ id: 'user-1', emailHash: 'hash-1' });
        credRepo.findOne.mockResolvedValue(
          makeCredential({ mustChangeOnNextLogin: mustChange }),
        );
        totp.hasConfirmed.mockResolvedValue(hasTotp);

        // No totpCode supplied. The forced-flow exception decides
        // whether this is OK or generic-401.
        const call = service.changePassword(
          'user-1',
          'old-correct',
          'Aa1!validNewPasswordSafe',
          undefined,
          isBackup ? 'backup' : 'thaid',
        );

        if (shouldSkipTotp) {
          await expect(call).resolves.toHaveProperty('accessToken');
          expect(totp.verifyCode).not.toHaveBeenCalled();
        } else {
          await expect(call).rejects.toThrow(UnauthorizedException);
        }
      });
    });
  });

  describe('changePassword — anti-enum on totp failure', () => {
    const oldPw = 'old-correct';
    const newPw = 'Aa1!validNewPasswordSafe';

    it('rejects with generic 401 when totpCode missing AND not in forced-flow', async () => {
      const { service, credRepo, userRepo, audit, totp } = makeService();
      userRepo.findOne.mockResolvedValue({ id: 'user-1', emailHash: 'hash-1' });
      credRepo.findOne.mockResolvedValue(makeCredential());
      totp.hasConfirmed.mockResolvedValue(true);

      await expect(
        service.changePassword('user-1', oldPw, newPw, undefined, 'backup'),
      ).rejects.toThrow(UnauthorizedException);

      // Audit logs WRONG_TOTP internally (never returned to caller).
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: BACKUP_OUTCOME.WRONG_TOTP }),
      );
    });

    it('rejects with generic 401 when totpCode is wrong AND not in forced-flow', async () => {
      const { service, credRepo, userRepo, audit, totp } = makeService();
      userRepo.findOne.mockResolvedValue({ id: 'user-1', emailHash: 'hash-1' });
      credRepo.findOne.mockResolvedValue(makeCredential());
      totp.hasConfirmed.mockResolvedValue(true);
      totp.verifyCode.mockResolvedValue(false);

      await expect(
        service.changePassword('user-1', oldPw, newPw, '000000', 'backup'),
      ).rejects.toThrow(UnauthorizedException);

      // Internal-only outcome distinguishes wrong-totp from
      // wrong-password for the super-admin daily summary.
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: BACKUP_OUTCOME.WRONG_TOTP }),
      );
    });

    it('rejects with generic 401 when old password is wrong + audits INVALID_CREDENTIALS', async () => {
      const { service, credRepo, userRepo, argon2, audit } = makeService();
      userRepo.findOne.mockResolvedValue({ id: 'user-1', emailHash: 'hash-1' });
      credRepo.findOne.mockResolvedValue(makeCredential());
      argon2.verify.mockResolvedValue(false);

      await expect(
        service.changePassword('user-1', 'wrong', newPw, '123456', 'thaid'),
      ).rejects.toThrow(UnauthorizedException);
      // Distinguishes wrong-password from wrong-totp in the audit
      // log (super-admin daily summary).
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: BACKUP_OUTCOME.INVALID_CREDENTIALS }),
      );
    });

    it('rejects when caller has no credential', async () => {
      const { service, credRepo, userRepo } = makeService();
      userRepo.findOne.mockResolvedValue({ id: 'user-1', emailHash: 'hash-1' });
      credRepo.findOne.mockResolvedValue(null);

      await expect(
        service.changePassword('user-1', oldPw, newPw, '123456', 'thaid'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects when caller is unknown', async () => {
      const { service, userRepo } = makeService();
      userRepo.findOne.mockResolvedValue(null);

      await expect(
        service.changePassword('user-1', oldPw, newPw, '123456', 'thaid'),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects when credential is frozen (anti-enum 401)', async () => {
      const { service, credRepo, userRepo } = makeService();
      userRepo.findOne.mockResolvedValue({ id: 'user-1', emailHash: 'hash-1' });
      credRepo.findOne.mockResolvedValue(
        makeCredential({ frozenAt: new Date() }),
      );

      await expect(
        service.changePassword('user-1', oldPw, newPw, '123456', 'thaid'),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('changePassword — happy path with TOTP', () => {
    it('succeeds + returns accessToken when old-pw + TOTP both valid', async () => {
      const { service, credRepo, userRepo, totp } = makeService();
      userRepo.findOne.mockResolvedValue({ id: 'user-1', emailHash: 'hash-1' });
      credRepo.findOne.mockResolvedValue(makeCredential());
      totp.hasConfirmed.mockResolvedValue(true);
      totp.verifyCode.mockResolvedValue(true);

      const result = await service.changePassword(
        'user-1',
        'old-correct',
        'Aa1!validNewPasswordSafe',
        '123456',
        'backup',
      );

      expect(result.accessToken).toBe('new-access-token');
      expect(totp.verifyCode).toHaveBeenCalledWith('user-1', '123456');
    });
  });
});
