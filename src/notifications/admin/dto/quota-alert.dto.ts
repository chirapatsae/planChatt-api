import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

/**
 * Wave 97 — DTOs for the quota-alert CRUD endpoints.
 *
 * §17.11 — no role can override; super-admin is enforced in the
 * controller. The DTO captures the integrity invariants (channel ∈
 * {email,line}, threshold 1..200, valid email shape).
 *
 * W83 — `recipientEmail` is operator metadata (super-admin's mailbox).
 * It is stored in plaintext (alerts must reach a real address) but
 * MUST be masked via `maskEmail` in any log line.
 */

/**
 * W98 follow-up — `recipientEmail` is now OPTIONAL.
 *
 * The product direction shifted from "operator-supplied destination"
 * to "auto-fan-out to all admin + super-admin mailboxes". When the
 * field is absent (the new default from the FE create form), the
 * worker queries `users` for every active admin / super-admin and
 * sends to that list. Existing rows that still carry an explicit
 * `recipientEmail` keep working — the worker prefers the explicit
 * value when present.
 */
export class CreateQuotaAlertDto {
  @IsIn(['email', 'line'], {
    message: "channel ต้องเป็น 'email' หรือ 'line'",
  })
  channel: 'email' | 'line';

  @IsInt({ message: 'thresholdPercent ต้องเป็นจำนวนเต็ม' })
  @Min(1, { message: 'thresholdPercent ต้องอยู่ในช่วง 1..200' })
  @Max(200, { message: 'thresholdPercent ต้องอยู่ในช่วง 1..200' })
  thresholdPercent: number;

  @IsOptional()
  @IsEmail({}, { message: 'recipientEmail ต้องเป็นอีเมลที่ถูกต้อง' })
  recipientEmail?: string;

  @IsOptional()
  @IsBoolean({ message: 'enabled ต้องเป็น boolean' })
  enabled?: boolean;
}

export class UpdateQuotaAlertDto {
  @IsOptional()
  @IsIn(['email', 'line'], {
    message: "channel ต้องเป็น 'email' หรือ 'line'",
  })
  channel?: 'email' | 'line';

  @IsOptional()
  @IsInt({ message: 'thresholdPercent ต้องเป็นจำนวนเต็ม' })
  @Min(1, { message: 'thresholdPercent ต้องอยู่ในช่วง 1..200' })
  @Max(200, { message: 'thresholdPercent ต้องอยู่ในช่วง 1..200' })
  thresholdPercent?: number;

  @IsOptional()
  @IsEmail({}, { message: 'recipientEmail ต้องเป็นอีเมลที่ถูกต้อง' })
  recipientEmail?: string;

  @IsOptional()
  @IsBoolean({ message: 'enabled ต้องเป็น boolean' })
  enabled?: boolean;
}
