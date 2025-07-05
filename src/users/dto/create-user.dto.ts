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
}


export class OnboardDto {
  @IsUUID()
  @IsNotEmpty()
  userId: string;

  @IsOptional()
  @IsEmail({}, { message: 'อีเมลไม่ถูกต้อง' })
  email: string;

  @IsOptional()
  @Matches(/^0[0-9]{9}$/, { message: 'เบอร์โทรไม่ถูกต้อง ต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0' })
  phone: string;

  @IsNotEmpty({ message: 'ต้องระบุอำเภอ' })
  amphoeId: string;

  @IsNotEmpty({ message: 'ต้องระบุองค์กรปกครองส่วนท้องถิ่น' })
  localAdministrativeOrganizationId: string;

  @IsOptional()
  divisionName?: string

  @IsOptional()
  divisionId?: string

}