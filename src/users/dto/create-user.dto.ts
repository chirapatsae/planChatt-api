import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsPhoneNumber,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';

export class CreateUserDto {
  @IsNotEmpty()
  @Matches(/^[0-9]{13}$/, { message: 'citizenId must be a 13-digit number' })
  citizenId: string;

  @IsNotEmpty()
  @Matches(/^[a-f0-9]{64}$/, { message: 'citizenIdHash must be a 64-character hexadecimal string' })
  citizenIdHash: string;

  // NOTE (W89): Any future email/phone-shaped field added to this DTO MUST also
  // be decorated with the matching @Transform so DTO-layer normalization stays
  // in lockstep with `hashEmail` / `hashPhone` in `backend/src/util/encryption.util.ts`.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'Invalid email format' })
  @IsOptional()
  email?: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.replace(/\D/g, '') : value))
  @IsPhoneNumber('TH', { message: 'Invalid Thai phone number' })
  @IsOptional()
  phone?: string;

  @IsNotEmpty()
  prefix: string;

  @IsNotEmpty()
  firstname: string;

  @IsNotEmpty()
  lastname: string;

  @IsOptional()
  isFirstLogin?: boolean;

  @IsOptional()
  @IsBoolean()
  allowEmailNotification?: boolean;

  @IsOptional()
  @IsBoolean()
  allowLineNotification?: boolean;

  @IsOptional()
  @IsString()
  lineId?: string;
}
