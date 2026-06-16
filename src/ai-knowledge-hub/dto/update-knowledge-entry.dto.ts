import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import {
  AI_KNOWLEDGE_CLASSIFICATIONS,
  AiKnowledgeClassification,
} from '../types/ai-knowledge-classification.enum';
import {
  KNOWLEDGE_BODY_MAX_LENGTH,
  KNOWLEDGE_TAG_MAX_LENGTH,
  KNOWLEDGE_TAGS_MAX_COUNT,
  KNOWLEDGE_TITLE_MAX_LENGTH,
} from './create-knowledge-entry.dto';

/**
 * Wave wave-ai-knowledge-hub — BE-02 (2026-06-12).
 *
 * `PATCH /v1/ai-knowledge-hub/entries/:id` request body (admin +
 * super-admin only per Q2).
 *
 * Concurrency contract (task §8):
 *   - `currentVersion` is REQUIRED — the optimistic-concurrency token.
 *     The caller echoes the `currentVersion` it last read; a mismatch
 *     with the live row → `409 KNOWLEDGE_VERSION_CONFLICT` and nothing
 *     is written.
 *
 * Edit semantics (task §3 / §17.4):
 *   - All content fields are optional; omitted fields keep their stored
 *     value (merge-patch).
 *   - An effective change writes an IMMUTABLE revision row vN+1 and bumps
 *     `current_version`; revisions are never updated in place.
 *   - A no-op PATCH (identical content hash AND identical metadata) is
 *     idempotent: returns the existing state, writes NO revision, NO
 *     audit row, zero mutation (Wave-10 idempotent-short-circuit spirit).
 *   - `status` is NOT patchable — lifecycle moves only via the explicit
 *     publish / archive endpoints (§17.5 explicit human action).
 *   - `origin` / `sourceId` are NOT patchable — provenance is stamped at
 *     birth (create / BE-03 promotion) and never flips.
 */
export class UpdateKnowledgeEntryDto {
  /** Optimistic-concurrency token — the version the caller last read. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  currentVersion!: number;

  /**
   * Service-validated against `ALL_KNOWLEDGE_DOMAIN_KEYS` →
   * `400 KNOWLEDGE_DOMAIN_UNKNOWN`.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  domainKey?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(KNOWLEDGE_TITLE_MAX_LENGTH)
  title?: string;

  /** Stored verbatim — §17.9 wrap happens at consumption (BE-04). */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(KNOWLEDGE_BODY_MAX_LENGTH)
  bodyMd?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(KNOWLEDGE_TAGS_MAX_COUNT)
  @IsString({ each: true })
  @MaxLength(KNOWLEDGE_TAG_MAX_LENGTH, { each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(8)
  language?: string;

  @IsOptional()
  @IsIn([...AI_KNOWLEDGE_CLASSIFICATIONS])
  classification?: AiKnowledgeClassification;
}
