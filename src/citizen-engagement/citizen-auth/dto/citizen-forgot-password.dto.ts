import { Transform } from 'class-transformer';
import { IsEmail } from 'class-validator';

/**
 * Citizen password-reset REQUEST (email/password login).
 *
 * Anti-enumeration (PDPA): the controller ALWAYS returns 200 `{ ok: true }`
 * regardless of whether this email maps to an account / provider — this DTO
 * only enforces a well-formed address so a malformed request 400s early
 * without touching the identity store.
 */
export class CitizenForgotPasswordDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'Invalid email format' })
  email: string;
}
