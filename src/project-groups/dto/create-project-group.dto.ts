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
  IsString,
} from 'class-validator';
import { CreateBudgetDto } from 'src/budget/dto/create-budget.dto';

// ADD_PROJECT_PREVENT_STEP_BYPASS
//
// CreateProjectGroupDto is the non-draft create / publish-draft payload.
// Completeness of wizard fields is enforced at the SERVICE layer via
// `ProjectGroupsService.assertWizardCompleteness`, which emits a
// structured `VALIDATION_FAILED` response with a `missingFields` array.
// The DTO therefore keeps the wizard fields `@IsOptional()` at the
// class-validator layer — the service check is the single source of
// truth and gives the frontend a richer error contract than the pipe's
// default shape.
//
// `indicator` and the classification tuple remain `@IsOptional()`
// because the shape invariant (CLAUDE.md §16.5) is enforced by
// `ProjectClassificationValidator` — STRATEGY_BASED requires
// `indicator`, ISSUE_BASED forbids it.
//
// The draft DTO (`CreateDraftProjectGroupDto`) MUST NOT be tightened —
// drafts are allowed to be partial by design.
export class CreateProjectGroupDto {
  @IsNotEmpty()
  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  objective?: string;

  @IsOptional()
  @IsString()
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

  // Conditionally required by shape invariant (§16.5); see
  // ProjectClassificationValidator.
  @IsOptional()
  indicator?: string;

  @IsOptional()
  @IsString()
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

  /**
   * CLAUDE.md §16 Multi-Format Reporting — ISSUE_BASED classification.
   * Mutually exclusive with (strategyId, tacticId, planId, indicator).
   * The shape invariant is enforced server-side by
   * `ProjectClassificationValidator` before any repository write.
   */
  @IsOptional()
  @IsUUID()
  developmentIssueId?: string;

  @IsNotEmpty()
  @IsUUID()
  developmentPlanId: string;

  @IsOptional()
  @IsBoolean()
  isBooked?: boolean;

  // Budget completeness is enforced by assertWizardCompleteness (service).
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
  @IsUUID()
  developmentPlanId?: string;

  @IsOptional()
  strategyId?: string;

  @IsOptional()
  tacticId?: string;

  @IsOptional()
  planId?: string;

  /**
   * CLAUDE.md §16 Multi-Format Reporting — ISSUE_BASED classification
   * on draft creation. The validator still runs on drafts.
   */
  @IsOptional()
  @IsUUID()
  developmentIssueId?: string;


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
