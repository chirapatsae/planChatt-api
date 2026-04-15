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
  // STRATEGY_BASED classification fields (CLAUDE.md §16.5)
  // Optional at the DTO layer because ISSUE_BASED payloads omit them.
  // STRATEGY_BASED callers still supply all three; precheck logic treats
  // missing names as non-matches, which is the correct behavior for both
  // formats.
  @IsString()
  @IsOptional()
  strategyName?: string;

  @IsString()
  @IsOptional()
  tacticName?: string;

  @IsString()
  @IsOptional()
  planName?: string;

  // ISSUE_BASED classification field (CLAUDE.md §16.5)
  // Present only for ISSUE_BASED payloads.
  @IsString()
  @IsOptional()
  developmentIssueName?: string;

  @ValidateNested()
  @Type(() => SmartApproveProjectDto)
  project: SmartApproveProjectDto;

  @IsString()
  @IsOptional()
  additionalContext?: string;
}

