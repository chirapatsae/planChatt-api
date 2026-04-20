import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Wave 22 B2 — PATCH /admin/email-settings body shape.
 *
 * Advisory-only / integrity-neutral (§17.11): the kill-switch never gates a
 * workflow transition, it only short-circuits the email-dispatch path. Only
 * `super-admin` may call this endpoint (enforced in the controller).
 *
 * - `emailEnabled` is REQUIRED. Client MUST send the desired end state
 *   explicitly — the server does NOT "toggle" based on the current row.
 * - `reason` is OPTIONAL free text pinned onto the audit row in
 *   `notification_settings_audit`. Capped at 500 chars to match the column
 *   width and to keep the audit trail readable.
 */
export class UpdateEmailSettingsDto {
  @IsBoolean({ message: 'emailEnabled ต้องเป็น boolean' })
  emailEnabled: boolean;

  @IsOptional()
  @IsString({ message: 'reason ต้องเป็น string' })
  @MaxLength(500, { message: 'reason ต้องไม่เกิน 500 ตัวอักษร' })
  reason?: string;
}
