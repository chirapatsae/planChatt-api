import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { AiKnowledgeClassification } from '../types/ai-knowledge-classification.enum';

/**
 * Wave wave-ai-knowledge-hub — BE-02 (2026-06-12).
 *
 * Query DTO + response shapes for the curated-knowledge read surfaces.
 *
 * IMPORTANT (task §3): the `status` values here are the ENTRY LIFECYCLE
 * statuses (`draft | published | archived`) — NOT workflow statuses. No
 * W67 mapping applies; canonical workflow status names are never reused
 * on this surface.
 */
export const KNOWLEDGE_ENTRY_STATUSES = [
  'draft',
  'published',
  'archived',
] as const;
export type KnowledgeEntryStatus = (typeof KNOWLEDGE_ENTRY_STATUSES)[number];

export const KNOWLEDGE_LIST_DEFAULT_LIMIT = 20;
/** Hard page-size cap (task §3 — "cap limit 100"). */
export const KNOWLEDGE_LIST_MAX_LIMIT = 100;

/**
 * `GET /v1/ai-knowledge-hub/entries` query params (EXEC_READ).
 *
 * Visibility: non-admin callers (staff / c-level) see `published` rows
 * ONLY — their `status` filter is overridden server-side. Admin and
 * super-admin may filter any lifecycle status.
 */
export class ListKnowledgeEntriesQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  domainKey?: string;

  @IsOptional()
  @IsIn([...KNOWLEDGE_ENTRY_STATUSES])
  status?: KnowledgeEntryStatus;

  /** Free-text search over title + body (pg_trgm-backed ILIKE, Q5). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(KNOWLEDGE_LIST_MAX_LIMIT)
  limit?: number;
}

/** API projection of one `ai_knowledge_entries` row. */
export interface KnowledgeEntryDto {
  id: string;
  domainKey: string;
  title: string;
  bodyMd: string;
  tags: string[];
  origin: 'curated' | 'external';
  sourceId: string | null;
  status: KnowledgeEntryStatus;
  currentVersion: number;
  contentHash: string;
  language: string;
  classification: AiKnowledgeClassification;
  createdByWorkHistoryId: string;
  updatedByWorkHistoryId: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeEntryListResponseDto {
  items: KnowledgeEntryDto[];
  total: number;
  page: number;
  limit: number;
}

/** API projection of one immutable `ai_knowledge_entry_revisions` row. */
export interface KnowledgeEntryRevisionDto {
  id: string;
  entryId: string;
  version: number;
  title: string;
  bodyMd: string;
  tags: string[];
  contentHash: string;
  editedByWorkHistoryId: string;
  createdAt: string;
}

export interface KnowledgeEntryDeleteResponseDto {
  id: string;
  deleted: true;
}
