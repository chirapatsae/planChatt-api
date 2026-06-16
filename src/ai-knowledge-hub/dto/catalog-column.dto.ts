import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * Wave wave-ai-knowledge-structure-mgmt — BE-03 (Phase 2, 2026-06-13).
 *
 * Request body for the bulk column UPSERT (topic iii — report §2(iii) /
 * §3.4). `PUT /structure/catalog/tables/:id/columns` accepts the FULL
 * ordered column array for a table; the service diffs it against the
 * existing live columns, soft-deletes the removed, and upserts the
 * kept / added. Admin + super-admin only (Q-03).
 *
 * NO-DDL GUARANTEE (report §6.3 — ABSOLUTE): `columnName` / `dataType`
 * are PLAIN TEXT documentation strings; they are never SQL identifiers and
 * never feed any DDL.
 *
 * Column-width caps mirror `ai_knowledge_catalog_columns` (DB-01 §3.4):
 *   - columnName    ≤ 128  (varchar(128))
 *   - dataType      ≤ 64   (varchar(64) — free text, e.g. `uuid`, `varchar(300)`)
 *   - descriptionTh ≤ 4,000 (text — generous UI cap)
 *
 * Batch size cap: a documentation table has at most a few dozen columns;
 * 500 is an abundantly safe ceiling against an abusive payload (mirrors
 * the §19.6 bulk-cap discipline without claiming that rule applies).
 */
export const CATALOG_COLUMN_NAME_MAX_LENGTH = 128;
export const CATALOG_COLUMN_DATA_TYPE_MAX_LENGTH = 64;
export const CATALOG_COLUMN_DESCRIPTION_MAX_LENGTH = 4_000;
export const CATALOG_COLUMN_BATCH_MAX = 500;

export class CatalogColumnInputDto {
  /** Plain-text documentation column name (no-DDL). */
  @IsString()
  @MinLength(1)
  @MaxLength(CATALOG_COLUMN_NAME_MAX_LENGTH)
  columnName!: string;

  /** Free-text data type (e.g. `uuid`, `varchar(300)`); omit / null. */
  @IsOptional()
  @IsString()
  @MaxLength(CATALOG_COLUMN_DATA_TYPE_MAX_LENGTH)
  dataType?: string | null;

  /** Documentation nullable flag (gates nothing); defaults to true. */
  @IsOptional()
  @IsBoolean()
  isNullable?: boolean;

  /** Column meaning; omit / null when none. */
  @IsOptional()
  @IsString()
  @MaxLength(CATALOG_COLUMN_DESCRIPTION_MAX_LENGTH)
  descriptionTh?: string | null;

  /** Advisory PDPA PII flag (§17.2 — documentation only); defaults to false. */
  @IsOptional()
  @IsBoolean()
  isPii?: boolean;

  /** Explicit order; when omitted the service uses the array index. */
  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;
}

export class UpsertCatalogColumnsDto {
  /**
   * The full ordered column set for the table. The diff is keyed by
   * `columnName` (the live `(table_id, column_name)` unique pair):
   *   - present in body + existing → UPDATE in place
   *   - present in body + absent   → INSERT
   *   - absent in body + existing  → SOFT-DELETE
   * An empty array soft-deletes every live column (a deliberate "clear
   * the catalog table's columns" action).
   */
  @IsArray()
  @ArrayMaxSize(CATALOG_COLUMN_BATCH_MAX)
  @ValidateNested({ each: true })
  @Type(() => CatalogColumnInputDto)
  columns!: CatalogColumnInputDto[];
}
