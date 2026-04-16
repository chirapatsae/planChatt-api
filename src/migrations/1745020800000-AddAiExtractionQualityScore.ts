import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddAiExtractionQualityScore (Phase 4 §T0)
 *
 * Adds a single nullable column to BOTH attachment tables so the
 * DocumentAnalysisService can persist a deterministic 0.000–1.000
 * extraction-quality score computed from the OCR/DOCX/PDF output
 * BEFORE the OpenAI call is fired.
 *
 * Columns added (same on both tables):
 *   ai_extraction_quality_score NUMERIC(4,3) NULL
 *
 * Rationale:
 *   - Score is written on both success (status='done') and failure
 *     (status='failed' / 'unsupported') paths so staff can diagnose
 *     which rows were rejected by §T1 hard-guard vs §T2 AI validation.
 *   - NUMERIC(4,3) admits 0.000…9.999 — safe headroom for a score
 *     spec of 0..1 inclusive.
 *   - Nullable: pre-Phase-4 rows have no score; UI must treat null
 *     as "not computed" and NOT as "low".
 *   - No index: quality is rarely a primary filter and the volume of
 *     attachment rows is moderate. The existing Phase-3 partial index
 *     on ai_status + deleted_at IS NULL covers the backfill scan.
 *
 * CLAUDE.md interactions:
 *   - §13 advisory: derived metadata, never blocks workflow.
 *   - §14 lineage lock: meta column; writes do not classify as
 *     user-driven project mutation.
 *   - §16.5 classification shape: orthogonal (project tables untouched).
 */
export class AddAiExtractionQualityScore1745020800000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "attachment_project_groups"
        ADD COLUMN IF NOT EXISTS "ai_extraction_quality_score" NUMERIC(4,3) DEFAULT NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE "attachment_revised_project_groups"
        ADD COLUMN IF NOT EXISTS "ai_extraction_quality_score" NUMERIC(4,3) DEFAULT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "attachment_revised_project_groups"
        DROP COLUMN IF EXISTS "ai_extraction_quality_score";
    `);
    await queryRunner.query(`
      ALTER TABLE "attachment_project_groups"
        DROP COLUMN IF EXISTS "ai_extraction_quality_score";
    `);
  }
}
