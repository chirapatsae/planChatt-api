import { IsDate, IsInt, IsNotEmpty, IsString, Max, Min, IsOptional, IsDateString, IsBoolean } from 'class-validator';

export class CreateDevelopmentPlanDto {
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
  @IsBoolean()
  isBooked?: boolean;
}

