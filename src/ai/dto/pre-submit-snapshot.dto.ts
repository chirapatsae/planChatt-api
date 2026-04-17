import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Body DTO for POST /v1/ai/pre-submit-review/snapshot.
 *
 * The backend does NOT re-run the LLM here — the payload carries the
 * user-side pre-submit review result already produced by
 * `/ai/pre-submit-review`. The service computes the content hash from the
 * project state server-side (§17.4) and stores the result verbatim.
 *
 * Ownership check uses `targetKind` + `targetId` against the caller's
 * current WorkHistory.id (§4 ownership source of truth).
 */

export class PreSubmitReviewResultDto {
  /** 0..100 overall score produced by `/ai/pre-submit-review`. */
  @IsInt()
  @Min(0)
  @Max(100)
  @IsOptional()
  overallScore?: number;

  @IsString()
  @IsOptional()
  readinessLabel?: string;

  @IsString()
  @IsOptional()
  rationale?: string;

  @IsString()
  @IsOptional()
  strongPoint?: string;

  /**
   * AI-generated improvement suggestions (may be empty when score is high
   * and no concrete gaps exist). Payload shape is advisory per §17.2;
   * stored as opaque JSONB in `ai_pre_submit_snapshots.suggestions_json`.
   * Matches the Wave 9 `usage` field pattern — passed through without
   * nested-element validation.
   */
  @IsArray()
  @IsOptional()
  suggestions?: Record<string, unknown>[];

  @IsArray()
  @IsOptional()
  checklistSummary?: unknown[];

  @IsString()
  @IsOptional()
  model?: string;

  @IsObject()
  @IsOptional()
  categories?: Record<string, unknown>;

  /**
   * OpenAI token/cost metadata passed through from `ai.service.ts`
   * `generatePreSubmitReview` (prompt_tokens, completion_tokens). Whitelisted
   * here so `forbidNonWhitelisted: true` + `@ValidateNested()` does not
   * reject the AI-result submit with a silent 400. §17 advisory-only —
   * the value is persisted into `result_json` as audit context; no
   * workflow decision depends on it.
   */
  @IsOptional()
  @IsObject()
  usage?: Record<string, unknown>;
}

export class ProjectHashInputDto {
  @IsString() @IsOptional() title?: string | null;
  @IsString() @IsOptional() objective?: string | null;
  @IsString() @IsOptional() goal?: string | null;
  @IsString() @IsOptional() expected?: string | null;
  @IsString() @IsOptional() indicator?: string | null;
  @IsOptional() startLat?: number | null;
  @IsOptional() startLng?: number | null;
  @IsOptional() endLat?: number | null;
  @IsOptional() endLng?: number | null;
  @IsOptional() amphoeId?: number | string | null;
  @IsOptional() localOrganizationId?: number | string | null;
  @IsArray() @IsOptional() budgets?: Array<{ year: number; quantity: number }>;
}

export class ClassificationHashInputDto {
  @IsString()
  @IsIn(['STRATEGY_BASED', 'ISSUE_BASED'])
  reportFormat: 'STRATEGY_BASED' | 'ISSUE_BASED';

  @IsString() @IsOptional() strategyName?: string | null;
  @IsString() @IsOptional() tacticName?: string | null;
  @IsString() @IsOptional() planName?: string | null;
  @IsString() @IsOptional() developmentIssueName?: string | null;
}

export class CreatePreSubmitSnapshotDto {
  @IsString()
  @IsIn(['project-group', 'revised-project-group', 'supplement-project-group'])
  targetKind:
    | 'project-group'
    | 'revised-project-group'
    | 'supplement-project-group';

  @IsUUID()
  targetId: string;

  @IsString()
  @IsIn(['add', 'revision', 'change'])
  workflow: 'add' | 'revision' | 'change';

  /**
   * AI pre-submit review result produced by `/ai/pre-submit-review`.
   *
   * Accepted as an opaque bag (`Record<string, unknown> | null`) to avoid
   * class-transformer's `Array.from()` coercion of nested array elements.
   * With `@ValidateNested() + @Type(() => PreSubmitReviewResultDto)` +
   * `ValidationPipe { transform: true, enableImplicitConversion: true }`,
   * class-transformer descends into `suggestions: Record<string, unknown>[]`
   * (which has no @Type() on elements) and coerces each plain object via
   * `Array.from({...})` → `[]`, producing `[[], [], [], [], []]` in DB.
   *
   * Downgrading to an opaque `Record<string, unknown>` bag stops descent.
   * The service already treats `result_json` as opaque jsonb and uses
   * runtime `Array.isArray` guards, so this is drop-in safe.
   *
   * §17.2 advisory-only — AI output does not gate workflow; shape
   *   validation is not required.
   * §17.9 prompt-injection defense — applies to LLM INPUTS; AI OUTPUT
   *   validation is not a security boundary.
   *
   * When `null` or undefined, the service writes a "no-AI baseline" audit
   * row (see §17.2 advisory-only, §17.4 snapshot-only, task file
   * ADD_NO_AI_BASELINE_SNAPSHOT §7.2). Zero OpenAI call, zero quota
   * deduction, zero `ai_usage_logs` row — the row is an audit marker
   * declaring that the owner submitted WITHOUT running user-side AI
   * pre-submit review.
   */
  @IsOptional()
  @IsObject()
  result?: Record<string, unknown> | null;

  /**
   * Canonical hash-input — used server-side to compute `content_hash` via
   * `computeSmartApproveContentHash`. Mirrors the payload shape sent to
   * `/ai/pre-submit-review` so the hash matches what would be produced on
   * a live recompute.
   */
  @ValidateNested()
  @Type(() => ProjectHashInputDto)
  project: ProjectHashInputDto;

  @ValidateNested()
  @Type(() => ClassificationHashInputDto)
  classification: ClassificationHashInputDto;

  @IsArray()
  @IsOptional()
  attachments?: Array<{
    id: string;
    aiStatus?: string | null;
    aiTopic?: string | null;
    aiSummary?: string | null;
    aiExtractionQualityScore?: number | null;
  }>;
}
