import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: CreatePdfSupplementDocumentTables — SUPP_PRINT_DB_01.
 *
 * Creates two new PDF document tables used by the supplement print
 * pipeline (Q2 = default flavor only):
 *
 *   1. `pdf_supplement_draft_documents`     — DRAFT supplement PDFs
 *   2. `pdf_supplement_approved_documents`  — APPROVED supplement PDFs
 *
 * Both tables mirror the existing `pdf_revision_edit_draft_documents`
 * and `pdf_revision_edit_approved_documents` shape byte-for-byte; only
 * the parent-book FK differs (`development_plan_supplement_id` instead
 * of `development_plan_revision_id`).
 *
 * Per task Q4=B, the out-authority (Rejected) variant is intentionally
 * deferred to SUPP_PRINT_WAVE_B.
 *
 * CLAUDE.md compliance:
 *   - §12 audit — these tables hold file metadata only; they never
 *     mutate `tracking_status` rows.
 *   - §17 audit separation / PII — `created_by_id` is the only person
 *     reference; no PII columns. FK to `users.id` ON DELETE RESTRICT
 *     preserves audit trail when a user row is removed.
 *   - §15 book lineage / §18 orphan cleanup — service layer
 *     (SUPP_PRINT_BE_01) owns the cascade; the FK
 *     `development_plan_supplement_id` ON DELETE CASCADE keeps file
 *     metadata in sync with hard-removed parent supplements, matching
 *     the revision analog.
 *
 * Idempotency
 * -----------
 * Every statement uses `CREATE TABLE IF NOT EXISTS` /
 * `CREATE INDEX IF NOT EXISTS` for the `up()` direction and
 * `DROP INDEX IF EXISTS` / `DROP TABLE IF EXISTS` for the `down()`
 * direction. Re-running either direction against a converged shape is
 * a guaranteed no-op.
 *
 * Reversibility
 * -------------
 * `down()` drops the unique constraints, indexes, foreign keys, and
 * tables in strict LIFO order. The FK to `development_plan_supplement`
 * is dropped implicitly by `DROP TABLE`, so an explicit FK drop is not
 * required.
 *
 * Naming
 * ------
 * - Table names mirror the revision analog (singular FK column,
 *   plural table suffix `_documents`).
 * - Unique constraint name: `uq_pdf_supplement_<variant>_documents_supplement_version`.
 * - Composite index name: `ix_pdf_supplement_<variant>_documents_supplement_version_desc`.
 */
export class CreatePdfSupplementDocumentTables1778976000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ------------------------------------------------------------------
    // 1) pdf_supplement_draft_documents
    // ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "pdf_supplement_draft_documents" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "development_plan_supplement_id" uuid NOT NULL,
        "version" integer NOT NULL,
        "file_path" text NOT NULL,
        "project_ids_snapshot" jsonb NOT NULL,
        "project_count" integer NOT NULL,
        "created_by_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_pdf_supplement_draft_documents"
          PRIMARY KEY ("id"),
        CONSTRAINT "uq_pdf_supplement_draft_documents_supplement_version"
          UNIQUE ("development_plan_supplement_id", "version"),
        CONSTRAINT "fk_pdf_supplement_draft_documents_supplement"
          FOREIGN KEY ("development_plan_supplement_id")
          REFERENCES "development_plan_supplement" ("id")
          ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "fk_pdf_supplement_draft_documents_created_by"
          FOREIGN KEY ("created_by_id")
          REFERENCES "users" ("id")
          ON DELETE RESTRICT ON UPDATE CASCADE
      );
    `);

    // Composite index to accelerate `getLatestDraftMeta`-style lookups
    // (DESC by version within the same parent supplement). Matches the
    // revision-edit analog pattern.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_pdf_supplement_draft_documents_supplement_version_desc"
        ON "pdf_supplement_draft_documents"
           ("development_plan_supplement_id", "version" DESC);
    `);

    // ------------------------------------------------------------------
    // 2) pdf_supplement_approved_documents
    // ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "pdf_supplement_approved_documents" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "development_plan_supplement_id" uuid NOT NULL,
        "version" integer NOT NULL,
        "file_path" text NOT NULL,
        "project_ids_snapshot" jsonb NOT NULL,
        "project_count" integer NOT NULL,
        "created_by_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_pdf_supplement_approved_documents"
          PRIMARY KEY ("id"),
        CONSTRAINT "uq_pdf_supplement_approved_documents_supplement_version"
          UNIQUE ("development_plan_supplement_id", "version"),
        CONSTRAINT "fk_pdf_supplement_approved_documents_supplement"
          FOREIGN KEY ("development_plan_supplement_id")
          REFERENCES "development_plan_supplement" ("id")
          ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "fk_pdf_supplement_approved_documents_created_by"
          FOREIGN KEY ("created_by_id")
          REFERENCES "users" ("id")
          ON DELETE RESTRICT ON UPDATE CASCADE
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_pdf_supplement_approved_documents_supplement_version_desc"
        ON "pdf_supplement_approved_documents"
           ("development_plan_supplement_id", "version" DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // LIFO — approved first, then draft. Indexes dropped before tables
    // for clarity (DROP TABLE would cascade them anyway, but the
    // explicit drop matches the up() naming exactly and survives a
    // partial-apply state).

    // 2') pdf_supplement_approved_documents
    await queryRunner.query(`
      DROP INDEX IF EXISTS
        "ix_pdf_supplement_approved_documents_supplement_version_desc";
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "pdf_supplement_approved_documents";
    `);

    // 1') pdf_supplement_draft_documents
    await queryRunner.query(`
      DROP INDEX IF EXISTS
        "ix_pdf_supplement_draft_documents_supplement_version_desc";
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "pdf_supplement_draft_documents";
    `);
  }
}
