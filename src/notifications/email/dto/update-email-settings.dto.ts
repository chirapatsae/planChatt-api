import {
  IsBoolean,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  ValidateIf,
} from 'class-validator';

/**
 * Wave 22 B2 / Wave 97 — PATCH /admin/email-settings body shape.
 *
 * Wave 97 extension (W97-API-KILL-SWITCH-EXTEND):
 *   - Adds `lineEnabled?` so a single PATCH may flip email and/or LINE
 *     atomically (per-flag audit rows still written).
 *   - `emailEnabled` is now OPTIONAL — body MUST carry at least one of
 *     `emailEnabled` / `lineEnabled` (cross-field check enforced in the
 *     service layer; class-validator does not have a built-in
 *     "at-least-one" constraint that plays well with `forbidNonWhitelisted`).
 *   - `reason` is REQUIRED when at least one flag transitions
 *     `true → false` (disable). The disable check is performed in the
 *     service against the locked current row, NOT against the DTO alone,
 *     because the DTO has no view of the current state. The DTO only
 *     enforces the 12..200 char shape WHEN reason is present.
 *   - `expectedUpdatedAt` is the optimistic-concurrency token returned by
 *     the prior GET. Mismatch → 409 SETTINGS_STALE.
 *
 * Advisory-only / integrity-neutral (§17.11): the kill-switch never gates a
 * workflow transition, it only short-circuits the dispatch path.
 *
 * NOTE: the class name is preserved (`UpdateEmailSettingsDto`) for
 * backward compat with existing imports. The controller path
 * (`PATCH /admin/email-settings`) is also preserved.
 */
export class UpdateEmailSettingsDto {
  @IsOptional()
  @IsBoolean({ message: 'emailEnabled ต้องเป็น boolean' })
  emailEnabled?: boolean;

  @IsOptional()
  @IsBoolean({ message: 'lineEnabled ต้องเป็น boolean' })
  lineEnabled?: boolean;

  /**
   * Required when ANY flag transitions true → false. The transition is
   * resolved in the service against the row-locked current state, so the
   * DTO only validates the shape (12..200 chars) WHEN the field is
   * present. The service raises 400 with the appropriate message when
   * reason is missing on a disable transition.
   */
  @IsOptional()
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsString({ message: 'reason ต้องเป็น string' })
  @Length(12, 200, {
    message: 'reason ต้องมีความยาว 12-200 ตัวอักษร',
  })
  reason?: string;

  /**
   * ISO timestamp from the prior GET response. The service compares this
   * against the row's `updated_at` inside the same FOR UPDATE transaction
   * and throws 409 SETTINGS_STALE on mismatch.
   */
  @IsOptional()
  @IsISO8601({}, { message: 'expectedUpdatedAt ต้องเป็น ISO 8601 timestamp' })
  expectedUpdatedAt?: string;
}
