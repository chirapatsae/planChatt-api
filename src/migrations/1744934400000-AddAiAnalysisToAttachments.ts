import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddAiAnalysisToAttachments
 *
 * Adds six AI-analysis columns + one partial index to BOTH attachment tables:
 *   - attachment_project_groups
 *   - attachment_revised_project_groups
 *
 * Columns added (same on both tables):
 *   1. ai_topic         VARCHAR(100), nullable
 *   2. ai_summary       VARCHAR(800), nullable
 *   3. ai_doc_type      VARCHAR(32),  nullable
 *   4. ai_status        VARCHAR(16),  default 'pending'
 *   5. ai_processed_at  TIMESTAMP,    nullable
 *   6. ai_model         VARCHAR(32),  nullable
 *
 * Partial indexes (query the backlog of rows needing analysis):
 *   idx_ai_status_apg   ON attachment_project_groups(ai_status)         WHERE deleted_at IS NULL
 *   idx_ai_status_arpg  ON attachment_revised_project_groups(ai_status) WHERE deleted_at IS NULL
 *
 * Rationale (task contract section 8):
 *   - Existing rows (pre-migration) implicitly acquire `ai_status='pending'`
 *     through the column DEFAULT. They will never be upgraded by this
 *     migration; a separate admin backfill (out of scope) handles that.
 *   - Partial index on `deleted_at IS NULL` mirrors the §14 soft-delete
 *     convention; soft-deleted rows do not participate in lineage or
 *     analysis queues.
 *   - Columns are all nullable (except ai_status which has a default) so
 *     the migration is zero-downtime safe.
 *   - §13 / §14 / §16.5 are untouched: AI analysis writes only to these
 *     six meta-columns; they do not participate in lineage resolution
 *     or classification shape invariants.
 *
 * Rollback safety:
 *   - Down migration drops indexes first, then columns (LIFO order).
 *   - No data loss risk on down -- columns contain derived AI output only.
 */
export class AddAiAnalysisToAttachments1744934400000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------- attachment_project_groups ----------
    await queryRunner.query(`
      ALTER TABLE "attachment_project_groups"
        ADD COLUMN IF NOT EXISTS "ai_topic"        VARCHAR(100) DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS "ai_summary"      VARCHAR(800) DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS "ai_doc_type"     VARCHAR(32)  DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS "ai_status"       VARCHAR(16)  DEFAULT 'pending',
        ADD COLUMN IF NOT EXISTS "ai_processed_at" TIMESTAMP    DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS "ai_model"        VARCHAR(32)  DEFAULT NULL;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_ai_status_apg"
        ON "attachment_project_groups" ("ai_status")
        WHERE "deleted_at" IS NULL;
    `);

    // ---------- attachment_revised_project_groups ----------
    await queryRunner.query(`
      ALTER TABLE "attachment_revised_project_groups"
        ADD COLUMN IF NOT EXISTS "ai_topic"        VARCHAR(100) DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS "ai_summary"      VARCHAR(800) DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS "ai_doc_type"     VARCHAR(32)  DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS "ai_status"       VARCHAR(16)  DEFAULT 'pending',
        ADD COLUMN IF NOT EXISTS "ai_processed_at" TIMESTAMP    DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS "ai_model"        VARCHAR(32)  DEFAULT NULL;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_ai_status_arpg"
        ON "attachment_revised_project_groups" ("ai_status")
        WHERE "deleted_at" IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop indexes first, then columns (LIFO).
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_ai_status_arpg";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_ai_status_apg";`);

    await queryRunner.query(`
      ALTER TABLE "attachment_revised_project_groups"
        DROP COLUMN IF EXISTS "ai_model",
        DROP COLUMN IF EXISTS "ai_processed_at",
        DROP COLUMN IF EXISTS "ai_status",
        DROP COLUMN IF EXISTS "ai_doc_type",
        DROP COLUMN IF EXISTS "ai_summary",
        DROP COLUMN IF EXISTS "ai_topic";
    `);

    await queryRunner.query(`
      ALTER TABLE "attachment_project_groups"
        DROP COLUMN IF EXISTS "ai_model",
        DROP COLUMN IF EXISTS "ai_processed_at",
        DROP COLUMN IF EXISTS "ai_status",
        DROP COLUMN IF EXISTS "ai_doc_type",
        DROP COLUMN IF EXISTS "ai_summary",
        DROP COLUMN IF EXISTS "ai_topic";
    `);
  }
}
