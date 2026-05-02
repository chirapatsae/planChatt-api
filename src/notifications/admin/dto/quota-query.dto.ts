import { IsIn, IsISO8601, IsOptional } from 'class-validator';

/**
 * Wave 97 — Query DTO for `GET /admin/notifications/quota`.
 *
 * `forbidNonWhitelisted: true` is globally enabled, so any undeclared
 * query param triggers a 400. The 90-day range guard runs in the
 * controller (after both `from`/`to` are resolved against defaults).
 */
export class QuotaQueryDto {
  @IsOptional()
  @IsISO8601({}, { message: 'from ต้องเป็นรูปแบบ ISO 8601' })
  from?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'to ต้องเป็นรูปแบบ ISO 8601' })
  to?: string;

  @IsOptional()
  @IsIn(['email', 'line', 'both'], {
    message: "channel ต้องเป็น 'email', 'line' หรือ 'both'",
  })
  channel?: 'email' | 'line' | 'both';
}
