import { IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Min, IsBoolean, IsDateString } from 'class-validator';

export class CreateDevelopmentPlanRevisionDto {
  @IsNotEmpty()
  @IsUUID()
  budgetPlanId: string;

  @IsNotEmpty()
  @IsUUID()
  revisionTypeId: string;

  @IsNotEmpty()
  @IsInt()
  @Min(1)
  revisionNumber: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  isLatest?: boolean;

  @IsOptional()
  @IsDateString()
  startDate?: string; // ISO 8601 format

  @IsOptional()
  @IsDateString()
  endDate?: string; // ISO 8601 format
}
