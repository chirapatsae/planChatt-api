import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { hashEmail } from 'src/util/encryption.util';
import { User } from 'src/users/entities/user.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { BackupCredential } from './entities/backup-credential.entity';
import { TotpEnrollment } from './entities/totp-enrollment.entity';
import { BackupLoginAuditLog } from './entities/backup-login-audit-log.entity';
import { Argon2Service } from './argon2.service';
import { PasswordPolicyService } from './password-policy.service';
import { LockoutService, EscalationResult } from './lockout.service';
import { SessionVersionService } from './session-version.service';
import { TotpService } from './totp.service';
import { KillSwitchService } from './kill-switch.service';
import { BackupAttemptAuditService } from './backup-attempt-audit.service';
import { BackupLineNotifier } from './backup-line-notifier.service';
import {
  BACKUP_LOGIN_DENIED_CODE,
  BACKUP_LOGIN_DENIED_MESSAGE,
  BACKUP_OUTCOME,
  BackupAttemptOutcome,
} from './constants/error-messages';
import { isBackupLoginEligibleRole } from './constants/eligible-roles';
import { Role } from 'src/auth/roles.enum';
import { UsersService } from 'src/users/users.service';
import { WorkHistoryService } from 'src/work-history/work-history.service';
import { WorkStatus } from 'src/work-status/entities/work-status.entity';
import { CreateMemberDto } from './dto/create-member.dto';

/**
 * SECURITY-01 §7.7 — JWT shapes.
 */
interface MfaChallengePayload {
  sub: string;
  /**
   * Always `'backup-mfa-challenge'` for legitimately-issued tokens —
   * the field is typed as `string` (not the literal) so the runtime
   * comparison guard `payload.purpose !== 'backup-mfa-challenge'` is
   * not flagged as always-false by TS (it defends against a forged
   * token whose `purpose` claim does not match).
   */
  purpose: string;
  bootstrap?: boolean;
  iat?: number;
  exp?: number;
}

interface BackupSessionPayload {
  sub: string;
  role: string | null;
  workStatus: string | null;
  // AUTH-REDESIGN (2026-07-08): promoted from fallback to PRIMARY staff login.
  // Sessions are now labelled 'password' (email + password + TOTP).
  loginMethod: 'password';
  mfaVerified: boolean;
  sessionVersion: number;
  requirePasswordChange?: boolean;
  requireTotpEnrollment?: boolean;
  iat?: number;
  exp?: number;
}

/**
 * Orchestrator for the backup-login flow (SECURITY-01 §7.8 / §7.9).
 *
 * Owns the credential / TOTP / kill-switch / lockout / audit pipeline.
 * Admin operations (issue / reset / revoke / unfreeze / kill-switch /
 * audit listing) also live here.
 */
@Injectable()
export class BackupLoginService {
  private readonly logger = new Logger(BackupLoginService.name);

