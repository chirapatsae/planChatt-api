import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './jwt.strategy';
import { JwtModule } from '@nestjs/jwt';
import { UsersModule } from 'src/users/users.module';
import { User } from 'src/users/entities/user.entity';
import { NotificationsEmailModule } from 'src/notifications/email/notifications-email.module';
import { AuthEmailService } from './email-verification/auth-email.service';
import { EmailVerificationController } from './email-verification/email-verification.controller';

// AUTH-REDESIGN (2026-07-08) — ThaID removed. `AuthService.handleOAuthLogin`
// + `AuthController` (`POST /auth/oauth-login`) + `SecretKeyGuard` +
// `CreateAuthDto` were deleted. Primary staff login now lives in
// BackupLoginModule (`/auth/login` + `/auth/login/mfa`, email + password +
// TOTP). This module now only wires the shared `JwtStrategy` (passport
// 'jwt') + the email-verification surface. See docs/AUTH-REDESIGN.md §4.1.

// W89B — `TypeOrmModule.forFeature([WorkHistory, User])` was removed: the
// AuthService no longer injects either repository (W89-BE-AUTH-INTEGRATION
// routed all User reads/writes through UsersService, and WorkHistory was
// already unused). UsersModule is the only remaining dependency.
//
// W95-VERIFY-FLOW — re-introduce a narrow `TypeOrmModule.forFeature([User])`
// strictly for `AuthEmailService` to read `email_hash` (the W89 deterministic
// hash) without going through `UsersService.findOne` (which decrypts the
// whole PII bag and fetches relations we do not need for HMAC binding).
// `NotificationsEmailModule` is imported so we can inject
// `NotificationsEmailService` to enqueue the verification email through the
// SAME Bull queue + EmailService chokepoint as every other outbound (W90
// sandbox guard remains active).
@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || '',
      signOptions: { expiresIn: '1d' },
    }),
    UsersModule,
    TypeOrmModule.forFeature([User]),
    NotificationsEmailModule,
  ],
  controllers: [EmailVerificationController],
  providers: [JwtStrategy, AuthEmailService],
})
export class AuthModule {}
