import {
  IsString,
  IsOptional,
  IsIn,
  IsUUID,
  IsArray,
  ValidateNested,
} from 'class-validator';
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

  /**
   * Wave 24 N4 — optional plan-scoped DevelopmentIssue id used to
   * resolve the criteria registry entry. Callers that only know the
   * issue's name may omit this; the service falls back to
   * `IssueCriteriaRegistryService.findByIssueName`. Additive field;
   * backward-compatible with Wave 13 callers.
   */
  @IsUUID()
  @IsOptional()
  developmentIssueId?: string;

  @ValidateNested()
  @Type(() => SmartApproveProjectDto)
  project: SmartApproveProjectDto;

  @IsString()
  @IsOptional()
  additionalContext?: string;

  /**
   * Wave 24 N4 — optional attachment OCR summaries for the evidence
   * auto-check. Loose inline shape mirrors
   * `CreatePreSubmitSnapshotDto.attachments` so the FE can forward the
   * same payload. Additive field; byte-identical behavior for callers
   * that omit it.
   */
  @IsArray()
  @IsOptional()
  attachments?: Array<{
    id: string;
    aiTopic?: string | null;
    aiSummary?: string | null;
    evidenceLink?: string | null;
  }>;

  /**
   * Wave 28 N1 — optional clicked sub-type code used to tighten the
   * criteria-aware prompt. When supplied AND the registry matches, the
   * composer emits a `[SUB_TYPE_SCOPE]` section so the LLM stays within
   * the chosen sub-type frame. Invalid / unmatched values are silently
   * dropped by the composer (§17.9). Additive; omitting preserves
   * pre-Wave-28 prompt output.
   */
  @IsString()
  @IsOptional()
  subTypeCode?: string;

  /**
   * Wave AI-Enforcement-Model (2026-05-22) — optional self-id used by
   * the deterministic title-uniqueness pre-check. When set, the
   * duplicate-title query excludes this project's own row so re-runs
   * on ReadyToSendPage don't false-positive against the project's
   * own stored title. AddProject pre-submit flow leaves this empty
   * because the project row does not yet exist.
   *
   * §17.2 advisory — drives a non-blocking criterion verdict.
   * §17.9 — UUID is a closed-set value; not user prose.
   */
  @IsString()
  @IsOptional()
  targetProjectId?: string;
}
