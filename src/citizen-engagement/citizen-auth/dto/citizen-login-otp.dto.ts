import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Citizen login-OTP VERIFY (mandatory email-2FA, step 2).
 *
 * `otpChallengeToken` is the short-lived JWT minted by step 1 (login /
 * google / register) — bounded length so a garbage/oversized value 400s
 * before any JWT verify. `code` is the 6-digit numeric OTP; the `@Matches`
 * message is the SAME generic string the service throws so a rejected shape
 * never distinguishes wrong-format from wrong-code (anti-enumeration).
 */
export class CitizenLoginOtpDto {
  @IsString()
  @MinLength(16, { message: 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุ' })
  @MaxLength(1024, { message: 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุ' })
  otpChallengeToken: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุ' })
  code: string;
}
