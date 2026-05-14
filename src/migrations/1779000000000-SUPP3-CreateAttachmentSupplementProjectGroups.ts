import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: SUPP-3 / BE-07 — CreateAttachmentSupplementProjectGroups
 *
 * Creates the `attachment_supplement_project_groups` table that backs
 * the new `AttachmentSupplementProjectGroup` entity. Mirrors the
 * `attachment_project_groups` / `attachment_revised_project_groups`
 * column set verbatim so the three attachment surfaces stay in
 * structural lockstep.
 *
 * Why a NEW table instead of polymorphic JOIN
 * -------------------------------------------
 * User-confirmed default (2026-05-12): mirror the PG / RPG split. The
 * benefits:
 *   - clean FK to `supplement_project_groups(id)`, no polymorphic
 *     discriminator column
 *   - separate index pressure per project kind
 *   - no risk of cross-kind id collisions
 *
 * §12 audit interaction
 * ---------------------
 * FK uses `ON DELETE RESTRICT` on `supplement_project_group_id`.
 * Supplement-level cleanup (§16 of `workflow-add-project-supplement.md`)
 * is soft-delete + tombstone audit row; we do NOT want a soft-delete
 * cascade hard-dropping attachment metadata. RESTRICT keeps the
 * attachment row queryable for forensic review even after the SPG row
 * is soft-deleted.
 *
 * §17.4 AI baseline interaction
 * -----------------------------
 * Attachment rows feed the SPG `content_hash` for the `no-ai-baseline`
 * snapshot via the existing pipeline. The snapshot is `snapshot-only`
 * (§17.4) so adding rows here does NOT auto-recompute or flip
 * `isStale` to true.
 *
 * AI analysis columns
 * -------------------
 * Mirrored from the PG / RPG tables for forward-compat — they remain
 * null until `DocumentAnalysisService` is widened to accept the
 * `'supplement-project-group'` kind. See
 * `TODO(SUPP-3-later)` in the service.
 *
 * Rollback safety
 * ---------------
 * Down migration drops the partial index first, then the table. No
 * data loss risk on rollback in this wave because no production rows
 * have landed yet (Wave SUPP-1 just shipped per task spec).
 */
export class SUPP3CreateAttachmentSupplementProjectGroups1779000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "attachment_supplement_project_groups" (
        "id"                          UUID         NOT NULL DEFAULT uuid_generate_v4(),
        "filename"                    VARCHAR      NOT NULL,
        "originalName"                VARCHAR      NOT NULL,
        "mimetype"                    VARCHAR      NOT NULL,
        "size"                        INTEGER      NOT NULL,
        "path"                        VARCHAR      NOT NULL,
        "supplement_project_group_id" UUID         NOT NULL,
        "ai_topic"                    VARCHAR(100) DEFAULT NULL,
        "ai_summary"                  VARCHAR(800) DEFAULT NULL,
        "ai_doc_type"                 VARCHAR(32)  DEFAULT NULL,
        "ai_status"                   VARCHAR(16)  DEFAULT 'pending',
        "ai_processed_at"             TIMESTAMP    DEFAULT NULL,
        "ai_model"                    VARCHAR(32)  DEFAULT NULL,
        "ai_extraction_quality_score" NUMERIC(4,3) DEFAULT NULL,
        "created_at"                  TIMESTAMP    NOT NULL DEFAULT now(),
        "deleted_at"                  TIMESTAMP    DEFAULT NULL,
        CONSTRAINT "PK_attachment_supplement_project_groups"
          PRIMARY KEY ("id"),
        CONSTRAINT "FK_attachment_supplement_project_groups_spg"
          FOREIGN KEY ("supplement_project_group_id")
          REFERENCES "supplement_project_groups"("id")
          ON UPDATE CASCADE
          ON DELETE RESTRICT
      );
    `);

    // Index on FK — used by the "list attachments for SPG" query.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_attachment_spg_supplement_project_group_id"
        ON "attachment_supplement_project_groups" ("supplement_project_group_id")
        WHERE "deleted_at" IS NULL;
    `);

    // Partial index on ai_status — mirrors the PG / RPG backlog scan
    // index from migration 1744934400000.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_ai_status_aspg"
        ON "attachment_supplement_project_groups" ("ai_status")
        WHERE "deleted_at" IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // LIFO order — indexes first, then table.
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_ai_status_aspg";`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_attachment_spg_supplement_project_group_id";`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "attachment_supplement_project_groups";`,
    );
  }
}
