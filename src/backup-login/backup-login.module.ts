import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { RolesGuard } from 'src/auth/roles.guard';
import { WorkStatusApprovedGuard } from 'src/auth/work-status-approved.guard';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { User } from 'src/users/entities/user.entity';
import { LineUserBinding } from 'src/line/entities/line-user-binding.entity';
import { LineModule } from 'src/line/line.module';
import { BackupCredential } from './entities/backup-credential.entity';
import { TotpEnrollment } from './entities/totp-enrollment.entity';
import { PasswordHistory } from './entities/password-history.entity';
import { BackupLoginAuditLog } from './entities/backup-login-audit-log.entity';
import { BackupLoginKillSwitchConfig } from './entities/backup-login-kill-switch-config.entity';
import { BackupLoginService } from './backup-login.service';
import { BackupLoginController } from './backup-login.controller';
import { Argon2Service } from './argon2.service';
import { TotpService } from './totp.service';
import { PasswordPolicyService } from './password-policy.service';
import { LockoutService } from './lockout.service';
import { SessionVersionService } from './session-version.service';
import { KillSwitchService } from './kill-switch.service';
import { BackupAttemptAuditService } from './backup-attempt-audit.service';
import { BackupLineNotifier } from './backup-line-notifier.service';
import { BackupRetentionSweepCron } from './crons/backup-retention-sweep.cron';
import { BackupDailySummaryCron } from './crons/backup-daily-summary.cron';
import { BackupLoginBootstrapService } from './backup-login-bootstrap.service';
import { RequirePasswordChangeNotPendingGuard } from './guards/require-password-change-not-pending.guard';

/**
 * Backup-login subsystem — wave-backup-login-thaid-fallback.
 *
 * Wires:
 *   - All 5 backup-login entities + User + WorkHistory + LineUserBinding
 *   - JwtModule (signs `mfaChallengeToken` + final 8h session JWT)
 *   - Module-scoped `ThrottlerModule` with two named trackers
 *     (`backup-login-ip` 30/min, `backup-login-subnet` 100/min)
 *     consumed by the `@Throttle()` decorators on
 *     `/init` and `/complete`. Stricter per-IP cap on /init lives
 *     inside the decorator override (10/min).
 *   - 2 cron services (daily 03:00 retention sweep + daily 09:00
 *     super-admin LINE summary)
 *   - Boot hook for kill-switch seed + append-only trigger self-test
 *
 * §17.11 — no role exemption; all canonical-pattern guards (`JwtAuthGuard
 * + RolesGuard + WorkStatusApprovedGuard`) from `backend/src/auth/` are
 * reused as-is.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      BackupCredential,
      TotpEnrollment,
      PasswordHistory,
      BackupLoginAuditLog,
      BackupLoginKillSwitchConfig,
      User,
      WorkHistory,
      LineUserBinding,
    ]),
    JwtModule.register({
      secret: process.env.JWT_SECRET || '',
    }),
    ThrottlerModule.forRoot([
      { name: 'backup-login-ip', ttl: 60_000, limit: 30 },
      { name: 'backup-login-subnet', ttl: 60_000, limit: 100 },
    ]),
    LineModule,
  ],
  controllers: [BackupLoginController],
  providers: [
    BackupLoginService,
    Argon2Service,
    TotpService,
    PasswordPolicyService,
    LockoutService,
    SessionVersionService,
    KillSwitchService,
    BackupAttemptAuditService,
    BackupLineNotifier,
    BackupRetentionSweepCron,
    BackupDailySummaryCron,
    BackupLoginBootstrapService,
    RolesGuard,
    WorkStatusApprovedGuard,
    RequirePasswordChangeNotPendingGuard,
  ],
  exports: [SessionVersionService],
})
export class BackupLoginModule {}
