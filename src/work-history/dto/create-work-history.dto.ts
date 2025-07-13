import { IsNotEmpty, IsOptional, IsBoolean, IsUUID, IsString } from 'class-validator';

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
  @IsNotEmpty()

  workStatusId: string;

  @IsUUID()
  @IsNotEmpty()

  roleId: string;

  @IsOptional()
  @IsUUID()
  governmentAgenciesId? : string;

}
