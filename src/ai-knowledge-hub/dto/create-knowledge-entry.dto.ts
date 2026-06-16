import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import {
  AI_KNOWLEDGE_CLASSIFICATIONS,
  AiKnowledgeClassification,
} from '../types/ai-knowledge-classification.enum';

/**
 * Wave wave-ai-knowledge-hub — BE-02 (2026-06-12).
 *
 * Input caps (task §3 — belt-and-braces with the DB column widths):
 *   - title   ≤ 300 chars   (matches `ai_knowledge_entries.title` varchar(300))
 *   - body_md ≤ 20,000 chars
 *   - tags    ≤ 20 items
 *
 * The caps exist for §17.9 hygiene (bounded user-controlled text) and the
 * task §8 "large markdown paste" edge case — oversize input fails loudly
 * with a 400 instead of a DB-level truncation/error.
 */
export const KNOWLEDGE_TITLE_MAX_LENGTH = 300;
export const KNOWLEDGE_BODY_MAX_LENGTH = 20_000;
export const KNOWLEDGE_TAGS_MAX_COUNT = 20;
export const KNOWLEDGE_TAG_MAX_LENGTH = 100;

/**
 * `POST /v1/ai-knowledge-hub/entries` request body (admin + super-admin
 * only per Q2 LOCKED 2026-06-12).
 *
 * Notes:
 *   - `domainKey` is service-validated against BE-01's
 *     `ALL_KNOWLEDGE_DOMAIN_KEYS` → `400 KNOWLEDGE_DOMAIN_UNKNOWN`
 *     (structured code; NOT an `@IsIn` here, so the error contract stays
 *     stable even when the domain list grows).
 *   - `bodyMd` is stored VERBATIM (markdown). §17.9 delimiter-wrapping
 *     happens at CONSUMPTION (BE-04), never at storage — no sanitization
 *     here beyond the length cap.
 *   - `origin` is NOT accepted — `POST /entries` always creates
 *     `origin = 'curated'` (task §3; external rows are born via the
 *     BE-03 promotion path only).
 *   - `status` is NOT accepted — every new entry starts as `draft`;
 *     publish is a separate explicit human action (§17.5).
 */
export class CreateKnowledgeEntryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  domainKey!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(KNOWLEDGE_TITLE_MAX_LENGTH)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(KNOWLEDGE_BODY_MAX_LENGTH)
  bodyMd!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(KNOWLEDGE_TAGS_MAX_COUNT)
  @IsString({ each: true })
  @MaxLength(KNOWLEDGE_TAG_MAX_LENGTH, { each: true })
  tags?: string[];

  /** BCP-47-ish short code; defaults to 'th' (Q5 Thai-dominant corpus). */
  @IsOptional()
  @IsString()
  @MaxLength(8)
  language?: string;

  /** Q4 LOCKED: the set tops out at `internal`. Defaults to 'internal'. */
  @IsOptional()
  @IsIn([...AI_KNOWLEDGE_CLASSIFICATIONS])
  classification?: AiKnowledgeClassification;
}
