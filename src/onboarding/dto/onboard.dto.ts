import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  Matches,
} from 'class-validator';

export class OnboardDto {
  @IsUUID()
  @IsNotEmpty({ message: 'ต้องระบุ ID ของผู้ใช้' })
  userId: string;

  @IsOptional()
  @IsEmail({}, { message: 'อีเมลไม่ถูกต้อง' })
  email?: string;

  @IsOptional()
  @Matches(/^0[0-9]{9}$/, { message: 'เบอร์โทรไม่ถูกต้อง ต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0' })
  phone?: string;

  @IsNotEmpty({ message: 'ต้องระบุอำเภอ' })
  @IsUUID()
  amphoeId: string;

  @IsNotEmpty({ message: 'ต้องระบุองค์กรปกครองส่วนท้องถิ่น' })
  @IsUUID()
  localAdministrativeOrganizationId: string;

  @IsOptional()
  divisionName?: string;

  @IsOptional()
  divisionId?: string;
} 