  constructor(
    @InjectRepository(BackupCredential)
    private readonly credRepo: Repository<BackupCredential>,
    @InjectRepository(TotpEnrollment)
    private readonly totpRepo: Repository<TotpEnrollment>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(WorkHistory)
    private readonly whRepo: Repository<WorkHistory>,
    private readonly jwtService: JwtService,
    private readonly argon2: Argon2Service,
    private readonly passwordPolicy: PasswordPolicyService,
    private readonly lockout: LockoutService,
    private readonly sessionVersion: SessionVersionService,
    private readonly totp: TotpService,
    private readonly killSwitch: KillSwitchService,
    private readonly audit: BackupAttemptAuditService,
    private readonly lineNotifier: BackupLineNotifier,
    // AUTH-REDESIGN (2026-07-08) — admin create-member orchestration.
    private readonly usersService: UsersService,
    private readonly workHistoryService: WorkHistoryService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  // ============================================================
  //  Admin: create member (AUTH-REDESIGN 2026-07-08)
  // ============================================================

  /**
   * Create a brand-new staff member and issue their initial credential
   * in one call. Replaces ThaID auto-provisioning. Steps:
   *   1. Create the `users` row (email identity, no national ID).
   *   2. Create a pending `work_history` (role + org placement).
   *   3. Issue a one-time password (mustChangeOnNextLogin=true).
   * The member then logs in via `/auth/login`, is forced to change the
   * password, and MUST enrol TOTP before the session is usable.
   *
   * Returns the plaintext one-time password so the admin can hand it to
   * the member through a secure side channel. It is NEVER logged.
   */
  async createMember(
    actorUserId: string,
    dto: CreateMemberDto,
  ): Promise<{ userId: string; email: string; plaintextPassword: string }> {
    const user = await this.usersService.createMember({
      prefix: dto.prefix,
      firstname: dto.firstname,
      lastname: dto.lastname,
      email: dto.email,
      phone: dto.phone,
      consentVersion: dto.consentVersion ?? null,
    });

    // AUTH-REDESIGN (2026-07-08): admin-created members are approved on
    // creation — the admin act IS the authorization. Without this the
    // member's work_history defaults to `pending` and the promoted
    // backup-login pipeline (which requires `approved` to authenticate)
    // would refuse their first login. See docs/AUTH-REDESIGN.md §8.1.
    const approvedStatus = await this.dataSource
      .getRepository(WorkStatus)
      .findOneBy({ name: 'approved' });

    await this.workHistoryService.create(
      {
        userId: user.id,
        amphoeId: dto.amphoeId,
        localAdministrativeOrganizationId:
          dto.localAdministrativeOrganizationId,
        roleId: dto.roleId,
        governmentAgenciesId: dto.governmentAgenciesId,
        // Approved on creation (falls back to 'pending' if the seed row
        // is somehow absent).
        workStatusId: approvedStatus?.id,
      },
      actorUserId,
    );

    const issued = await this.issueCredential(actorUserId, user.id);

    this.logger.log(
      `auth.member.create actorId=${actorUserId} memberId=${user.id} at=${new Date().toISOString()}`,
    );

    return {
      userId: user.id,
      email: dto.email,
      plaintextPassword: issued.plaintextPassword,
    };
  }

  // ============================================================
  //  /init — credential stage
  // ============================================================

  async attemptInit(args: {
    username: string;
    password: string;
    ip: string;
    userAgent: string | null;
  }): Promise<{
    mfaChallengeToken: string;
    requireTotpEnrollment?: boolean;
  }> {
    const usernameLower = (args.username || '').trim().toLowerCase();

    // 1. Kill-switch
    if (!(await this.killSwitch.isEnabled())) {
      await this.audit.write({
        userIdOrNull: null,
        usernameAttempted: usernameLower,
        stage: 'init',
        ip: args.ip,
        userAgent: args.userAgent,
        outcome: BACKUP_OUTCOME.KILLSWITCH_OFF,
      });
      this.denyGeneric();
    }

    // 2. Resolve user by email-hash (the canonical backup-login username).
    //    Use the raw repo — we don't need PII decryption here.
    const user = usernameLower
      ? await this.userRepo.findOne({
          where: { emailHash: hashEmail(usernameLower) },
        })
      : null;

    if (!user) {
      // Anti-enumeration: run a dummy Argon2 verify so this branch's
      // wall-clock cost matches the real-verify branch within ±50ms.
      await this.argon2.verifyDummy(args.password);
      await this.audit.write({
        userIdOrNull: null,
        usernameAttempted: usernameLower,
        stage: 'init',
        ip: args.ip,
        userAgent: args.userAgent,
        outcome: BACKUP_OUTCOME.INVALID_CREDENTIALS,
      });
      this.denyGeneric();
    }

    // 3. Load credential. Absent / revoked → not_eligible.
    const credential = await this.credRepo.findOne({
      where: { userId: user.id },
    });
    if (!credential || credential.revokedAt) {
      await this.argon2.verifyDummy(args.password);
      await this.audit.write({
        userIdOrNull: user.id,
        usernameAttempted: usernameLower,
        stage: 'init',
        ip: args.ip,
        userAgent: args.userAgent,
        outcome: BACKUP_OUTCOME.NOT_ELIGIBLE,
      });
      void this.lineNotifier.notifyPerAttempt({
        userId: user.id,
        outcome: BACKUP_OUTCOME.NOT_ELIGIBLE,
        ip: args.ip,
        attemptedAt: new Date(),
      });
      this.denyGeneric();
    }

    // 4. Frozen
    if (credential.frozenAt) {
      await this.audit.write({
        userIdOrNull: user.id,
        usernameAttempted: usernameLower,
        stage: 'init',
        ip: args.ip,
        userAgent: args.userAgent,
        outcome: BACKUP_OUTCOME.FROZEN,
      });
      void this.lineNotifier.notifyPerAttempt({
        userId: user.id,
        outcome: BACKUP_OUTCOME.FROZEN,
        ip: args.ip,
        attemptedAt: new Date(),
      });
      this.denyGeneric();
    }

    // 5. Locked
    if (credential.lockedUntil && credential.lockedUntil.getTime() > Date.now()) {
      const isLong = credential.lockedUntil.getTime() - Date.now() > 60 * 60_000;
      const outcome = isLong
        ? BACKUP_OUTCOME.LOCKED_24H
        : BACKUP_OUTCOME.LOCKED;
      await this.audit.write({
        userIdOrNull: user.id,
        usernameAttempted: usernameLower,
        stage: 'init',
        ip: args.ip,
        userAgent: args.userAgent,
        outcome,
      });
      void this.lineNotifier.notifyPerAttempt({
        userId: user.id,
        outcome,
        ip: args.ip,
        attemptedAt: new Date(),
      });
      this.denyGeneric();
    }

    // 6. Eligibility + workStatus
    const wh = await this.loadCurrentWorkHistory(user.id);
    const roleName = wh?.role?.name ?? null;
    const workStatusName = wh?.workStatus?.name ?? null;
    if (
      !isBackupLoginEligibleRole(roleName) ||
      (workStatusName ?? '').toLowerCase() !== 'approved'
    ) {
      await this.argon2.verifyDummy(args.password);
      await this.audit.write({
        userIdOrNull: user.id,
        usernameAttempted: usernameLower,
        stage: 'init',
        ip: args.ip,
        userAgent: args.userAgent,
        outcome: BACKUP_OUTCOME.NOT_ELIGIBLE,
      });
      void this.lineNotifier.notifyPerAttempt({
        userId: user.id,
        outcome: BACKUP_OUTCOME.NOT_ELIGIBLE,
        ip: args.ip,
        attemptedAt: new Date(),
      });
      this.denyGeneric();
    }

    // 7. Verify password
    const ok = await this.argon2.verify(credential.passwordHash, args.password);
    if (!ok) {
      const esc = await this.lockout.recordFailure(user.id);
      await this.applyEscalation(credential.id, user.id, esc);
      await this.audit.write({
        userIdOrNull: user.id,
        usernameAttempted: usernameLower,
        stage: 'init',
        ip: args.ip,
        userAgent: args.userAgent,
        outcome: BACKUP_OUTCOME.INVALID_CREDENTIALS,
      });
      void this.lineNotifier.notifyPerAttempt({
        userId: user.id,
        outcome: BACKUP_OUTCOME.INVALID_CREDENTIALS,
        ip: args.ip,
        attemptedAt: new Date(),
      });
      this.denyGeneric();
    }

    // 8. Determine TOTP state for the challenge response
    const totpRow = await this.totpRepo.findOne({
      where: { userId: user.id },
    });
    const totpConfirmed = !!totpRow?.confirmedAt;

    // 9. First-login TOTP-enrollment grace (AUTH-REDESIGN 2026-07-08).
    //    Previously this was a narrow "first-ever credential" bootstrap
    //    exemption (totalCredCount === 1) because staff enrolled TOTP via
    //    their ThaID-authenticated /profile session. With ThaID removed,
    //    EVERY admin-issued member must be able to enrol TOTP on their
    //    first password login — so the grace now applies to ANY freshly
    //    issued credential (mustChangeOnNextLogin) that has no confirmed
    //    TOTP yet. TOTP is still MANDATORY: the /complete stage forces
    //    enrollment (requireTotpEnrollment) before the session is usable.
    const isBootstrap =
      !totpConfirmed && credential.mustChangeOnNextLogin === true;

    const mfaChallengeToken = this.jwtService.sign(
      {
        sub: user.id,
        purpose: 'backup-mfa-challenge',
        bootstrap: isBootstrap,
      } satisfies MfaChallengePayload,
      {
        secret: process.env.JWT_SECRET,
        expiresIn: '5m',
      },
    );

    if (!totpConfirmed && !isBootstrap) {
      // Credentials valid, but TOTP not enrolled and we're NOT in the
      // bootstrap exemption — caller cannot complete. Generic 401.
      await this.audit.write({
        userIdOrNull: user.id,
        usernameAttempted: usernameLower,
        stage: 'init',
        ip: args.ip,
        userAgent: args.userAgent,
        outcome: BACKUP_OUTCOME.MFA_REQUIRED,
      });
      void this.lineNotifier.notifyPerAttempt({
        userId: user.id,
        outcome: BACKUP_OUTCOME.MFA_REQUIRED,
        ip: args.ip,
        attemptedAt: new Date(),
      });
      this.denyGeneric();
    }

    // 10. Audit the credential-OK step as `mfa_required` (per
    //     SECURITY-01 §7.12.1 reconciliation: `success` is for the
    //     /complete stage only).
    await this.audit.write({
      userIdOrNull: user.id,
      usernameAttempted: usernameLower,
      stage: 'init',
      ip: args.ip,
      userAgent: args.userAgent,
      outcome: BACKUP_OUTCOME.MFA_REQUIRED,
    });
    return {
      mfaChallengeToken,
      ...(isBootstrap ? { requireTotpEnrollment: true } : {}),
    };
  }

  // ============================================================
  //  /complete — TOTP stage
  // ============================================================

  async attemptComplete(args: {
    mfaChallengeToken: string;
    totpCode: string | undefined;
    ip: string;
    userAgent: string | null;
  }): Promise<{
    accessToken: string;
    requirePasswordChange: boolean;
    requireTotpEnrollment: boolean;
    user?: Record<string, unknown>;
  }> {
    let payload: MfaChallengePayload;
    try {
      payload = this.jwtService.verify<MfaChallengePayload>(
        args.mfaChallengeToken,
        { secret: process.env.JWT_SECRET },
      );
    } catch {
      await this.audit.write({
        userIdOrNull: null,
        usernameAttempted: '',
        stage: 'complete',
        ip: args.ip,
        userAgent: args.userAgent,
        outcome: BACKUP_OUTCOME.CHALLENGE_EXPIRED,
      });
      this.denyGeneric();
    }
    if (payload.purpose !== 'backup-mfa-challenge') {
      await this.audit.write({
        userIdOrNull: payload.sub ?? null,
        usernameAttempted: '',
        stage: 'complete',
        ip: args.ip,
        userAgent: args.userAgent,
        outcome: BACKUP_OUTCOME.CHALLENGE_EXPIRED,
      });
      this.denyGeneric();
    }

    if (!(await this.killSwitch.isEnabled())) {
      await this.audit.write({
        userIdOrNull: payload.sub,
        usernameAttempted: '',
        stage: 'complete',
        ip: args.ip,
        userAgent: args.userAgent,
        outcome: BACKUP_OUTCOME.KILLSWITCH_OFF,
      });
      this.denyGeneric();
    }

    const user = await this.userRepo.findOne({
      where: { id: payload.sub },
    });
    if (!user) this.denyGeneric();

    const credential = await this.credRepo.findOne({
      where: { userId: user.id },
    });
    if (!credential || credential.revokedAt || credential.frozenAt) {
      await this.audit.write({
        userIdOrNull: user.id,
        usernameAttempted: '',
        stage: 'complete',
        ip: args.ip,
        userAgent: args.userAgent,
        outcome: BACKUP_OUTCOME.NOT_ELIGIBLE,
      });
      this.denyGeneric();
    }
    if (
      credential.lockedUntil &&
      credential.lockedUntil.getTime() > Date.now()
    ) {
      const isLong = credential.lockedUntil.getTime() - Date.now() > 60 * 60_000;
      await this.audit.write({
        userIdOrNull: user.id,
        usernameAttempted: '',
        stage: 'complete',
        ip: args.ip,
        userAgent: args.userAgent,
        outcome: isLong ? BACKUP_OUTCOME.LOCKED_24H : BACKUP_OUTCOME.LOCKED,
      });
      this.denyGeneric();
    }

    const wh = await this.loadCurrentWorkHistory(user.id);
    const roleName = wh?.role?.name ?? null;
    const workStatusName = wh?.workStatus?.name ?? null;
    if (
      !isBackupLoginEligibleRole(roleName) ||
      (workStatusName ?? '').toLowerCase() !== 'approved'
    ) {
      await this.audit.write({
        userIdOrNull: user.id,
        usernameAttempted: '',
        stage: 'complete',
        ip: args.ip,
        userAgent: args.userAgent,
        outcome: BACKUP_OUTCOME.NOT_ELIGIBLE,
      });
      this.denyGeneric();
    }

    const totpRow = await this.totpRepo.findOne({ where: { userId: user.id } });
    const totpConfirmed = !!totpRow?.confirmedAt;

    let mfaVerified = false;
    let requireTotpEnrollment = false;

    if (payload.bootstrap === true && !totpConfirmed) {
      // Dual-bootstrap exemption — skip TOTP verify, force enrollment
      // after login.
      requireTotpEnrollment = true;
      mfaVerified = false;
    } else {
      if (!args.totpCode) {
        await this.audit.write({
          userIdOrNull: user.id,
          usernameAttempted: '',
          stage: 'complete',
          ip: args.ip,
          userAgent: args.userAgent,
          outcome: BACKUP_OUTCOME.INVALID_TOTP,
        });
        this.denyGeneric();
      }
      const ok = await this.totp.verifyCode(user.id, args.totpCode);
      if (!ok) {
        const esc = await this.lockout.recordFailure(user.id);
        await this.applyEscalation(credential.id, user.id, esc);
        await this.audit.write({
          userIdOrNull: user.id,
          usernameAttempted: '',
          stage: 'complete',
          ip: args.ip,
          userAgent: args.userAgent,
          outcome: BACKUP_OUTCOME.INVALID_TOTP,
        });
        void this.lineNotifier.notifyPerAttempt({
          userId: user.id,
          outcome: BACKUP_OUTCOME.INVALID_TOTP,
          ip: args.ip,
          attemptedAt: new Date(),
        });
        this.denyGeneric();
      }
      mfaVerified = true;
    }

    // Reset failure counters on full success.
    await this.lockout.recordSuccess(user.id);
    await this.credRepo.update(credential.id, {
      failedAttempts: 0,
      lockedUntil: null,
    });

    const requirePasswordChange = credential.mustChangeOnNextLogin === true;
    const auditOutcome: BackupAttemptOutcome = requirePasswordChange
      ? BACKUP_OUTCOME.MUST_CHANGE_PASSWORD
      : BACKUP_OUTCOME.SUCCESS;

    await this.audit.write({
      userIdOrNull: user.id,
      usernameAttempted: '',
      stage: 'complete',
      ip: args.ip,
      userAgent: args.userAgent,
      outcome: auditOutcome,
    });
    void this.lineNotifier.notifyPerAttempt({
      userId: user.id,
      outcome: auditOutcome,
      ip: args.ip,
      attemptedAt: new Date(),
    });

    const sessionVersion = await this.sessionVersion.read(user.id);
    const sessionPayload: BackupSessionPayload = {
      sub: user.id,
      role: roleName,
      workStatus: workStatusName,
      loginMethod: 'password',
      mfaVerified,
      sessionVersion,
      ...(requirePasswordChange ? { requirePasswordChange: true } : {}),
      ...(requireTotpEnrollment ? { requireTotpEnrollment: true } : {}),
    };
    const accessToken = this.jwtService.sign(sessionPayload, {
      secret: process.env.JWT_SECRET,
      expiresIn: '8h',
    });

    // Only emit the `user` payload on the fully-authenticated happy
    // path (no forced flows left). FE consumes it via loginAsync to
    // hydrate the greeting bar + sidebar surfaces; on forced flows the
    // FE is bouncing to /auth/change-password or /auth/totp-enroll
    // which carry the token via router state and do NOT touch Redux
    // until the gate clears.
    const userPayload =
      !requirePasswordChange && !requireTotpEnrollment
        ? (await this.buildUserPayload(user.id)) ?? undefined
        : undefined;

    return {
      accessToken,
      requirePasswordChange,
      requireTotpEnrollment,
      ...(userPayload ? { user: userPayload } : {}),
    };
  }

  // ============================================================
  //  Profile self-service: status + self-enroll
  //  (Wave wave-backup-login-profile-self-enroll / BE-01)
  // ============================================================

  /**
   * SECURITY-01 §7.1 row 1 + §7.4 — caller's own backup-credential
   * status. JWT-authed; NOT gated by `WorkStatusApprovedGuard` so a
   * non-approved user can still see their state on /profile.
   *
   * NEVER throws "credential not found" — absence is a normal state
   * for a brand-new user. Returns an all-false shape.
   *
   * NEVER exposes sensitive fields (`passwordHash`, `frozenReason`,
   * `revokedReason`, `failedAttempts`, `lockedUntil`).
   */
  async getMyBackupStatus(callerUserId: string): Promise<{
    hasCredential: boolean;
    mustChangeOnNextLogin: boolean;
    isFrozen: boolean;
    isRevoked: boolean;
    hasConfirmedTotp: boolean;
    passwordSetAt: string | null;
  }> {
    const credential = await this.credRepo.findOne({
      where: { userId: callerUserId },
    });
    if (!credential) {
      return {
        hasCredential: false,
        mustChangeOnNextLogin: false,
        isFrozen: false,
        isRevoked: false,
        hasConfirmedTotp: false,
        passwordSetAt: null,
      };
    }
    const hasConfirmedTotp = await this.totp.hasConfirmed(callerUserId);
    const isRevoked = !!credential.revokedAt;
    return {
      // Treat revoked as "no credential" so the FE renders State A
      // "ยังไม่ได้ตั้งค่ารหัสผ่านสำรอง" (SECURITY-01 §7.5).
      hasCredential: !isRevoked,
      mustChangeOnNextLogin: credential.mustChangeOnNextLogin === true,
      isFrozen: !!credential.frozenAt,
      isRevoked,
      hasConfirmedTotp,
      passwordSetAt: credential.passwordSetAt
        ? credential.passwordSetAt.toISOString()
        : null,
    };
  }

  /**
   * SECURITY-01 §7.1 row 2 + §7.3 — first-time self-enrollment.
   *
   * Anti-enum: if the caller already has an ACTIVE credential the
   * service throws the generic 401 with the SAME response body as
   * wrong-password (NEVER 409, NEVER "already exists"). Per
   * SECURITY-01 §9.2 a JWT-thief MUST NOT be able to probe credential
   * state via this endpoint.
   *
   * Re-enrolling over a REVOKED row is the natural path: clears
   * lockout / freeze / revoke fields, resets failure counters, resets
   * password history.
   */
  async selfEnrollPassword(
    callerUserId: string,
    password: string,
  ): Promise<void> {
    const user = await this.userRepo.findOne({ where: { id: callerUserId } });
    if (!user) {
      // Defensive — should never happen post-JwtAuthGuard. Burn time
      // so this branch is timing-uniform with the success path.
      await this.argon2.verifyDummy(password);
      this.denyGeneric();
    }
    if (!user.emailHash) {
      // Username (emailHash) is required to populate the unique
      // `username_email_hash` column. Treat the same as ineligible —
      // user must register an email first.
      await this.argon2.verifyDummy(password);
      this.denyGeneric();
    }

    const existing = await this.credRepo.findOne({
      where: { userId: callerUserId },
    });

    // Anti-enum branch: caller already holds an ACTIVE credential.
    // SECURITY-01 §7.7 row "/self-enroll already-exists" — generic
    // 401 with dummy Argon2 cost for timing parity (§7.7
    // timing-oracle defense). Audit outcome `not_eligible`.
    if (existing && !existing.revokedAt) {
      await this.argon2.verifyDummy(password);
      try {
        await this.audit.write({
          userIdOrNull: callerUserId,
          usernameAttempted: user.emailHash,
          stage: 'init',
          ip: '0.0.0.0',
          userAgent: null,
          outcome: BACKUP_OUTCOME.NOT_ELIGIBLE,
        });
      } catch (err) {
        this.logger.warn(
          `[selfEnroll] audit write (not_eligible) failed: ${(err as Error).message}`,
        );
      }
      this.denyGeneric();
    }

    // Full password policy validation. `userId` is passed so the
    // history-no-reuse check fires. On re-enroll over a revoked row
    // the history is cleared inside the transaction below, so a
    // subsequent retry with the same password would succeed — but
    // the FIRST validate call still sees the old history. This is
    // the intentional ordering: we revalidate AFTER history reset on
    // re-enroll. To keep the simpler control flow, re-enroll skips
    // history-no-reuse by passing `null`.
    const username = (user.emailHash || user.id).toLowerCase();
    const skipHistoryCheck = !!existing && !!existing.revokedAt;
    await this.passwordPolicy.validate(
      password,
      username,
      skipHistoryCheck ? null : callerUserId,
    );

    const newHash = await this.argon2.hash(password);

    await this.dataSource.transaction(async (em) => {
      if (existing) {
        // Re-activate revoked row.
        await em.getRepository(BackupCredential).update(existing.id, {
          passwordHash: newHash,
          passwordSetAt: new Date(),
          passwordSetByUserId: callerUserId,
          mustChangeOnNextLogin: false,
          failedAttempts: 0,
          lockedUntil: null,
          frozenAt: null,
          frozenReason: null,
          revokedAt: null,
          revokedByUserId: null,
          revokedReason: null,
          usernameEmailHash: user.emailHash!,
        });
        // Reset password history so the user is not bound by hashes
        // from the prior (revoked) life of the credential.
        await this.passwordPolicy.reset(callerUserId, em);
      } else {
        await em.getRepository(BackupCredential).insert({
          userId: callerUserId,
          usernameEmailHash: user.emailHash!,
          passwordHash: newHash,
          passwordSetAt: new Date(),
          passwordSetByUserId: callerUserId,
          mustChangeOnNextLogin: false,
          failedAttempts: 0,
        });
      }
      // SECURITY note (2026-05-27): session_version is INTENTIONALLY
      // NOT bumped on self-enroll. Self-enroll is a first-time
      // credential creation — there is no prior backup session to
      // invalidate (admin issue/reset/revoke paths bump because they
      // affect an existing credential row). Bumping here would also
      // invalidate the caller's ThaiD session (session_version is
      // unified per SECURITY-01 §7.8), force-logging them out of
      // /profile mid-flight between Step 1 (set password) and Step 2
      // (enroll TOTP). The wizard would receive 401 SESSION_INVALIDATED
      // on /totp-enroll/init and the axios interceptor would force-
      // logout. No bump → ThaiD session stays valid throughout the
      // wizard.
      // Audit success row inside the same transaction so a roll-back
      // of the credential write also rolls back the audit.
      await em.getRepository(BackupLoginAuditLog).insert({
        userId: callerUserId,
        usernameAttempted: (user.emailHash || '').slice(0, 256),
        stage: 'init',
        ipAddress: '0.0.0.0',
        subnet24: '0.0.0.0/24',
        userAgent: null,
        outcome: BACKUP_OUTCOME.SELF_ENROLL_SUCCESS,
      });
    });

    // SECURITY-01 §7.3 — LINE notify the affected user (best effort).
    await this.lineNotifier.notifyEventToUser(
      callerUserId,
      'คุณได้ตั้งค่ารหัสผ่านสำรองเรียบร้อย หากไม่ใช่คุณ กรุณาติดต่อผู้ดูแลระบบทันที',
    );
  }

  // ============================================================
  //  Password change (user-self)
  // ============================================================

  async changePassword(
    callerUserId: string,
    oldPassword: string,
    newPassword: string,
    totpCode: string | undefined,
    callerLoginMethod: 'thaid' | 'backup' | 'password' | undefined,
  ): Promise<{ accessToken: string }> {
    const user = await this.userRepo.findOne({ where: { id: callerUserId } });
    if (!user) throw new NotFoundException('USER_NOT_FOUND');
    const credential = await this.credRepo.findOne({
      where: { userId: callerUserId },
    });
    if (!credential || credential.revokedAt) {
      throw new ForbiddenException('NO_BACKUP_CREDENTIAL');
    }
    if (credential.frozenAt) {
      // SECURITY-01 §7.7 row "/change-password credential frozen" →
      // generic 401 (frozen user cannot self-recover via change-pw).
      throw new UnauthorizedException({
        code: BACKUP_LOGIN_DENIED_CODE,
        message: BACKUP_LOGIN_DENIED_MESSAGE,
      });
    }
    const ok = await this.argon2.verify(credential.passwordHash, oldPassword);
    if (!ok) {
      // Audit the internal reason (the response stays generic 401 —
      // SECURITY-01 §7.7 row "/change-password wrong old password").
      // Distinct from WRONG_TOTP so super-admin daily summary can
      // tell the two apart in the rolling failure log.
      try {
        await this.audit.write({
          userIdOrNull: callerUserId,
          usernameAttempted: (user.emailHash || '').slice(0, 256),
          stage: 'complete',
          ip: '0.0.0.0',
          userAgent: null,
          outcome: BACKUP_OUTCOME.INVALID_CREDENTIALS,
        });
      } catch (err) {
        this.logger.warn(
          `[changePassword] audit write (invalid_credentials) failed: ${(err as Error).message}`,
        );
      }
      throw new UnauthorizedException({
        code: BACKUP_LOGIN_DENIED_CODE,
        message: BACKUP_LOGIN_DENIED_MESSAGE,
      });
    }

    // SECURITY-01 §7.2 — forced-flow exception (the ONLY case where
    // `totpCode` may be omitted). All 3 conditions MUST be true
    // simultaneously (boolean AND). Resolved server-side from DB +
    // JWT — never from request body claims.
    const hasConfirmedTotp = await this.totp.hasConfirmed(callerUserId);
    const isForcedFlowException =
      credential.mustChangeOnNextLogin === true &&
      hasConfirmedTotp === false &&
      // AUTH-REDESIGN: 'password' is the promoted primary session label
      // ('backup' kept for backward-compat with in-flight tokens).
      (callerLoginMethod === 'password' || callerLoginMethod === 'backup');

    if (!isForcedFlowException) {
      // §7.7 row "/change-password TOTP missing" — SAME generic 401
      // as wrong-old-password. A "totpCode required" message would
      // be an oracle on whether the caller is in the exception state.
      if (!totpCode) {
        // Equalize timing with the genuine verify branch — a missing
        // code would otherwise short-circuit before the TOTP work.
        try {
          await this.totp.verifyCode(callerUserId, '000000');
        } catch {
          // discard — timing burn only
        }
        // Audit the internal reason (never returned to caller).
        try {
          await this.audit.write({
            userIdOrNull: callerUserId,
            usernameAttempted: (user.emailHash || '').slice(0, 256),
            stage: 'complete',
            ip: '0.0.0.0',
            userAgent: null,
            outcome: BACKUP_OUTCOME.WRONG_TOTP,
          });
        } catch (err) {
          this.logger.warn(
            `[changePassword] audit write (wrong_totp, missing) failed: ${(err as Error).message}`,
          );
        }
        throw new UnauthorizedException({
          code: BACKUP_LOGIN_DENIED_CODE,
          message: BACKUP_LOGIN_DENIED_MESSAGE,
        });
      }
      const totpOk = await this.totp.verifyCode(callerUserId, totpCode);
      if (!totpOk) {
        // §7.7 row "/change-password TOTP invalid/expired/replayed"
        // — SAME generic 401 as wrong-old-password.
        try {
          await this.audit.write({
            userIdOrNull: callerUserId,
            usernameAttempted: (user.emailHash || '').slice(0, 256),
            stage: 'complete',
            ip: '0.0.0.0',
            userAgent: null,
            outcome: BACKUP_OUTCOME.WRONG_TOTP,
          });
        } catch (err) {
          this.logger.warn(
            `[changePassword] audit write (wrong_totp, invalid) failed: ${(err as Error).message}`,
          );
        }
        throw new UnauthorizedException({
          code: BACKUP_LOGIN_DENIED_CODE,
          message: BACKUP_LOGIN_DENIED_MESSAGE,
        });
      }
    }

    const username = (user.emailHash ? user.emailHash : user.id).toLowerCase();
    await this.passwordPolicy.validate(newPassword, username, user.id);

    const newHash = await this.argon2.hash(newPassword);

    await this.dataSource.transaction(async (em) => {
      // Push the OLD hash into history first so reuse checks include it.
      await this.passwordPolicy.push(callerUserId, credential.passwordHash);
      await em.getRepository(BackupCredential).update(credential.id, {
        passwordHash: newHash,
        passwordSetAt: new Date(),
        passwordSetByUserId: callerUserId,
        mustChangeOnNextLogin: false,
      });
      await this.sessionVersion.bump(callerUserId, em);
    });

    await this.lineNotifier.notifyEventToUser(
      callerUserId,
      'รหัสผ่านสำรองของบัญชีคุณถูกเปลี่ยนเรียบร้อย หากไม่ใช่คุณ กรุณาติดต่อผู้ดูแลระบบ',
    );

    // CRITICAL: bump session_version above invalidates the caller's
    // current JWT (the changeToken). Mint a NEW backup-session JWT
    // carrying the bumped sessionVersion so the FE can immediately
    // continue into the TOTP enrollment flow without being kicked back
    // to the login page by JwtAuthGuard's session-version check.
    //
    // The new token carries `requireTotpEnrollment: true` if the user
    // has no confirmed TOTP yet — FE branches on that flag.
    const wh = await this.loadCurrentWorkHistory(callerUserId);
    const roleName = wh?.role?.name ?? null;
    const workStatusName = wh?.workStatus?.name ?? null;
    // Re-evaluate TOTP confirmation state post-password-change so the
    // new session token reflects whether the user still needs to
    // enroll. Renamed from `hasConfirmedTotp` to avoid the
    // block-scope collision with the earlier read at the top of the
    // function (which fed the forced-flow exception check).
    const hasConfirmedTotpAfter = await this.totp.hasConfirmed(callerUserId);
    const requireTotpEnrollment = !hasConfirmedTotpAfter;
    const sessionVersion = await this.sessionVersion.read(callerUserId);
    const sessionPayload: BackupSessionPayload = {
      sub: callerUserId,
      role: roleName,
      workStatus: workStatusName,
      loginMethod: 'password',
      mfaVerified: false,
      sessionVersion,
      ...(requireTotpEnrollment ? { requireTotpEnrollment: true } : {}),
    };
    const accessToken = this.jwtService.sign(sessionPayload, {
      secret: process.env.JWT_SECRET,
      expiresIn: '8h',
    });
    return { accessToken };
  }

  // ============================================================
  //  TOTP enroll
  // ============================================================

  async enrollTotpInit(
    callerUserId: string,
  ): Promise<{ secretBase32: string; qrDataUrl: string }> {
    const user = await this.userRepo.findOne({ where: { id: callerUserId } });
    if (!user) throw new NotFoundException('USER_NOT_FOUND');
    const label = user.email || user.id;
    return this.totp.enrollInit(callerUserId, label);
  }

  async enrollTotpComplete(
    callerUserId: string,
    code: string,
    isForcedFlow = false,
  ): Promise<{ accessToken: string; user: Record<string, unknown> | null }> {
    const ok = await this.totp.enrollComplete(callerUserId, code);
    if (!ok) {
      throw new UnauthorizedException({
        code: BACKUP_LOGIN_DENIED_CODE,
        message: BACKUP_LOGIN_DENIED_MESSAGE,
      });
    }
    await this.lineNotifier.notifyEventToUser(
      callerUserId,
      'TOTP ของบัญชีคุณถูกเปิดใช้งานเรียบร้อย',
    );

    // Bump session_version ONLY for forced-flow callers (transient
    // enrollment token from admin-issued one-time password path) —
    // those carry `requireTotpEnrollment: true` and the bump
    // invalidates the transient token after enrollment completes.
    //
    // Self-enroll callers from /profile use a ThaiD session JWT
    // (claim is undefined). Bumping there invalidates the caller's
    // own ThaiD session → 401 SESSION_INVALIDATED on the next
    // request → axios interceptor force-logout → user kicked back
    // to /login mid-wizard. Skip the bump for them. The new
    // accessToken is still minted (returned to FE) but the existing
    // ThaiD JWT remains valid.
    if (isForcedFlow) {
      await this.sessionVersion.bump(callerUserId);
    }
    const wh = await this.loadCurrentWorkHistory(callerUserId);
    const roleName = wh?.role?.name ?? null;
    const workStatusName = wh?.workStatus?.name ?? null;
    const sessionVersion = await this.sessionVersion.read(callerUserId);
    const sessionPayload: BackupSessionPayload = {
      sub: callerUserId,
      role: roleName,
      workStatus: workStatusName,
      loginMethod: 'password',
      mfaVerified: true,
      sessionVersion,
    };
    const accessToken = this.jwtService.sign(sessionPayload, {
      secret: process.env.JWT_SECRET,
      expiresIn: '8h',
    });
    const user = await this.buildUserPayload(callerUserId);
    return { accessToken, user };
  }

  // ============================================================
  //  Admin: issue / reset / revoke / unfreeze / TOTP reset
  // ============================================================

  async issueCredential(
    actorUserId: string,
    targetUserId: string,
  ): Promise<{ targetUserId: string; plaintextPassword: string }> {
    const target = await this.userRepo.findOne({
      where: { id: targetUserId },
    });
    if (!target) throw new NotFoundException('TARGET_USER_NOT_FOUND');
    if (!target.emailHash) {
      throw new ConflictException(
        'TARGET_USER_NO_EMAIL: backup credential requires a registered email',
      );
    }
    const existing = await this.credRepo.findOne({
      where: { userId: targetUserId },
    });
    if (existing && !existing.revokedAt) {
      throw new ConflictException('BACKUP_CREDENTIAL_ALREADY_EXISTS');
    }

    const plaintext = generateInitialPassword();
    const hash = await this.argon2.hash(plaintext);

    await this.dataSource.transaction(async (em) => {
      if (existing) {
        await em.getRepository(BackupCredential).update(existing.id, {
          passwordHash: hash,
          passwordSetAt: new Date(),
          passwordSetByUserId: actorUserId,
          mustChangeOnNextLogin: true,
          failedAttempts: 0,
          lockedUntil: null,
          frozenAt: null,
          frozenReason: null,
          revokedAt: null,
          revokedByUserId: null,
          revokedReason: null,
          usernameEmailHash: target.emailHash!,
        });
      } else {
        await em.getRepository(BackupCredential).insert({
          userId: targetUserId,
          usernameEmailHash: target.emailHash!,
          passwordHash: hash,
          passwordSetAt: new Date(),
          passwordSetByUserId: actorUserId,
          mustChangeOnNextLogin: true,
          failedAttempts: 0,
        });
      }
      // Clear any TOTP enrollment from a prior life so the bootstrap-style
      // grace re-arms on first login under the reset/issue flow.
      await em.getRepository(TotpEnrollment).delete({ userId: targetUserId });
      // SECURITY note (2026-05-27): session_version is INTENTIONALLY NOT
      // bumped on admin issue. Target has no existing backup session to
      // invalidate (issue = first-time credential creation; the `existing`
      // branch only fires for re-issue over an ALREADY-revoked row, and
      // revoke itself already bumped session_version). Bumping here would
      // unnecessarily invalidate the target's THAID session — kicking
      // them out of /project, /profile, etc. without consent.
      //
      // Bump is preserved on resetCredential / revokeCredential /
      // unfreezeCredential / resetTotpByAdmin where there IS an existing
      // backup session that MUST be invalidated for security reasons.
    });

    await this.lineNotifier.notifyEventToUser(
      targetUserId,
      'มีการออกรหัสผ่านสำรองสำหรับบัญชีคุณ กรุณาเปลี่ยนรหัสในการเข้าสู่ระบบครั้งแรก',
    );
    await this.notifyAllSuperAdmins(
      `มีการออกรหัสผ่านสำรองโดยผู้ดูแลระบบ (userId=${actorUserId}) ให้ target=${targetUserId}`,
    );

    return { targetUserId, plaintextPassword: plaintext };
  }

  async resetCredential(
    actorUserId: string,
    targetUserId: string,
    _reason?: string,
  ): Promise<{ targetUserId: string; plaintextPassword: string }> {
    const target = await this.userRepo.findOne({
      where: { id: targetUserId },
    });
    if (!target) throw new NotFoundException('TARGET_USER_NOT_FOUND');
    if (!target.emailHash) {
      throw new ConflictException('TARGET_USER_NO_EMAIL');
    }
    const existing = await this.credRepo.findOne({
      where: { userId: targetUserId },
    });
    if (!existing) {
      // Reset on a non-existent credential — fall back to issue.
      return this.issueCredential(actorUserId, targetUserId);
    }

    const plaintext = generateInitialPassword();
    const hash = await this.argon2.hash(plaintext);

    await this.dataSource.transaction(async (em) => {
      await em.getRepository(BackupCredential).update(existing.id, {
        passwordHash: hash,
        passwordSetAt: new Date(),
        passwordSetByUserId: actorUserId,
        mustChangeOnNextLogin: true,
        failedAttempts: 0,
        lockedUntil: null,
        frozenAt: null,
        frozenReason: null,
        revokedAt: null,
        revokedByUserId: null,
        revokedReason: null,
        usernameEmailHash: target.emailHash!,
      });
      // Clear TOTP so the user can re-enroll on first login post-reset.
      await em.getRepository(TotpEnrollment).delete({ userId: targetUserId });
      await this.sessionVersion.bump(targetUserId, em);
    });

    await this.lineNotifier.notifyEventToUser(
      targetUserId,
      'รหัสผ่านสำรองของบัญชีคุณถูกรีเซ็ตโดยผู้ดูแลระบบ',
    );
    await this.notifyAllSuperAdmins(
      `มีการรีเซ็ตรหัสผ่านสำรองโดย (userId=${actorUserId}) ให้ target=${targetUserId}`,
    );

    return { targetUserId, plaintextPassword: plaintext };
  }

  async revokeCredential(
    actorUserId: string,
    targetUserId: string,
    reason?: string,
  ): Promise<void> {
    const existing = await this.credRepo.findOne({
      where: { userId: targetUserId },
    });
    if (!existing) return;
    if (existing.revokedAt) return; // idempotent

    await this.dataSource.transaction(async (em) => {
      await em.getRepository(BackupCredential).update(existing.id, {
        revokedAt: new Date(),
        revokedByUserId: actorUserId,
        revokedReason: reason ?? 'manual revoke',
      });
      await this.sessionVersion.bump(targetUserId, em);
    });

    await this.lineNotifier.notifyEventToUser(
      targetUserId,
      'รหัสผ่านสำรองของบัญชีคุณถูกยกเลิก',
    );
    await this.notifyAllSuperAdmins(
      `มีการยกเลิกรหัสผ่านสำรองโดย (userId=${actorUserId}) ให้ target=${targetUserId}`,
    );
  }

  async unfreezeCredential(
    actorUserId: string,
    targetUserId: string,
  ): Promise<void> {
    const existing = await this.credRepo.findOne({
      where: { userId: targetUserId },
    });
    if (!existing) throw new NotFoundException('CREDENTIAL_NOT_FOUND');

    await this.dataSource.transaction(async (em) => {
      await em.getRepository(BackupCredential).update(existing.id, {
        frozenAt: null,
        frozenReason: null,
        failedAttempts: 0,
        lockedUntil: null,
      });
      await this.sessionVersion.bump(targetUserId, em);
    });
    await this.lockout.recordSuccess(targetUserId);
    await this.lineNotifier.notifyEventToUser(
      targetUserId,
      'บัญชีของคุณถูกปลดล็อกโดยผู้ดูแลระบบ',
    );
    await this.notifyAllSuperAdmins(
      `ปลดล็อก credential (userId=${actorUserId}) target=${targetUserId}`,
    );
  }

  async resetTotpByAdmin(
    actorUserId: string,
    targetUserId: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      await this.totp.resetByAdmin(targetUserId, em);
      await this.sessionVersion.bump(targetUserId, em);
    });
    await this.lineNotifier.notifyEventToUser(
      targetUserId,
      'TOTP ของบัญชีคุณถูกรีเซ็ตโดยผู้ดูแลระบบ กรุณาลงทะเบียนใหม่',
    );
    await this.notifyAllSuperAdmins(
      `TOTP reset โดย (userId=${actorUserId}) target=${targetUserId}`,
    );
  }

  async setKillSwitch(
    actorUserId: string,
    enabled: boolean,
    reason?: string,
  ): Promise<{ enabled: boolean }> {
    await this.killSwitch.setEnabled(enabled, actorUserId);
    const msg = enabled
      ? `ระบบล็อกอินสำรองถูกเปิดใช้งานเมื่อ ${new Date().toISOString()} โดย userId=${actorUserId}`
      : `ระบบล็อกอินสำรองถูกปิดใช้งานเมื่อ ${new Date().toISOString()} โดย userId=${actorUserId} เหตุผล: ${reason ?? '-'}`;
    await this.notifyAllSuperAdmins(msg);
    return { enabled };
  }

  // ============================================================
  //  Helpers
  // ============================================================

  /**
   * Load the user's current WorkHistory with role + workStatus.
   * Tolerates missing `isCurrent = true` rows by falling back to the
   * most-recent `approved` row (matches the existing pattern in
   * `auth.service.ts`).
   */
  private async loadCurrentWorkHistory(
    userId: string,
  ): Promise<WorkHistory | null> {
    const current = await this.whRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: ['role', 'workStatus'],
    });
    if (current) return current;
    const fallback = await this.whRepo.findOne({
      where: { user: { id: userId } },
      relations: ['role', 'workStatus'],
      order: { createdAt: 'DESC' },
    });
    return fallback ?? null;
  }

  /**
   * Variant of {@link loadCurrentWorkHistory} that eager-loads the
   * relations the FE greeting bar + sidebar / page-header surfaces
   * depend on (amphoe, LAO, government-agency, division). Used when
   * building the `user` payload returned from `/complete` and from
   * `/totp-enroll/complete` so the backup-login response is shape-
   * compatible with the existing ThaiD login response.
   */
  private async loadCurrentWorkHistoryFull(
    userId: string,
  ): Promise<WorkHistory | null> {
    const relations = [
      'role',
      'workStatus',
      'amphoe',
      'localAdministrativeOrganization',
      'governmentAgencies',
    ];
    const current = await this.whRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations,
    });
    if (current) return current;
    const fallback = await this.whRepo.findOne({
      where: { user: { id: userId } },
      relations,
      order: { createdAt: 'DESC' },
    });
    return fallback ?? null;
  }

  /**
   * Build the `user` object returned by `/complete` (and reused on
   * `/totp-enroll/complete`) so backup-login is shape-compatible with
   * the existing ThaiD login payload. The FE consumes this via
   * `loginAsync` to hydrate Redux `auth.user` — without it, the
   * greeting bar on /project renders empty strings.
   *
   * Returns `null` if no work-history row exists for the user (caller
   * must treat this as a hard error since the eligibility check
   * already required an `approved` workStatus).
   */
  private async buildUserPayload(userId: string): Promise<Record<string, unknown> | null> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) return null;
    const wh = await this.loadCurrentWorkHistoryFull(userId);
    if (!wh) return null;
    return {
      id: user.id,
      workHistoryId: wh.id ?? null,
      prefix: user.prefix ?? '',
      firstname: user.firstname ?? '',
      lastname: user.lastname ?? '',
      email: user.email ?? '',
      phone: user.phone ?? '',
      amphoeId: wh.amphoe?.id ?? '',
      amphoeName: wh.amphoe?.name ?? '',
      localAdministrativeOrganizationId:
        wh.localAdministrativeOrganization?.id ?? '',
      localAdministrativeOrganizationName:
        wh.localAdministrativeOrganization?.name ?? '',
      // Division snapshot on WorkHistory is Phase-2 work (per the
      // wave-add-division-entity §10 future-waves note). Until then,
      // emit empty strings so the FE type stays satisfied.
      divisionId: '',
      divisionName: '',
      role: wh.role?.name ?? 'user',
      workStatus: wh.workStatus?.name ?? 'pending',
      emailVerifiedAt: user.emailVerifiedAt ?? null,
    };
  }

  private async applyEscalation(
    credentialId: string,
    userId: string,
    esc: EscalationResult,
  ): Promise<void> {
    if (esc.level === 'none') {
      await this.credRepo.increment(
        { id: credentialId },
        'failedAttempts',
        1,
      );
      return;
    }
    if (esc.level === 'lock30m' || esc.level === 'lock24h') {
      await this.credRepo.update(credentialId, {
        lockedUntil: esc.lockedUntil,
        failedAttempts: esc.consecutiveFailures,
      });
      return;
    }
    // freeze
    await this.dataSource.transaction(async (em) => {
      await em.getRepository(BackupCredential).update(credentialId, {
        frozenAt: new Date(),
        frozenReason: '10 fails in 24h (auto)',
        failedAttempts: esc.consecutiveFailures,
        lockedUntil: null,
      });
      await this.sessionVersion.bump(userId, em);
    });
    await this.lineNotifier.notifyEventToUser(
      userId,
      'บัญชีของคุณถูกระงับใช้งานสำรองชั่วคราว เนื่องจากมีความพยายามเข้าสู่ระบบล้มเหลวเกินกำหนด',
    );
    await this.notifyAllSuperAdmins(
      `บัญชี userId=${userId} ถูก auto-freeze (10 fails / 24h)`,
    );
  }

  private async notifyAllSuperAdmins(text: string): Promise<void> {
    try {
      const superAdmins = await this.whRepo
        .createQueryBuilder('wh')
        .leftJoin('wh.user', 'user')
        .leftJoin('wh.role', 'role')
        .leftJoin('wh.workStatus', 'ws')
        .where('role.name = :role', { role: Role.SUPER_ADMIN })
        .andWhere('LOWER(ws.name) = :ws', { ws: 'approved' })
        .andWhere('wh.isCurrent = TRUE')
        .select(['user.id AS userid'])
        .getRawMany<{ userid: string }>();
      const ids = [...new Set(superAdmins.map((r) => r.userid).filter(Boolean))];
      await this.lineNotifier.notifyEventToSuperAdmins(ids, text);
    } catch (err) {
      this.logger.warn(
        `[BackupLogin] notify-superadmins failed: ${(err as Error).message}`,
      );
    }
  }

  private denyGeneric(): never {
    throw new UnauthorizedException({
      code: BACKUP_LOGIN_DENIED_CODE,
      message: BACKUP_LOGIN_DENIED_MESSAGE,
    });
  }
}

/**
 * SECURITY-01 §7.2 — initial-issuance password generator. base64url
 * of 18 random bytes (24 chars, satisfies upper + lower + digit by
 * construction) with a `!` injected at a deterministic-by-RNG index to
 * guarantee the symbol rule.
 */
function generateInitialPassword(): string {
  const base = randomBytes(18).toString('base64url');
  const idx = randomBytes(1)[0] % base.length;
  return base.slice(0, idx) + '!' + base.slice(idx);
}
