import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsInt,
  IsUUID,
  IsArray,
  ValidateNested,
  IsBoolean,
} from 'class-validator';
import { CreateBudgetDto } from 'src/budget/dto/create-budget.dto';

export class CreateProjectGroupDto {
  @IsNotEmpty()
  title: string;

  @IsOptional()
  objective?: string;

  @IsOptional()
  goal?: string;

  @IsOptional()
  @IsNumber()
  startLat?: number;

  @IsOptional()
  @IsNumber()
  startLng?: number;

  @IsOptional()
  @IsNumber()
  endLat?: number;

  @IsOptional()
  @IsNumber()
  endLng?: number;

  @IsOptional()
  indicator?: string;

  @IsOptional()
  expected?: string;

  @IsNotEmpty()
  @IsInt()
  projectYear: number;

  @IsOptional()
  strategyId?: string;

  @IsOptional()
  tacticId?: string;

  @IsOptional()
  planId?: string;

  @IsNotEmpty()
  @IsUUID()
  developmentPlanId: string;

  @IsOptional()
  @IsBoolean()
  isBooked?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateBudgetDto)
  budget?: CreateBudgetDto[];


}

export class CreateDraftProjectGroupDto {
  @IsNotEmpty()
  title: string;

  @IsOptional()
  objective?: string;

  @IsOptional()
  goal?: string;

  @IsOptional()
  @IsNumber()
  startLat?: number;

  @IsOptional()
  @IsNumber()
  startLng?: number;

  @IsOptional()
  @IsNumber()
  endLat?: number;

  @IsOptional()
  @IsNumber()
  endLng?: number;

  @IsOptional()
  indicator?: string;

  @IsOptional()
  expected?: string;

  @IsNotEmpty()
  @IsInt()
  projectYear: number;

  @IsOptional()
  strategyId?: string;

  @IsOptional()
  tacticId?: string;

  @IsOptional()
  planId?: string;


  @IsOptional()
  @IsBoolean()
  isDraft?: boolean;

  @IsOptional()
  @IsBoolean()
  isBooked?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateBudgetDto)
  budget?: CreateBudgetDto[];

}
