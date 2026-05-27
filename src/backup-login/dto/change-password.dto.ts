import { IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator';

/**
 * SECURITY-01 §7.2 password policy:
 *   - 12-128 chars
 *   - service-side checks complexity / dictionary / username similarity /
 *     history-no-reuse
 *
 * The 12-char floor is enforced here at the DTO so the request is
 * rejected before any DB hit. The remaining policy lives in
 * `PasswordPolicyService.validate`.
 *
 * Wave wave-backup-login-profile-self-enroll / BE-01 — added optional
 * `totpCode`. Per SECURITY-01 §7.1 row 3 + §7.2, `totpCode` is
 * REQUIRED at the service layer unless the caller satisfies the
 * forced-flow exception (admin-issued one-time password + no
 * confirmed TOTP yet + loginMethod = 'backup'). The DTO accepts the
 * field as OPTIONAL so the forced-flow page (which has no TOTP to
 * supply) can POST without it; the service enforces the requirement
 * + anti-enumeration semantics.
 */
export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  oldPassword: string;

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  newPassword: string;

  /**
   * SECURITY-01 §7.2 — when present MUST be exactly 6 digits.
   * Service enforces the require/skip decision.
   */
  @IsOptional()
  @IsString()
  @Length(6, 6, { message: 'totpCode must be 6 digits' })
  totpCode?: string;
}
