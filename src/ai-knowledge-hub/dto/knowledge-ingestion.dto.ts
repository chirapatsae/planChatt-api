import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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

import {
  AI_KNOWLEDGE_INGESTION_STATUSES,
  AiKnowledgeIngestionStatus,
} from '../entities/ai-knowledge-ingestion.entity';
import { PiiFlag } from '../services/pii-scan.util';

/**
 * Wave wave-ai-knowledge-hub — BE-03 (2026-06-12).
 *
 * DTOs for the ingest endpoint + quarantine review surfaces (task
 * §3.2 / §3.3; report §4).
 */

export const INGESTION_LIST_DEFAULT_LIMIT = 20;
/** Hard page-size cap (task §3.3 — "cap 100"). */
export const INGESTION_LIST_MAX_LIMIT = 100;

/** `GET /v1/ai-knowledge-hub/ingestions` query (ADMIN_OR_ABOVE). */
export class ListKnowledgeIngestionsQueryDto {
  @IsOptional()
  @IsUUID()
  sourceId?: string;

  @IsOptional()
  @IsIn([...AI_KNOWLEDGE_INGESTION_STATUSES])
  status?: AiKnowledgeIngestionStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(INGESTION_LIST_MAX_LIMIT)
  limit?: number;
}

/**
 * `POST /ingestions/:id/promote` — admin overrides for the mapped entry
 * fields. Omitted fields fall back to the staged payload's `title` /
 * `body_md` / `tags` and the source's `target_domain_key`. Overriding is
 * ALSO the PII-resolution path: promotion stays 422-blocked until the
 * EFFECTIVE mapped fields scan clean (Q4 — PII categorically forbidden).
 */
export class PromoteKnowledgeIngestionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  bodyMd?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  domainKey?: string;
}

export class RejectKnowledgeIngestionDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

/** API projection of one `ai_knowledge_ingestions` row (admin review). */
export interface KnowledgeIngestionDto {
  id: string;
  sourceId: string;
  idempotencyKey: string;
  /** Raw staged payload — admin review surface ONLY; never prompts. */
  payload: Record<string, unknown>;
  payloadBytes: number;
  /** §17.4 hash — surfaced for admin replay/dedupe display (task §7). */
  contentHash: string;
  receivedAt: string;
  status: AiKnowledgeIngestionStatus;
  validationErrors: Record<string, unknown> | null;
  piiFlags: { flags: PiiFlag[] } | null;
  reviewedByWorkHistoryId: string | null;
  reviewedAt: string | null;
  promotedEntryId: string | null;
  createdAt: string;
}

export interface KnowledgeIngestionListResponseDto {
  items: KnowledgeIngestionDto[];
  total: number;
  page: number;
  limit: number;
}

/**
 * `POST /ingest/:sourceKey` response. Deliberately terse — the external
 * caller learns the staging row id + verdict, never internal review
 * state. `duplicate: true` marks the idempotent-replay path (the
 * original row id is returned, no re-insert).
 */
export interface IngestResponseDto {
  id: string;
  status: AiKnowledgeIngestionStatus;
  duplicate: boolean;
  contentHash: string;
  piiFlagCount: number;
  receivedAt: string;
}
