import {
  IsString,
  IsNotEmpty,
  IsOptional,
  ValidateNested,
  IsArray,
  IsNumber,
} from 'class-validator';
import { Type } from 'class-transformer';

export class SmartApproveBudgetDto {
  @IsNumber()
  year: number;

  @IsNumber()
  quantity: number;
}

export class SmartApproveProjectDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsNotEmpty()
  objective: string;

  @IsString()
  @IsNotEmpty()
  goal: string;

  @IsString()
  @IsOptional()
  expected?: string;

  @IsString()
  @IsOptional()
  indicator?: string;

  @IsNumber()
  @IsOptional()
  startLat?: number;

  @IsNumber()
  @IsOptional()
  startLng?: number;

  @IsNumber()
  @IsOptional()
  endLat?: number | null;

  @IsNumber()
  @IsOptional()
  endLng?: number | null;

  @IsNumber()
  @IsOptional()
  amphoeId?: number;

  @IsNumber()
  @IsOptional()
  localOrganizationId?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SmartApproveBudgetDto)
  @IsOptional()
  budgets?: SmartApproveBudgetDto[];
}

export class SmartApproveRequestDto {
  @IsString()
  @IsNotEmpty()
  strategyName: string;

  @IsString()
  @IsNotEmpty()
  tacticName: string;

  @IsString()
  @IsNotEmpty()
  planName: string;

  @ValidateNested()
  @Type(() => SmartApproveProjectDto)
  project: SmartApproveProjectDto;

  @IsString()
  @IsOptional()
  additionalContext?: string;
}

