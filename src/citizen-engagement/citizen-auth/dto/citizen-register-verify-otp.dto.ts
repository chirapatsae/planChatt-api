import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Verify-email-first registration — STEP 2 (`register/verify-otp`).
 *
 * `challengeToken` is the short-lived signed handle from step 1 — bounded
 * length so a garbage/oversized value 400s before any JWT verify / DB lookup.
 * `code` is the 6-digit numeric OTP emailed to the prospective citizen; the
 * strict `\d{6}` shape rejects malformed input before the timing-safe compare.
 */
export class CitizenRegisterVerifyOtpDto {
  @IsString()
  @MinLength(16, { message: 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุ' })
  @MaxLength(1024, { message: 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุ' })
  challengeToken: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุ' })
  code: string;
}
