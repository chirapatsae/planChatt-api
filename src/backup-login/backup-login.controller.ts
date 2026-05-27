import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { RolesGuard } from 'src/auth/roles.guard';
import { Roles } from 'src/auth/roles.decorator';
import { WorkStatusApprovedGuard } from 'src/auth/work-status-approved.guard';
import { SUPER_ADMIN_ONLY } from 'src/auth/role-groups';
import { BackupLoginService } from './backup-login.service';
import { BackupLoginInitDto } from './dto/backup-login-init.dto';
import { BackupLoginCompleteDto } from './dto/backup-login-complete.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { TotpEnrollCompleteDto } from './dto/totp-enroll-complete.dto';
import { IssueCredentialDto } from './dto/issue-credential.dto';
import { ResetCredentialDto } from './dto/reset-credential.dto';
import { RevokeCredentialDto } from './dto/revoke-credential.dto';
import { SetKillSwitchDto } from './dto/set-killswitch.dto';
import { ListAttemptsDto } from './dto/list-attempts.dto';
import { SelfEnrollCredentialDto } from './dto/self-enroll-credential.dto';
import { RequirePasswordChangeNotPendingGuard } from './guards/require-password-change-not-pending.guard';
import { BackupAttemptAuditService } from './backup-attempt-audit.service';
import { KillSwitchService } from './kill-switch.service';

/**
 * SECURITY-01 §9.2 — backup-login surface.
 *
 * Mounted under `auth` so the resulting paths match the
 * BE-01 spec table:
 *
 *   POST   /api/v1/auth/backup-login/init
 *   POST   /api/v1/auth/backup-login/complete
 *   POST   /api/v1/auth/backup-credentials/change-password
 *   GET    /api/v1/auth/backup-credentials/me                  (Wave: profile self-enroll)
 *   POST   /api/v1/auth/backup-credentials/self-enroll         (Wave: profile self-enroll)
 *   POST   /api/v1/auth/backup-credentials/issue
 *   POST   /api/v1/auth/backup-credentials/reset/:userId
 *   POST   /api/v1/auth/backup-credentials/revoke/:userId
 *   POST   /api/v1/auth/backup-credentials/unfreeze/:userId
 *   POST   /api/v1/auth/backup-totp/enroll-init
 *   POST   /api/v1/auth/backup-totp/enroll-complete
 *   POST   /api/v1/auth/backup-totp/reset/:userId              (ADMIN-ONLY; no self variant)
 *   PATCH  /api/v1/auth/backup-killswitch
 *   GET    /api/v1/auth/backup-killswitch
 *   GET    /api/v1/auth/backup-login-attempts
 *
 * Canonical guard chain per `backend/src/auth/README.md`:
 *   JwtAuthGuard → RolesGuard → WorkStatusApprovedGuard →
 *   RequirePasswordChangeNotPendingGuard.
 *
 * Wave wave-backup-login-profile-self-enroll / BE-01 — grep-gate
 * marker: this file MUST NOT contain a TOTP-reset route without a
 * `:userId` path parameter or any service method that resets TOTP
 * based on the caller's JWT `sub`. Self-callable TOTP-reset is
 * FORBIDDEN per SECURITY-01 §7.11. The only legitimate path is
 * `POST backup-totp/reset/:userId` gated by `Roles(...SUPER_ADMIN_ONLY)`
 * (see `adminResetTotp` below). QA-01 verifies this with:
 *   grep -RIn "backup-totp/reset" backend/src/backup-login/
 */
@Controller({ path: 'auth', version: '1' })
export class BackupLoginController {
  constructor(
    private readonly backupLogin: BackupLoginService,
    private readonly audit: BackupAttemptAuditService,
    private readonly killSwitch: KillSwitchService,
  ) {}

  // -------------------------------------------------------------
  //  Anonymous (rate-limited)
  // -------------------------------------------------------------

  @Post('backup-login/init')
  @UseGuards(ThrottlerGuard)
  @Throttle({
    'backup-login-ip': { limit: 10, ttl: 60_000 },
    'backup-login-subnet': { limit: 100, ttl: 60_000 },
  })
  async init(@Body() dto: BackupLoginInitDto, @Req() req: Request) {
    const ip = req.ip || '0.0.0.0';
    const userAgent = (req.headers['user-agent'] as string) || null;
    return this.backupLogin.attemptInit({
      username: dto.username,
      password: dto.password,
      ip,
      userAgent,
    });
  }

  @Post('backup-login/complete')
  @UseGuards(ThrottlerGuard)
  @Throttle({
    'backup-login-ip': { limit: 30, ttl: 60_000 },
    'backup-login-subnet': { limit: 100, ttl: 60_000 },
  })
  async complete(@Body() dto: BackupLoginCompleteDto, @Req() req: Request) {
    const ip = req.ip || '0.0.0.0';
    const userAgent = (req.headers['user-agent'] as string) || null;
    return this.backupLogin.attemptComplete({
      mfaChallengeToken: dto.mfaChallengeToken,
      totpCode: dto.totpCode,
      ip,
      userAgent,
    });
  }

