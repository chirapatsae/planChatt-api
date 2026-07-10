import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsPhoneNumber,
  IsString,
} from 'class-validator';

/**
 * AUTH-REDESIGN (2026-07-08) — admin "add member" payload.
 *
 * Replaces ThaID auto-provisioning: a staff-lead / admin creates the
 * member account (name + email + org placement + role), the service then
 * issues an initial one-time password. The member logs in with email +
 * that password, is forced to change it, and MUST enrol TOTP on first
 * login. See docs/AUTH-REDESIGN.md §4.3.
 */
export class CreateMemberDto {
  @IsNotEmpty()
  @IsString()
  prefix: string;

  @IsNotEmpty()
  @IsString()
  firstname: string;

  @IsNotEmpty()
  @IsString()
  lastname: string;

  // Normalized in lockstep with hashEmail (trim + lowercase).
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'Invalid email format' })
  email: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.replace(/\D/g, '') : value,
  )
  @IsPhoneNumber('TH', { message: 'Invalid Thai phone number' })
  @IsOptional()
  phone?: string;

  // Organizational placement — required to build the member's work_history
  // (WorkHistoryService.create throws NotFound if amphoe / LAO missing).
  // amphoe / LAO primary keys are STRING CODES (e.g. '3001'), NOT UUIDs —
  // mirror CreateWorkHistoryDto (@IsString), not @IsUUID.
  @IsString()
  @IsNotEmpty()
  amphoeId: string;

  @IsString()
  @IsNotEmpty()
  localAdministrativeOrganizationId: string;

  @IsOptional()
  @IsString()
  roleId?: string;

  @IsOptional()
  @IsString()
  governmentAgenciesId?: string;

  // PDPA — version of the privacy policy the member was informed of at
  // creation. Optional; consent may instead be captured at first login.
  @IsOptional()
  @IsString()
  consentVersion?: string;
}
