import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wave Equipment Revision Management — attachment support for RELPG.
 *
 * Creates `attachment_revised_equipment_project_groups`, the equipment
 * (ผ.03) analog of `attachment_revised_project_groups`. Structural clone of
 * the RPG attachment table (same file-metadata + AI-metadata column set) so
 * the attachment surfaces stay in lockstep. FK → `revised_equipment_project_groups(id)`.
 *
 * FK delete behaviour mirrors the RPG attachment entity (`onDelete: CASCADE`)
 * — the RELPG fork itself is soft-deleted in the §18 cascade, so a hard
 * delete of an RELPG row (e.g. staff-led rollback §14.6) should clean its
 * attachment rows alongside it, identical to RPG.
 *
 * # Idempotency
 * `CREATE TABLE IF NOT EXISTS` tolerates a `synchronize:true` pre-creation
 * of the table on boot (per MEMORY: typeorm synchronize). This migration is
 * for production safety + documentation.
 *
 * # AI analysis columns
 * Mirrored from the PG / RPG / SPG attachment tables for STRUCTURAL parity.
 * They remain null on equipment — `DocumentAnalysisService` is NOT wired for
 * an equipment kind (its `AttachmentKind` union is closed). Equipment AI
 * document-analysis is out of scope this wave (§5.3 Phase 3 deferral).
 *
 * Sibling pattern: `1779000000000-SUPP3-CreateAttachmentSupplementProjectGroups.ts`.
 */
export class CreateAttachmentRevisedEquipmentProjectGroups1782600000000
  implements MigrationInterface
{
  name = 'CreateAttachmentRevisedEquipmentProjectGroups1782600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "attachment_revised_equipment_project_groups" (
        "id"                                   UUID         NOT NULL DEFAULT gen_random_uuid(),
        "filename"                             VARCHAR      NOT NULL,
        "originalName"                         VARCHAR      NOT NULL,
        "mimetype"                             VARCHAR      NOT NULL,
        "size"                                 INTEGER      NOT NULL,
        "path"                                 VARCHAR      NOT NULL,
        "revised_equipment_project_group_id"   UUID         NOT NULL,
        "ai_topic"                             VARCHAR(100) DEFAULT NULL,
        "ai_summary"                           VARCHAR(800) DEFAULT NULL,
        "ai_doc_type"                          VARCHAR(32)  DEFAULT NULL,
        "ai_status"                            VARCHAR(16)  DEFAULT 'pending',
        "ai_processed_at"                      TIMESTAMP    DEFAULT NULL,
        "ai_model"                             VARCHAR(32)  DEFAULT NULL,
        "ai_extraction_quality_score"          NUMERIC(4,3) DEFAULT NULL,
        "created_at"                           TIMESTAMP    NOT NULL DEFAULT now(),
        "deleted_at"                           TIMESTAMP    DEFAULT NULL,
        CONSTRAINT "PK_attachment_revised_equipment_project_groups"
          PRIMARY KEY ("id"),
        CONSTRAINT "FK_attachment_revised_equipment_project_groups_relpg"
          FOREIGN KEY ("revised_equipment_project_group_id")
          REFERENCES "revised_equipment_project_groups"("id")
          ON UPDATE CASCADE
          ON DELETE CASCADE
      );
    `);

    // Index on FK — used by the "list attachments for RELPG" query.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_attachment_relpg_revised_equipment_project_group_id"
        ON "attachment_revised_equipment_project_groups" ("revised_equipment_project_group_id")
        WHERE "deleted_at" IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_attachment_relpg_revised_equipment_project_group_id";`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "attachment_revised_equipment_project_groups";`,
    );
  }
}
