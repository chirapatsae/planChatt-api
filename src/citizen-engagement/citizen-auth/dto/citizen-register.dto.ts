import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * AUTH-REDESIGN (2026-07-08) — citizen self-registration (email/password).
 * Replaces the ThaID-only citizen login. See docs/AUTH-REDESIGN.md §4.4.
 *
 * PDPA: `consentAccepted` MUST be true — the FE shows the privacy policy
 * and the citizen actively accepts before the account is created.
 */
export class CitizenRegisterDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'Invalid email format' })
  email: string;

  @IsString()
  @MinLength(8, { message: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร' })
  @MaxLength(128)
  password: string;

  /** Optional public display name; masked/normalized server-side. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  displayName?: string;

  @IsBoolean()
  @IsNotEmpty()
  consentAccepted: boolean;
}
