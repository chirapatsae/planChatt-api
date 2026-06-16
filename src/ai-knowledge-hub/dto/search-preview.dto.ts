import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

import {
  KnowledgeSearchItem,
  KNOWLEDGE_SEARCH_MAX_RESULTS,
} from '../services/knowledge-search.service';
import { ALL_KNOWLEDGE_DOMAIN_KEYS } from '../registry/derived-domain-map';

/**
 * Wave wave-ai-knowledge-hub — retrieval-test surface (BE).
 *
 * `POST /v1/ai-knowledge-hub/search-preview` request body. This is the
 * admin "ทดสอบการค้นเจอ" deterministic, zero-cost retrieval check: it
 * runs the SAME ranking as the `searchKnowledgeBase` AI tool so a pass
 * here guarantees the entry is in the candidate set the LLM would see —
 * WITHOUT spending any LLM tokens.
 *
 * CLAUDE.md references:
 *   - §17.2 — advisory only; this surface gates nothing.
 *   - §18.13 — zero-write read aggregator (one ranking read, no
 *     mutation of any kind).
 *   - §17.11 — admin + super-admin only (testing is an authoring
 *     action), no super-admin bypass branch.
 *
 * Whitelist validation (global `forbidNonWhitelisted: true`) rejects any
 * unknown property — same strictness as the sibling create / list DTOs.
 */
export class SearchPreviewDto {
  /** The query the AI tool would run; trimmed, 1..200 chars. */
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @MinLength(1)
  @MaxLength(200)
  query!: string;

  /**
   * Optional domain rank-boost key (soft boost, NOT a hard filter) —
   * identical semantics to the AI tool. Validated against the
   * code-declared domain registry so an unknown key fails loudly here
   * rather than being silently ignored downstream.
   */
  @IsOptional()
  @IsIn([...ALL_KNOWLEDGE_DOMAIN_KEYS])
  domainKey?: string;

  /**
   * The top-k the AI tool would actually pass (default 3, hard-capped
   * at {@link KNOWLEDGE_SEARCH_MAX_RESULTS} = 5). This bounds
   * `aiVisibleLimit` in the response — NOT the diagnostic candidate
   * window (which is widened server-side).
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(KNOWLEDGE_SEARCH_MAX_RESULTS)
  limit?: number;

  /**
   * The entry the admin just published and wants to confirm is
   * retrievable. When present, the response carries its 1-based
   * `targetRank` across the FULL ranked candidate set (or null when it
   * does not match the query / is not published).
   */
  @IsOptional()
  @IsUUID()
  expectEntryId?: string;
}

/**
 * `POST /v1/ai-knowledge-hub/search-preview` response.
 *
 * `items` reuses the EXACT {@link KnowledgeSearchItem} shape the AI tool
 * returns, so a pass here is byte-for-byte what the LLM would receive.
 */
export interface SearchPreviewResponseDto {
  /** The top-`aiVisibleLimit` ranked hits — what the AI tool would pass. */
  items: KnowledgeSearchItem[];
  /**
   * The top-k the LLM tool would actually receive (requested `limit`
   * or default 3, capped at {@link KNOWLEDGE_SEARCH_MAX_RESULTS} = 5).
   */
  aiVisibleLimit: number;
  /**
   * 1-based position of `expectEntryId` in the FULL ranked candidate
   * set, or null when it does not match the query at all / is not a
   * live published entry. (Note: a rank greater than `aiVisibleLimit`
   * means the entry IS retrievable but would NOT make it into the
   * LLM's candidate set at the current top-k.)
   */
  targetRank: number | null;
  /** ISO-8601 timestamp the preview was computed. */
  asOf: string;
}
