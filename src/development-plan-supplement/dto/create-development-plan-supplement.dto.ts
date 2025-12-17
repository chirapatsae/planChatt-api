import { IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Min, IsBoolean, IsDateString } from 'class-validator';

export class CreateDevelopmentPlanSupplementDto {
  @IsNotEmpty()
  @IsUUID()
  developmentPlanId: string;

  @IsNotEmpty()
  @IsInt()
  @Min(1)
  supplementNumber: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  isLatest?: boolean;

  @IsOptional()
  @IsBoolean()
  isOpen?: boolean;

  @IsOptional()
  @IsDateString()
  startDate?: string; // ISO 8601 format

  @IsOptional()
  @IsDateString()
  endDate?: string; // ISO 8601 format
}

