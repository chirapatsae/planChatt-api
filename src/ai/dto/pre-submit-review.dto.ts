import { IsString, IsOptional, IsIn, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { SmartApproveProjectDto } from './smart-approve.dto';

/**
 * DTO for the pre-submit quality review endpoint.
 *
 * Mirrors SmartApproveRequestDto but adds `reportFormat` so the service can
 * branch on STRATEGY_BASED vs ISSUE_BASED (CLAUDE.md §16.5).
 *
 * All classification fields are optional at the DTO layer because:
 *  - STRATEGY_BASED sends strategyName / tacticName / planName
 *  - ISSUE_BASED sends developmentIssueName only
 */
export class PreSubmitReviewDto {
  /** Determines evaluation shape (CLAUDE.md §16.5). Defaults to STRATEGY_BASED. */
  @IsString()
  @IsIn(['STRATEGY_BASED', 'ISSUE_BASED'])
  @IsOptional()
  reportFormat?: 'STRATEGY_BASED' | 'ISSUE_BASED';

  // ── STRATEGY_BASED classification ───────────────────────────────────────────
  @IsString()
  @IsOptional()
  strategyName?: string;

  @IsString()
  @IsOptional()
  tacticName?: string;

  @IsString()
  @IsOptional()
  planName?: string;

  // ── ISSUE_BASED classification (CLAUDE.md §16.5) ────────────────────────────
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
