import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsPhoneNumber,
  IsUUID,
  Matches,
} from 'class-validator';

export class CreateUserDto {
  @IsNotEmpty()
  @Matches(/^[0-9]{13}$/, { message: 'citizenId must be a 13-digit number' })
  citizenId: string;

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
  isFirstLogin? : boolean;
}


