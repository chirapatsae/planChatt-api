import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import {
  AI_KNOWLEDGE_CLASSIFICATIONS,
  AiKnowledgeClassification,
} from '../types/ai-knowledge-classification.enum';
import {
  AiKnowledgeSourceMode,
  AiKnowledgeSourceStatus,
} from '../entities/ai-knowledge-source.entity';

/**
 * Wave wave-ai-knowledge-hub — BE-03 (2026-06-12).
 *
 * DTOs for the connector-source admin console (task §3.1; report §4).
 *
 * Q3 LOCKED: `mode` is NOT accepted from the client — every v1 source is
 * `webhook` push. Q4 LOCKED: `classificationCeiling` value set already
 * tops out at `internal` (the enum has no higher tier), so the ceiling
 * can never exceed it.
 */

/** Hard ceiling on payload size — 256 KB per report §4 / §17.15.5. */
export const KNOWLEDGE_SOURCE_MAX_PAYLOAD_BYTES = 262144;

export class CreateKnowledgeSourceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  description: string;

  /** URL slug for `POST …/ingest/:sourceKey` — lowercase slug only. */
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9_-]{2,63}$/, {
    message:
      'sourceKey ต้องเป็นตัวอักษรพิมพ์เล็ก/ตัวเลข/ขีด ความยาว 3-64 ตัวอักษร',
  })
  sourceKey: string;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  owningAgencyNote: string;

  /** Declared JSON schema every inbound item is validated against. */
  @IsObject()
  payloadSchema: Record<string, unknown>;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  targetDomainKey: string;

  @IsOptional()
  @IsIn([...AI_KNOWLEDGE_CLASSIFICATIONS])
  classificationCeiling?: AiKnowledgeClassification;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  rateLimitPerMin?: number;

  @IsOptional()
  @IsInt()
  @Min(1024)
  @Max(KNOWLEDGE_SOURCE_MAX_PAYLOAD_BYTES)
  maxPayloadBytes?: number;

  /** PDPA records-of-processing — required non-empty (docs/pdpa/02). */
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  purposeDeclaration: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  lawfulBasis: string;
}

/**
 * `PATCH /sources/:id` — schema / rate-limit / domain / descriptive
 * edits ONLY. Status transitions and credential fields are NOT
 * patchable (dedicated endpoints + server-generated secrets).
 */
export class UpdateKnowledgeSourceDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  description?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  owningAgencyNote?: string;

  @IsOptional()
  @IsObject()
  payloadSchema?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  targetDomainKey?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  rateLimitPerMin?: number;

  @IsOptional()
  @IsInt()
  @Min(1024)
  @Max(KNOWLEDGE_SOURCE_MAX_PAYLOAD_BYTES)
  maxPayloadBytes?: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  purposeDeclaration?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  lawfulBasis?: string;
}

/** Per-source staging health counters (report §4 "Monitoring"). */
export interface KnowledgeSourceHealthDto {
  quarantined: number;
  rejected: number;
  promoted: number;
  purged: number;
}

/**
 * API projection of one `ai_knowledge_sources` row. NEVER includes
 * `api_key_hash` / `hmac_secret_hash` — secrets are unrecoverable
 * (§17.15.7: no role may read a stored key, only rotate).
 */
export interface KnowledgeSourceDto {
  id: string;
  name: string;
  description: string;
  sourceKey: string;
  owningAgencyNote: string;
  mode: AiKnowledgeSourceMode;
  status: AiKnowledgeSourceStatus;
  /** Non-secret display prefix (`pbk_live_xxx`) — NOT the key. */
  apiKeyPrefix: string;
  payloadSchema: Record<string, unknown>;
  targetDomainKey: string;
  classificationCeiling: AiKnowledgeClassification;
  rateLimitPerMin: number;
  maxPayloadBytes: number;
  /**
   * Whether this source requires an HMAC-SHA256 body signature on ingest
   * (derived: `hmac_secret_hash IS NOT NULL`). Boolean ONLY — the secret
   * itself (ciphertext or plaintext) NEVER leaves the service layer.
   */
  hmacEnabled: boolean;
  purposeDeclaration: string;
  lawfulBasis: string;
  createdByWorkHistoryId: string;
  approvedByWorkHistoryId: string | null;
  approvedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  health: KnowledgeSourceHealthDto;
}

/**
 * `POST /sources` response — the ONLY surface (besides rotate-key) where
 * the plaintext key ever appears. It is never persisted and never logged.
 */
export interface KnowledgeSourceCreatedDto {
  source: KnowledgeSourceDto;
  /** Plaintext API key — shown ONCE; unrecoverable afterwards. */
  apiKey: string;
}

export interface KnowledgeSourceRotateKeyResponseDto {
  id: string;
  /** NEW plaintext API key — shown ONCE; the old key stops working. */
  apiKey: string;
  apiKeyPrefix: string;
}

/**
 * `POST /sources/:id/rotate-hmac-secret` response — the ONLY surface where
 * the plaintext HMAC secret ever appears. It is stored AES-encrypted-at-
 * rest, never logged, and unrecoverable in plaintext afterwards. The
 * source signs each ingest request as
 * `X-PBK-Signature: base64(HMAC-SHA256(secret, rawRequestBody))`.
 */
export interface KnowledgeSourceRotateHmacResponseDto {
  id: string;
  /** Plaintext HMAC secret — shown ONCE; the old secret stops working. */
  hmacSecret: string;
}

export interface KnowledgeSourceListResponseDto {
  items: KnowledgeSourceDto[];
  total: number;
}
