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
  IsEnum,
} from 'class-validator';
import { CreateBudgetDto } from 'src/budget/dto/create-budget.dto';

export enum PrevProjectType {
  ORIGINAL = 'original',
  REVISION = 'revised',
}

export class CreateRevisedProjectGroupDto {
  @IsNotEmpty()
  @IsUUID()
  developmentPlanRevisionId: string;

  @IsOptional()
  @IsUUID()
  developmentPlanId?: string;

  @IsOptional()
  @IsUUID()
  projectGroupId?: string; 

  @IsNotEmpty()
  title: string;

  @IsNotEmpty()
  objective: string;

  @IsNotEmpty()
  goal: string;

  /**
   * CLAUDE.md §16.5 — nullable for ISSUE_BASED. The service-layer
   * `ProjectClassificationValidator` enforces the shape invariant.
   */
  @IsOptional()
  indicator?: string;

  @IsNotEmpty()
  expected: string;

  @IsNotEmpty()
  @IsInt()
  projectYear: number;

  @IsOptional()
  strategyId?: string;

  @IsOptional()
  tacticId?: string;

  @IsOptional()
  planId?: string;

  /**
   * CLAUDE.md §16 Multi-Format Reporting — ISSUE_BASED classification.
   * Mutually exclusive with (strategyId, tacticId, planId, indicator).
   */
  @IsOptional()
  @IsUUID()
  developmentIssueId?: string;

  @IsNotEmpty()
  prevProjectId: string;

  @IsNotEmpty()
  @IsEnum(PrevProjectType)
  prevProjectType: PrevProjectType;

  @IsOptional()
  additionalDetail?: string;

  @IsOptional()
  oldAdditionDetail?: string;

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
  amphoeId?: string;

  @IsOptional()
  localAdministrativeOrganizationId?: string;

  @IsOptional()
  originAgencyId?: string | null;

  @IsNotEmpty()
  responsibleAgency: string;

  @IsOptional()
  @IsBoolean()
  isBooked?: boolean;

  @IsOptional()
  bookedAt?: Date;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateBudgetDto)
  budget?: CreateBudgetDto[];
}
