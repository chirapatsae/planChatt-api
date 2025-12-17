import { IsInt, IsOptional, IsString, IsUUID, Min, IsBoolean, IsDateString } from 'class-validator';

export class UpdateDevelopmentPlanSupplementDto {
  @IsOptional()
  @IsUUID()
  developmentPlanId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  supplementNumber?: number;

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
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;
}

