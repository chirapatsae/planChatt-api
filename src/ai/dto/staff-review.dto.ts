import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SmartApproveProjectDto } from './smart-approve.dto';

/**
 * Wave 41 N4 — Staff Review analyze DTO.
 *
 * Mirrors `PreSubmitReviewDto` plus the reviewer-specific fields needed
 * for caching and cooldown:
 *   - `targetKind` + `targetId`: discriminated FK-less reference to
 *     project-group / revised-project-group / supplement-project-group
 *     (§17.3 audit separation).
 *   - `projectId`: cooldown keyer (CLAUDE.md §17.8 —
 *     `('staff-review', 10, 'body.projectId')`). MUST equal `targetId`
 *     for FE consistency; service does NOT enforce equality because the
 *     cooldown keyer is intentionally stupid.
 *   - `recompute`: explicit cache bypass. Missing / false = cache-first.
 *
 * §17.9 — user-sourced strings (title / objective / additionalContext /
 * attachment `aiSummary` etc.) pass through to the prompt service which
 * wraps them in `<<<USER_INPUT>>>...<<<END>>>` delimiters before
 * prompting.
 */
export class StaffReviewAnalyzeDto {
  /** §16.5 discriminator — drives classification-shape branching. */
  @IsString()
  @IsIn(['STRATEGY_BASED', 'ISSUE_BASED'])
  @IsOptional()
  reportFormat?: 'STRATEGY_BASED' | 'ISSUE_BASED';

  // ── STRATEGY_BASED classification ───────────────────────────────────
  @IsString()
  @IsOptional()
  strategyName?: string;

  @IsString()
  @IsOptional()
  tacticName?: string;

  @IsString()
  @IsOptional()
  planName?: string;

  // ── ISSUE_BASED classification (§16.5) ──────────────────────────────
  @IsString()
  @IsOptional()
  developmentIssueName?: string;

  @IsUUID()
  @IsOptional()
  developmentIssueId?: string;

  @ValidateNested()
  @Type(() => SmartApproveProjectDto)
  project: SmartApproveProjectDto;

  /**
   * Wave 41 N8 P2 — cap at USER_CONTEXT_CAP (2000 chars) to match the
   * server-side slice in `StaffReviewPromptService.capUserText`. FE may
   * submit shorter; service trims further if needed. Stops payload-flood
   * attempts before they reach the prompt builder.
   */
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  additionalContext?: string;

  /**
   * Wave 41 N8 P2 — cap attachment count. Owner pre-submit DTO has no
   * documented cap; we default to 20 per reviewer guidance. Oversize
   * requests are rejected before the prompt builder iterates them.
   */
  @IsArray()
  @IsOptional()
  @ArrayMaxSize(20)
  attachments?: Array<{
    id: string;
    aiTopic?: string | null;
    aiSummary?: string | null;
    evidenceLink?: string | null;
  }>;

  @IsString()
  @IsOptional()
  subTypeCode?: string;

  // ── Reviewer-specific fields ────────────────────────────────────────

  /** §17.3 target kind — one of the three project entity kinds. */
  @IsString()
  @IsIn(['project-group', 'revised-project-group', 'supplement-project-group'])
  targetKind:
    | 'project-group'
    | 'revised-project-group'
    | 'supplement-project-group';

  @IsUUID()
  targetId: string;

  /**
   * §17.8 cooldown keyer. FE should pass the same UUID as `targetId`;
   * the guard pulls this field verbatim via `body.projectId`.
   */
  @IsUUID()
  projectId: string;

  /**
   * §17.5 — explicit bypass flag. When `true`, skip the cache lookup
   * and force a fresh LLM call (still writes the result into the cache
   * afterwards). Default `false` ⇒ cache-first.
   */
  @IsBoolean()
  @IsOptional()
  recompute?: boolean;
}
