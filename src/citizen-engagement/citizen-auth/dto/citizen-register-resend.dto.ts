import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Verify-email-first registration — STEP 2 helper (`register/otp/resend`).
 *
 * Re-issues a fresh code on the SAME challenge (so the caller's
 * `challengeToken` stays valid). Bounded length so a garbage/oversized value
 * 400s before any JWT verify / DB lookup. ALWAYS responds uniformly (silent
 * no-op on cooldown / cap / bad token) — anti-enumeration + anti-mailbomb.
 */
export class CitizenRegisterResendDto {
  @IsString()
  @MinLength(16)
  @MaxLength(1024)
  challengeToken: string;
}
