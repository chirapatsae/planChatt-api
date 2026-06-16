import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Wave wave-ai-knowledge-structure-mgmt — BE-02 (2026-06-13).
 *
 * Request bodies for coverage-gap CRUD (topic ii — report §2(ii)). A gap
 * is a `node_kind = 'gap'` row in `ai_knowledge_domain_meta`. Admin +
 * super-admin only (Q-03).
 *
 * Column-width caps mirror `ai_knowledge_domain_meta` (DB-01 §3.2):
 *   - domainKey   ≤ 128  (varchar(128) — the gap's stable key)
 *   - labelTh     ≤ 200  (stored in `label_th_override`)
 *   - gapReasonTh ≤ 300  (varchar(300))
 *
 * Unlike a domain overlay, a UI-created gap is FULLY add/edit/delete-able
 * (Q-05 restricts only DERIVED domains). A gap key that collides with a
 * code domain key or an existing gap is rejected at the service layer
 * (`400 KNOWLEDGE_GAP_KEY_COLLISION`).
 */
export const KNOWLEDGE_GAP_LABEL_MAX_LENGTH = 200;
export const KNOWLEDGE_GAP_REASON_MAX_LENGTH = 300;

export class CreateKnowledgeGapDto {
  /**
   * Stable key for the gap node. Service-validated against the code
   * registry + existing overlay rows (`400 KNOWLEDGE_GAP_KEY_COLLISION`),
   * NOT an `@IsIn` here — a gap key is admin-authored free text within the
   * width cap, it must NOT be one of the known domain/gap keys.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  domainKey!: string;

  /** Thai display label (stored in `label_th_override`). */
  @IsString()
  @MinLength(1)
  @MaxLength(KNOWLEDGE_GAP_LABEL_MAX_LENGTH)
  labelTh!: string;

  /** Why this is a coverage gap (stored in `gap_reason_th`). */
  @IsOptional()
  @IsString()
  @MaxLength(KNOWLEDGE_GAP_REASON_MAX_LENGTH)
  gapReasonTh?: string;

  /** Position on the mind-map ring (≥ 0); defaults to 0. */
  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;
}

export class PatchKnowledgeGapDto {
  /** Edit Thai label; omit to keep unchanged. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(KNOWLEDGE_GAP_LABEL_MAX_LENGTH)
  labelTh?: string;

  /** Edit reason; omit to keep, `null` to clear. */
  @IsOptional()
  @IsString()
  @MaxLength(KNOWLEDGE_GAP_REASON_MAX_LENGTH)
  gapReasonTh?: string | null;

  /** Re-position the gap node (≥ 0). */
  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;

  /** Hide the gap from the mind-map render (display-only). */
  @IsOptional()
  @IsBoolean()
  isHidden?: boolean;
}
