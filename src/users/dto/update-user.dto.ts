import { PartialType } from '@nestjs/mapped-types';
import { CreateUserDto } from './create-user.dto';

export class UpdateUserDto extends PartialType(CreateUserDto) {
  // 👇 เพิ่มความชัดเจนว่าค่าพวกนี้อาจ undefined และไม่ควรไป overwrite โดยไม่ตั้งใจ
  email?: string;
  phone?: string;
  citizenId?: string;
  prefix?: string;
  firstname?: string;
  lastname?: string;
}
