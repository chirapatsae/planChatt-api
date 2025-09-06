import { PartialType } from '@nestjs/mapped-types';
import { CreateWorkHistoryDto } from './create-work-history.dto';
import {
  IsOptional,
  IsArray,
  IsString,
  IsUUID,
  IsNotEmpty,
  IsEnum,
} from 'class-validator';

export enum UserRole {
  USER = 'user',
  STAFF = 'staff',
  ADMIN = 'admin',
  SUPERADMIN = 'super-admin',
  CLEVEL = 'c-level',

}

export enum WorkHistoryStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  SUSPENDED = 'suspended',
  MOVE = 'move',
}
export class UpdateWorkHistoryDto extends PartialType(CreateWorkHistoryDto) {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  responsibleAmphoeIds?: string[];
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
