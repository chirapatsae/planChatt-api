import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Wave wave-backup-login-profile-self-enroll / BE-01.
 *
 * SECURITY-01 §7.1 row 2 + §7.3 — body for
 * `POST /v1/auth/backup-credentials/self-enroll`.
 *
 * The 12-char floor is enforced here so the DTO rejects malformed
 * requests before any DB hit. The remaining policy (complexity,
 * dictionary, username-similarity, history-no-reuse) is enforced
 * service-side via `PasswordPolicyService.validate` per
 * prior wave SECURITY-01 §7.2.
 */
export class SelfEnrollCredentialDto {
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password: string;
}
