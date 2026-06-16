import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

import {
  AI_KNOWLEDGE_RELATION_TYPES,
  AiKnowledgeRelationType,
} from '../entities/ai-knowledge-catalog-relation.entity';

/**
 * Wave wave-ai-knowledge-structure-mgmt — BE-03 (Phase 2, 2026-06-13).
 *
 * Request bodies for the documentation ER relations (topic iv — report
 * §2(iv) / §3.5). A relation is a `ai_knowledge_catalog_relations` row — a
 * DRAWN edge between two CATALOG tables, NOT a real Postgres foreign key.
 * Admin + super-admin only (Q-03).
 *
 * NO-DDL GUARANTEE (report §6.3 — ABSOLUTE): `onDeleteNote` is a free-text
 * DOCUMENTATION string (e.g. "CASCADE", "ลบรายการแม่ = ลบประวัติตาม"). It
 * never enforces any DB behaviour and never feeds DDL.
 *
 * Service-layer validation (BE-03):
 *   - both `fromTableId` / `toTableId` MUST reference LIVE (non-soft-
 *     deleted) catalog tables → else `400 CATALOG_RELATION_TABLE_INVALID`.
 *   - `fromTableId === toTableId` is rejected unless an explicit
 *     `allowSelf` flag is set (intentional self-relation) →
 *     `400 CATALOG_RELATION_SELF_LOOP`.
 *   - `relationType` is REQUIRED on create.
 *
 * Column-width caps mirror `ai_knowledge_catalog_relations` (DB-01 §3.5):
 *   - labelTh      ≤ 300  (varchar(300))
 *   - onDeleteNote ≤ 64   (varchar(64))
 */
export const CATALOG_RELATION_LABEL_MAX_LENGTH = 300;
export const CATALOG_RELATION_ON_DELETE_NOTE_MAX_LENGTH = 64;

export class CreateCatalogRelationDto {
  /** Source catalog table id (`ai_* → ai_*`). Must be live. */
  @IsUUID()
  fromTableId!: string;

  /** Target catalog table id (`ai_* → ai_*`). Must be live. */
  @IsUUID()
  toTableId!: string;

  /** Cardinality — REQUIRED on create (task: "relationType required"). */
  @IsIn([...AI_KNOWLEDGE_RELATION_TYPES])
  relationType!: AiKnowledgeRelationType;

  /** Edge label (e.g. "ลบรายการแม่ = ลบประวัติตาม"); omit / null. */
  @IsOptional()
  @IsString()
  @MaxLength(CATALOG_RELATION_LABEL_MAX_LENGTH)
  labelTh?: string | null;

  /**
   * Free-text on-delete note — DOCUMENTATION ONLY, never enforced at the
   * DB (no-DDL). Omit / null when none.
   */
  @IsOptional()
  @IsString()
  @MaxLength(CATALOG_RELATION_ON_DELETE_NOTE_MAX_LENGTH)
  onDeleteNote?: string | null;

  /** Position / draw order (≥ 0); defaults to 0. */
  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;

  /**
   * Explicitly permit a self-relation (`fromTableId === toTableId`). Future
   * UX exposes this for self-referencing tables; default false rejects the
   * accidental self-loop with `400 CATALOG_RELATION_SELF_LOOP`.
   */
  @IsOptional()
  @IsBoolean()
  allowSelf?: boolean;
}

export class UpdateCatalogRelationDto {
  /** Edit cardinality; omit to keep unchanged. */
  @IsOptional()
  @IsIn([...AI_KNOWLEDGE_RELATION_TYPES])
  relationType?: AiKnowledgeRelationType;

  /** Edit label; omit to keep, `null` to clear. */
  @IsOptional()
  @IsString()
  @MaxLength(CATALOG_RELATION_LABEL_MAX_LENGTH)
  labelTh?: string | null;

  /** Edit on-delete note (documentation); omit to keep, `null` to clear. */
  @IsOptional()
  @IsString()
  @MaxLength(CATALOG_RELATION_ON_DELETE_NOTE_MAX_LENGTH)
  onDeleteNote?: string | null;

  /** Re-position (≥ 0). */
  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;
}
