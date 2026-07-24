import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * International-standard password complexity: ≥1 lowercase, ≥1 uppercase,
 * ≥1 digit, ≥1 special char. MUST mirror the FE password rules and the
 * `CitizenResetPasswordDto` policy so the server enforces what the UI shows.
 */
const PASSWORD_COMPLEXITY =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/;

/**
 * Verify-email-first registration — STEP 3 (`register/complete`).
 *
 * The email is NOT re-sent by the client — it is carried (encrypted + hashed)
 * on the already-verified challenge row and read from `registrationToken`. The
 * account is created ONLY here (email already proven). `consentAccepted` MUST
 * be true (PDPA) — the FE shows the privacy policy and the citizen actively
 * accepts before the identity is created.
 */
export class CitizenRegisterCompleteDto {
  @IsString()
  @MinLength(16, { message: 'ลิงก์สมัครหมดอายุ กรุณาเริ่มใหม่' })
  @MaxLength(1024, { message: 'ลิงก์สมัครหมดอายุ กรุณาเริ่มใหม่' })
  registrationToken: string;

  @IsString()
  @MinLength(8, { message: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร' })
  @MaxLength(128)
  @Matches(PASSWORD_COMPLEXITY, {
    message:
      'รหัสผ่านต้องมีตัวพิมพ์เล็ก ตัวพิมพ์ใหญ่ ตัวเลข และอักขระพิเศษอย่างละ 1 ตัว',
  })
  password: string;

  /** Optional public display name; masked/normalized server-side. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  displayName?: string;

  @IsBoolean()
  consentAccepted: boolean;
}
