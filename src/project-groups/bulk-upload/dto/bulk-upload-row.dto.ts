import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

/**
 * W113-BE-VALIDATE — single budget line on a bulk-upload row. Mirrors
 * `CreateBudgetDto` minus the project FKs (the bulk endpoint resolves
 * the FK after insert). The `quantity` is `@IsOptional()` to match the
 * single-row contract — `assertWizardCompleteness` enforces the
 * "at least one positive quantity" rule on the publish path.
 */
export class BulkUploadBudgetDto {
  @IsNotEmpty()
  @IsNumber()
  year: number;

  @IsOptional()
  @IsNumber()
  quantity?: number;
}

/**
 * W113-BE-VALIDATE / CLAUDE.md §16.5 / §19 — input row shape for the
 * `POST /project-groups/bulk` endpoint (and its `/validate` sibling).
 *
 * One row represents ONE project-to-be. The classification slot is
 * shape-conditional per §16.5:
 *   - STRATEGY_BASED → `strategyId`, `tacticId`, `planId`, `indicator`
 *   - ISSUE_BASED   → `developmentIssueId`
 *
 * The DTO keeps every classification slot `@IsOptional()` because the
 * shape invariant is enforced by `ProjectClassificationValidator` in the
 * service layer (matches the single-row `CreateProjectGroupDto` contract
 * verbatim — see ADD_PROJECT_PREVENT_STEP_BYPASS).
 */
export class BulkUploadRowDto {
  // §16.5 STRATEGY_BASED slot
  @IsOptional()
  @IsUUID()
  strategyId?: string;

  @IsOptional()
  @IsUUID()
  tacticId?: string;

  @IsOptional()
  @IsUUID()
  planId?: string;

  @IsOptional()
  @IsString()
  indicator?: string;

  // §16.5 ISSUE_BASED slot
  @IsOptional()
  @IsUUID()
  developmentIssueId?: string;

  // shared fields
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

  @IsOptional()
  @IsString()
  expected?: string;

  @IsNotEmpty()
  @IsNumber()
  projectYear: number;

  // §19.6 — non-empty + positive-quantity rule is enforced by
  // `assertWizardCompleteness` on the PUBLISH path only. The DTO must
  // accept `[]` (or omitted) on the DRAFT path because draft rows
  // legitimately carry no budget yet. Do NOT add `@ArrayMinSize(1)`
  // here — that decorator runs at the NestJS validation pipe before
  // saveType branching and would reject every draft upload.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkUploadBudgetDto)
  budget?: BulkUploadBudgetDto[];

  /**
   * Optional client-supplied row index for error reporting back to the
   * UI. The validator preserves this as `clientRowIndex` on every
   * `BulkUploadRowResult` so the frontend can highlight the correct row
   * in the preview table.
   */
  @IsOptional()
  @IsNumber()
  clientRowIndex?: number;
}
