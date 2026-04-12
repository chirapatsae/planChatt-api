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
  strategyId?: string | null;

  @IsOptional()
  tacticId?: string | null;

  @IsOptional()
  planId?: string | null;

  /**
   * §16 Multi-Format Reporting — ISSUE_BASED classification.
   * Exactly one of {strategyId+tacticId+planId+indicator} OR {developmentIssueId}
   * must be populated, validated by ProjectClassificationValidator per the
   * parent plan's reportFormat.
   */
  @IsOptional()
  @IsUUID()
  developmentIssueId?: string | null;

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