  // -------------------------------------------------------------
  //  Profile self-service: status + self-enroll
  //  (Wave wave-backup-login-profile-self-enroll / BE-01)
  // -------------------------------------------------------------

  /**
   * SECURITY-01 §7.1 row 1 + §7.4 — caller's own backup-credential
   * status. JWT-authed; NOT gated by `WorkStatusApprovedGuard` so
   * non-approved users can still read their state on /profile.
   * NOT gated by `RequirePasswordChangeNotPendingGuard` — this
   * endpoint exists to surface that very state.
   *
   * NOT rate-limited (read-only, low-risk; the broader auth surface
   * is covered by other throttlers).
   */
  @Get('backup-credentials/me')
  @UseGuards(JwtAuthGuard)
  async myStatus(@Req() req: Request & { user: { userId: string } }) {
    return this.backupLogin.getMyBackupStatus(req.user.userId);
  }

  /**
   * SECURITY-01 §7.1 row 2 + §7.3 — first-time self-enrollment.
   *
   * Anti-abuse: per-IP + per-subnet rate limits (mirror /init).
   * Per-user lockout ladder does NOT apply here (no credential row
   * yet on the success path; the anti-enum "already exists" branch
   * returns generic 401 without touching `failedAttempts`).
   *
   * `RequirePasswordChangeNotPendingGuard` rejects callers in the
   * forced-flow state — they must finish that first. SECURITY-01
   * §7.3 + §7.7 row "/self-enroll requirePasswordChange".
   */
  @Post('backup-credentials/self-enroll')
  @UseGuards(
    JwtAuthGuard,
    WorkStatusApprovedGuard,
    RequirePasswordChangeNotPendingGuard,
    ThrottlerGuard,
  )
  @Throttle({
    'backup-login-ip': { limit: 10, ttl: 60_000 },
    'backup-login-subnet': { limit: 100, ttl: 60_000 },
  })
  async selfEnroll(
    @Body() dto: SelfEnrollCredentialDto,
    @Req() req: Request & { user: { userId: string } },
  ) {
    await this.backupLogin.selfEnrollPassword(req.user.userId, dto.password);
    // SECURITY-01 §7.1 row 2 — `{ok: true}` (HTTP 200 — NOT 204 so
    // FE can parse). FE then continues to /backup-totp/enroll-init
    // with the caller's existing JWT.
    return { ok: true };
  }

  // -------------------------------------------------------------
  //  Change password (forced OR self)
  // -------------------------------------------------------------

