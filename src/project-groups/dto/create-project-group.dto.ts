import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsInt,
  IsUUID,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { CreateBudgetDto } from 'src/budget/dto/create-budget.dto';
import { Budget } from 'src/budget/entities/budget.entity';

export class CreateProjectGroupDto {
  @IsNotEmpty()
  title: string;

  @IsNotEmpty()
  objective: string;

  @IsNotEmpty()
  goal: string;

  @IsNotEmpty()
  @IsNumber()
  startLat: number;

  @IsNotEmpty()
  @IsNumber()
  startLng: number;

  @IsOptional()
  @IsNumber()
  endLat?: number;

  @IsOptional()
  @IsNumber()
  endLng?: number;

  @IsNotEmpty()
  indicator: string;

  @IsNotEmpty()
  expected: string;

  @IsNotEmpty()
  @IsInt()
  projectYear: number;

  @IsNotEmpty()
  strategyId : string;

  @IsNotEmpty()
  tacticId : string;

  @IsNotEmpty()
  planId : string;

  @IsNotEmpty()
  @IsUUID()
  budgetPlanId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateBudgetDto)
  budget: CreateBudgetDto[];



}


