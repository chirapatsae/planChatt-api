import {
  IsNotEmpty,
  IsOptional,
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

  @IsOptional()
  workStatusId?: string;

  @IsOptional()
  roleId?: string;

  @IsOptional()
  governmentAgenciesId?: string;
}
