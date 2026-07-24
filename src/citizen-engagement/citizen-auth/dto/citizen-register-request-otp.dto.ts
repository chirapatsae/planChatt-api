import { Transform } from 'class-transformer';
import { IsEmail } from 'class-validator';

/**
 * Verify-email-first registration — STEP 1 (`register/request-otp`).
 *
 * Only the email is collected here; NO identity is created. The response is
 * uniform (a `challengeToken`) whether or not the email is already registered
 * (anti-enumeration). The email is normalized (trim + lowercase) so the
 * server-side `email_hash` lookup is deterministic.
 */
export class CitizenRegisterRequestOtpDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'Invalid email format' })
  email: string;
}
