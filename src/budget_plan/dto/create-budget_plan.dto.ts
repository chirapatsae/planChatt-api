import { IsDate, IsInt, IsNotEmpty, IsString, Max, Min, IsOptional, IsDateString } from 'class-validator';

export class CreateBudgetPlanDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsNotEmpty()
  @IsInt()
  @Min(2500)
  @Max(2600)
  startYear: number;

  @IsNotEmpty()
  @IsInt()
  @Min(2500)
  @Max(2600)
  endYear: number;

  @IsOptional()
  @IsDateString()
  startDate?: string; // ISO 8601 format

  @IsOptional()
  @IsDateString()
  endDate?: string; // ISO 8601 format
}
