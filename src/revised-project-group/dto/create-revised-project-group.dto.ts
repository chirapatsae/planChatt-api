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

/**
 * CLAUDE.md §14 / Wave SUPP-4 — lineage discriminator for the
 * `(prev_project_id, prev_project_type)` pair on `revised_project_groups`.
 *
 * - `ORIGINAL`   → parent is a `ProjectGroup` (main-plan fork)
 * - `REVISION`   → parent is a `RevisedProjectGroup` (chained revision fork)
 * - `SUPPLEMENT` → parent is a `SupplementProjectGroup` (supplement fork —
 *                  added in Wave SUPP-4, DB-01 widened the PG enum)
 */
export enum PrevProjectType {
  ORIGINAL = 'original',
  REVISION = 'revised',
  SUPPLEMENT = 'supplement',
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
