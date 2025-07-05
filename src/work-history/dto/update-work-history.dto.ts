import { PartialType } from '@nestjs/mapped-types';
import { CreateWorkHistoryDto } from './create-work-history.dto';
import { IsOptional, IsArray, IsString, IsUUID, IsNotEmpty, IsEnum } from 'class-validator';

export enum UserRole {
  USER = 'user',
  ADMIN = 'admin',
  SUPERADMIN = 'superadmin',
}

export enum WorkHistoryStatus {
  UNVERIFY = 'unverify',
  APPROVED = 'approved',
  SUSPENDED = 'suspended',
  BANNED = 'banned',
}
export class UpdateWorkHistoryDto extends PartialType(CreateWorkHistoryDto) {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  responsibleAmphoeIds?: string[];

 // 2. เปลี่ยนจาก @IsString เป็น @IsEnum และแก้ Type
 @IsOptional()
 @IsEnum(UserRole, { message: 'Invalid role. Must be one of: user, admin, superadmin' })
 role?: UserRole;

 // 3. เปลี่ยนจาก @IsString เป็น @IsEnum และแก้ Type
 @IsOptional()
 @IsEnum(WorkHistoryStatus, { message: 'Invalid status. Must be one of: unverify, approved, suspended, banned' })
 status?: WorkHistoryStatus;
}


// DTO สำหรับการโอนย้าย responsibility
export class TransferResponsibilityDto {
  @IsUUID()
  @IsNotEmpty({ message: 'newWorkHistoryId should not be empty' })
  newWorkHistoryId: string;
}
// Response DTO สำหรับ admin responsibilities
export class WorkHistoryAdminResponsibilitiesResponseDto {
  id: string;
  createAt: Date;
  status?: 'unverify' | 'approved' | 'suspended' | 'banned';
  divisionName?: string;
  divisionId?: string;
  user: {
    id: string;
    citizenId: string;
    prefix: string;
    firstname: string;
    lastname: string;
    role: string;
  };
  amphoe: {
    id: string;
    name: string;
  };
  localAdministrativeOrganization: {
    id: string;
    name: string;
  };
  responsibleAmphoes: {
    id: string;
    name: string;
  }[];
}
