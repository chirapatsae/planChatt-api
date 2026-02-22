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

  @IsEmail({}, { message: 'Invalid email format' })
  @IsOptional()
  email?: string;

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