  /**
   * Forced password change OR self-change. The endpoint MUST NOT layer
   * `RequirePasswordChangeNotPendingGuard` — this IS the unblock path
   * (SECURITY-01 §7.11).
   *
   * Wave wave-backup-login-profile-self-enroll / BE-01 — `totpCode`
   * now required at the SERVICE layer unless the caller satisfies
   * the SINGLE forced-flow exception per SECURITY-01 §7.2 (admin-
   * issued one-time password + no confirmed TOTP + loginMethod =
   * 'backup'). The controller surfaces `loginMethod` from the JWT
   * so the service can evaluate condition 2.
   */
  @Post('backup-credentials/change-password')
  @UseGuards(JwtAuthGuard)
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @Req()
    req: Request & {
      user: { userId: string; loginMethod?: 'thaid' | 'backup' };
    },
  ) {
    // Returns a NEW accessToken because the password change bumps
    // `users.session_version`, which invalidates the JWT the caller
    // sent. FE MUST swap its stored token to the returned one before
    // the next request — otherwise JwtAuthGuard's session-version
    // check rejects every subsequent call with 401 SESSION_INVALIDATED
    // and the user is bounced back to the login page.
    //
    // `loginMethod` defaults to `'thaid'` if absent — this is the
    // safer fail-closed default (a missing claim REQUIRES TOTP rather
    // than allowing the forced-flow exception to fire on an unknown
    // session type).
    const { accessToken } = await this.backupLogin.changePassword(
      req.user.userId,
      dto.oldPassword,
      dto.newPassword,
      dto.totpCode,
      req.user.loginMethod ?? 'thaid',
    );
    return { ok: true, accessToken };
  }

  // -------------------------------------------------------------
  //  TOTP enroll (user-self)
  // -------------------------------------------------------------

  @Post('backup-totp/enroll-init')
  @UseGuards(JwtAuthGuard, RequirePasswordChangeNotPendingGuard)
  async totpEnrollInit(
    // No body — caller identified by JWT. `@Body()` with an empty DTO
    // class triggers class-validator's "an unknown value was passed to
    // the validate function" 400 because the empty class has no
    // metadata to validate against.
    @Req() req: Request & { user: { userId: string } },
  ) {
    return this.backupLogin.enrollTotpInit(req.user.userId);
  }

  @Post('backup-totp/enroll-complete')
  @UseGuards(JwtAuthGuard, RequirePasswordChangeNotPendingGuard)
  async totpEnrollComplete(
    @Body() dto: TotpEnrollCompleteDto,
    @Req() req: Request & { user: { userId: string } },
  ) {
    // Returns a fully-authenticated session token + the user payload
    // so the FE can finish login without forcing a re-login through
    // the modal. The session_version was bumped inside the service,
    // so any enrollment-purpose token still in flight is rejected.
    const { accessToken, user } = await this.backupLogin.enrollTotpComplete(
      req.user.userId,
      dto.totpCode,
    );
    return { ok: true, accessToken, user };
  }

  // -------------------------------------------------------------
  //  Super-admin: credential management
  // -------------------------------------------------------------

  @Post('backup-credentials/issue')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    WorkStatusApprovedGuard,
    RequirePasswordChangeNotPendingGuard,
  )
  @Roles(...SUPER_ADMIN_ONLY)
  async adminIssue(
    @Body() dto: IssueCredentialDto,
    @Req() req: Request & { user: { userId: string } },
  ) {
    return this.backupLogin.issueCredential(req.user.userId, dto.targetUserId);
  }

  @Post('backup-credentials/reset/:userId')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    WorkStatusApprovedGuard,
    RequirePasswordChangeNotPendingGuard,
  )
  @Roles(...SUPER_ADMIN_ONLY)
  async adminReset(
    @Param('userId', new ParseUUIDPipe()) targetUserId: string,
    @Body() dto: ResetCredentialDto,
    @Req() req: Request & { user: { userId: string } },
  ) {
    return this.backupLogin.resetCredential(
      req.user.userId,
      targetUserId,
      dto.reason,
    );
  }

  @Post('backup-credentials/revoke/:userId')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    WorkStatusApprovedGuard,
    RequirePasswordChangeNotPendingGuard,
  )
  @Roles(...SUPER_ADMIN_ONLY)
  async adminRevoke(
    @Param('userId', new ParseUUIDPipe()) targetUserId: string,
    @Body() dto: RevokeCredentialDto,
    @Req() req: Request & { user: { userId: string } },
  ) {
    await this.backupLogin.revokeCredential(
      req.user.userId,
      targetUserId,
      dto.reason,
    );
    return { ok: true };
  }

  @Post('backup-credentials/unfreeze/:userId')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    WorkStatusApprovedGuard,
    RequirePasswordChangeNotPendingGuard,
  )
  @Roles(...SUPER_ADMIN_ONLY)
  async adminUnfreeze(
    @Param('userId', new ParseUUIDPipe()) targetUserId: string,
    @Req() req: Request & { user: { userId: string } },
  ) {
    await this.backupLogin.unfreezeCredential(req.user.userId, targetUserId);
    return { ok: true };
  }

  @Post('backup-totp/reset/:userId')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    WorkStatusApprovedGuard,
    RequirePasswordChangeNotPendingGuard,
  )
  @Roles(...SUPER_ADMIN_ONLY)
  async adminResetTotp(
    @Param('userId', new ParseUUIDPipe()) targetUserId: string,
    @Req() req: Request & { user: { userId: string } },
  ) {
    await this.backupLogin.resetTotpByAdmin(req.user.userId, targetUserId);
    return { ok: true };
  }

  // -------------------------------------------------------------
  //  Super-admin: kill-switch
  // -------------------------------------------------------------

  @Patch('backup-killswitch')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    WorkStatusApprovedGuard,
    RequirePasswordChangeNotPendingGuard,
  )
  @Roles(...SUPER_ADMIN_ONLY)
  async adminKillSwitch(
    @Body() dto: SetKillSwitchDto,
    @Req() req: Request & { user: { userId: string } },
  ) {
    return this.backupLogin.setKillSwitch(
      req.user.userId,
      dto.enabled,
      dto.reason,
    );
  }

  @Get('backup-killswitch')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    WorkStatusApprovedGuard,
    RequirePasswordChangeNotPendingGuard,
  )
  @Roles(...SUPER_ADMIN_ONLY)
  async adminReadKillSwitch() {
    const enabled = await this.killSwitch.isEnabled();
    return { enabled };
  }

  // -------------------------------------------------------------
  //  Super-admin: audit listing
  // -------------------------------------------------------------

  @Get('backup-login-attempts')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    WorkStatusApprovedGuard,
    RequirePasswordChangeNotPendingGuard,
  )
  @Roles(...SUPER_ADMIN_ONLY)
  async adminAuditLogs(@Query() query: ListAttemptsDto) {
    return this.audit.list({
      userId: query.userId,
      outcome: query.outcome,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      page: query.page,
      limit: query.limit,
    });
  }
}
