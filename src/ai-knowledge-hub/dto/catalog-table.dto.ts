import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Wave wave-ai-knowledge-structure-mgmt — BE-03 (Phase 2, 2026-06-13).
 *
 * Request bodies for the Class-A DATA-CATALOG tables (topic iii — report
 * §2(iii) / §3.3). A catalog table is a `ai_knowledge_catalog_tables` row —
 * an admin-curated DOCUMENTATION entry describing a table, NOT the real
 * Postgres schema. Admin + super-admin only (Q-03; enforced at the
 * controller via `@Roles(...ADMIN_OR_ABOVE)`).
 *
 * NO-DDL GUARANTEE (CTO decision #2 / report §6.3 — ABSOLUTE): `tableName`
 * is PLAIN TEXT. It is never an SQL identifier, never concatenated into a
 * query, and never feeds any `CREATE` / `ALTER` / `DROP` / raw DDL. Typing
 * a `tableName` here = picking / writing an entry in the documentation
 * catalog only.
 *
 * Column-width caps mirror `ai_knowledge_catalog_tables` (DB-01 §3.3):
 *   - tableName     ≤ 128  (varchar(128))
 *   - displayNameTh ≤ 200  (varchar(200))
 *   - descriptionTh ≤ 4,000 (text — a generous UI cap, belt-and-braces)
 *   - domainKey     ≤ 128  (varchar(128) — plain text, NOT a DB FK)
 */
export const CATALOG_TABLE_NAME_MAX_LENGTH = 128;
export const CATALOG_TABLE_DISPLAY_NAME_MAX_LENGTH = 200;
export const CATALOG_TABLE_DESCRIPTION_MAX_LENGTH = 4_000;
export const CATALOG_DOMAIN_KEY_MAX_LENGTH = 128;

export class CreateCatalogTableDto {
  /**
   * Plain-text documentation table name. NEVER an SQL identifier (no-DDL).
   * Uniqueness against live (non-soft-deleted) rows is enforced at the
   * service layer (`409 CATALOG_TABLE_NAME_DUPLICATE`).
   */
  @IsString()
  @MinLength(1)
  @MaxLength(CATALOG_TABLE_NAME_MAX_LENGTH)
  tableName!: string;

  /** Thai display name. */
  @IsString()
  @MinLength(1)
  @MaxLength(CATALOG_TABLE_DISPLAY_NAME_MAX_LENGTH)
  displayNameTh!: string;

  /** Free-text description; omit / null when none. */
  @IsOptional()
  @IsString()
  @MaxLength(CATALOG_TABLE_DESCRIPTION_MAX_LENGTH)
  descriptionTh?: string | null;

  /**
   * Domain this catalog table belongs to (`derived-domain-map.ts` key).
   * Plain text — NOT a DB FK (§17.14.3); not validated against the
   * registry (a catalog table may document a not-yet-mapped area).
   */
  @IsOptional()
  @IsString()
  @MaxLength(CATALOG_DOMAIN_KEY_MAX_LENGTH)
  domainKey?: string | null;

  /** Position on the catalog board (≥ 0); defaults to 0. */
  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;
}

export class UpdateCatalogTableDto {
  /**
   * Rename the documentation entry; omit to keep unchanged. Still plain
   * text (no-DDL). A rename collision with a live row →
   * `409 CATALOG_TABLE_NAME_DUPLICATE`.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(CATALOG_TABLE_NAME_MAX_LENGTH)
  tableName?: string;

  /** Edit display name; omit to keep unchanged. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(CATALOG_TABLE_DISPLAY_NAME_MAX_LENGTH)
  displayNameTh?: string;

  /** Edit description; omit to keep, `null` to clear. */
  @IsOptional()
  @IsString()
  @MaxLength(CATALOG_TABLE_DESCRIPTION_MAX_LENGTH)
  descriptionTh?: string | null;

  /** Re-assign the domain (plain text); omit to keep, `null` to clear. */
  @IsOptional()
  @IsString()
  @MaxLength(CATALOG_DOMAIN_KEY_MAX_LENGTH)
  domainKey?: string | null;

  /** Re-position the catalog card (≥ 0). */
  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;
}
