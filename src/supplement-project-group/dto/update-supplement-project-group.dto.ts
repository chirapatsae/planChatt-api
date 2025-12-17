import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsInt,
  IsUUID,
  IsArray,
  ValidateNested,
  IsBoolean,
} from 'class-validator';
import { CreateBudgetDto } from 'src/budget/dto/create-budget.dto';

export class UpdateSupplementProjectGroupDto {
  @IsOptional()
  @IsUUID()
  developmentPlanSupplementId?: string;

  @IsOptional()
  title?: string;

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

  @IsOptional()
  @IsInt()
  projectYear?: number;

  @IsOptional()
  strategyId?: string;

  @IsOptional()
  tacticId?: string;

  @IsOptional()
  planId?: string;

  @IsOptional()
  @IsUUID()
  originAgencyId?: string | null;

  @IsOptional()
  responsibleAgency?: string;

  @IsOptional()
  additionalDetail?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateBudgetDto)
  budget?: CreateBudgetDto[];

  @IsOptional()
  @IsBoolean()
  isDraft?: boolean;
}


