import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Wave 21 — Unified preferences DTO for `PATCH /v1/users/me/preferences`.
 *
 * Source of truth: docs/architecture/EMAIL_NOTIFICATION.md §4.3.
 *
 * Semantics:
 *   - All fields are optional. Missing fields are untouched.
 *   - Only these THREE fields are persisted — the endpoint MUST NOT accept any
 *     other User column (enforced in the controller via `whitelist: true` +
 *     `forbidNonWhitelisted: true` at the `ValidationPipe`, and explicitly in
 *     the service by pick-listing).
 *   - `lineId` is bounded to 64 chars to match the existing column hint.
 *
 * The endpoint is self-scoped — the controller extracts `userId` from the
 * authenticated JWT (`req.user.userId`) and NEVER from the DTO. Any `id`
 * field on the body is rejected as an unknown property.
 */
export class UpdateMyPreferencesDto {
  @IsOptional()
  @IsBoolean()
  allowEmailNotification?: boolean;

  @IsOptional()
  @IsBoolean()
  allowLineNotification?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  lineId?: string;
}
