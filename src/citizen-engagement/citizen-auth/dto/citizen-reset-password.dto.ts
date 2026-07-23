import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * International-standard password complexity: ≥1 lowercase, ≥1 uppercase,
 * ≥1 digit, ≥1 special char. MUST mirror the FE `PASSWORD_RULES` in
 * `CitizenResetPasswordPage.tsx` so the server enforces what the UI shows.
 */
const PASSWORD_COMPLEXITY =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/;

/**
 * Citizen password-reset CONSUME (email/password login).
 *
 * `token` is the raw base64url secret from the emailed link — bounded length
 * so a garbage/oversized value 400s before the HMAC lookup. The plaintext is
 * never persisted; the server stores only `hashSecret(token)`.
 *
 * `newPassword` reuses the register password policy (8–128 chars).
 */
export class CitizenResetPasswordDto {
  @IsString()
  @MinLength(16, { message: 'ลิงก์รีเซ็ตไม่ถูกต้องหรือหมดอายุ' })
  @MaxLength(256, { message: 'ลิงก์รีเซ็ตไม่ถูกต้องหรือหมดอายุ' })
  token: string;

  @IsString()
  @MinLength(8, { message: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร' })
  @MaxLength(128)
  @Matches(PASSWORD_COMPLEXITY, {
    message:
      'รหัสผ่านต้องมีตัวพิมพ์เล็ก ตัวพิมพ์ใหญ่ ตัวเลข และอักขระพิเศษอย่างละ 1 ตัว',
  })
  newPassword: string;
}
