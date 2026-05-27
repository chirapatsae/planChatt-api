import { IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class BackupLoginCompleteDto {
  @IsString()
  @MaxLength(4096)
  mfaChallengeToken: string;

  /**
   * 6-digit TOTP code. Optional in the bootstrap exemption path only
   * (first super-admin with no TotpEnrollment row + `mustChangeOnNextLogin`
   * = true). The service enforces presence in all other paths.
   */
  @IsOptional()
  @IsString()
  @Length(6, 6)
  totpCode?: string;
}
