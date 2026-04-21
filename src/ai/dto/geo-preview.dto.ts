import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

/**
 * Wave 35 N1 — lightweight preview DTO.
 *
 * No `userPrompt`, no classification names (strategy / tactic / plan /
 * developmentIssueName), no usage-based or workflow fields. The input
 * surface is intentionally minimal so this endpoint cannot be coerced
 * into producing LLM output or persistent side-effects.
 *
 * CLAUDE.md compliance:
 *   - §17.9 — by declining to accept user prose at all, the preview
 *     endpoint has no prompt-injection surface.
 *   - §17.2 advisory — payload fields are read-only inputs to
 *     deterministic services (Wave 29/30/31/33.6).
 */
export class GeoPreviewDto {
  @IsNumber()
  lat!: number;

  @IsNumber()
  lng!: number;

  @IsOptional()
  @IsString()
  subTypeCode?: string;

  @IsOptional()
  @IsString()
  organizationType?: string;

  @IsOptional()
  @IsIn(['ISSUE_BASED', 'STRATEGY_BASED'])
  reportFormat?: 'ISSUE_BASED' | 'STRATEGY_BASED';

  @IsOptional()
  @IsBoolean()
  isLao?: boolean;
}
