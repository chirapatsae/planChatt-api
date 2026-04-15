import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Body contract for POST /v1/ai/prompt-suggestions.
 *
 * Returns context-aware Thai imperative prompt hints for the AI composer.
 * All string context fields are optional and bounded to 200 chars.
 *
 * IMPORTANT: per §16.5, ISSUE_BASED suggestions must NOT reference
 * `ตัวชี้วัด` / KPI. The controller/service enforces this via the
 * format-aware system prompt.
 */
export class PromptSuggestionsDto {
  @IsString()
  @IsNotEmpty()
  @IsIn(['STRATEGY_BASED', 'ISSUE_BASED'])
  reportFormat!: 'STRATEGY_BASED' | 'ISSUE_BASED';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  strategyName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  tacticName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  planName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  developmentIssueName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  amphoeName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  organizationName?: string;
}
