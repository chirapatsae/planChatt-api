import {
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsUUID,
  IsString,
} from 'class-validator';

export class CreateWorkHistoryDto {
  @IsString()
  @IsNotEmpty()
  amphoeId: string;

  @IsString()
  @IsNotEmpty()
  localAdministrativeOrganizationId: string;

  @IsUUID()
  @IsNotEmpty()
  userId: string;

  @IsUUID()
  @IsOptional()
  workStatusId?: string;

  @IsUUID()
  @IsOptional()
  roleId?: string;

  @IsOptional()
  governmentAgenciesId?: string;
}
