import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Citizen login-OTP RESEND. Re-issues a fresh code on the SAME challenge
 * (the `otpChallengeToken` stays valid). Bounded length so a garbage value
 * 400s before any JWT verify. Always resolves to the uniform
 * `{ ok: true, resendCooldownSec }` — silent no-op on cooldown / cap / bad
 * token (anti-enumeration + anti-mailbomb).
 */
export class CitizenOtpResendDto {
  @IsString()
  @MinLength(16)
  @MaxLength(1024)
  otpChallengeToken: string;
}
