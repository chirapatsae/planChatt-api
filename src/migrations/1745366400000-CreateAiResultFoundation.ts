import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: CreateAiResultFoundation
 *
 * Establishes the shared staleness-model foundation enums that every
 * downstream `ai_*` result table (RF2 diff-aware smart-approve, RF5
 * persisted pre-submit snapshot, and every future AI-assisted feature)
 * will reuse.
 *
 * CLAUDE.md references:
 *   - §17.3 audit separation (ai_* tables carry no FK to project tables)
 *   - §17.4 staleness model (strict | snapshot-only | warning-only)
 *   - §17.10 UI score display (band)
 *   - task file §8 Database Requirements
 *
 * Creates three ENUM types in PostgreSQL:
 *
 *   1. `ai_score_band`        (green | amber | red)
 *      Interpretation band attached to every numeric AI score.
 *
 *   2. `ai_target_kind`       (project-group | revised-project-group |
 *                              supplement-project-group)
 *      Discriminator for `(target_id, target_kind)` without FK, per
 *      §17.3. Includes `supplement-project-group` so future supplement-
 *      lineage AI results reuse the same enum.
 *
 *   3. `ai_staleness_policy`  (strict | snapshot-only | warning-only)
 *      Per-result policy driving `isStale` semantics in the envelope.
 *
 * Scope:
 *   - NO row-level table is created here. RF2 and RF5 each own their
 *     concrete table and add their own `(target_id, target_kind,
 *     content_hash)` composite index.
 *   - MUST NOT touch `tracking_status`, `project_groups`,
 *     `revised_project_groups`, `supplement_project_groups`,
 *     `development_plans`, `development_plan_revisions`, or
 *     `development_plan_supplements`.
 *
 * Rollback safety:
 *   - Down migration drops the three enum types in strict LIFO order.
 *   - `DROP TYPE IF EXISTS` is safe even if downstream tables have
 *     already dropped their references; but to be explicit, the down
 *     migration refuses to drop the enum if any dependent table still
 *     references it (PostgreSQL will raise — the operator then removes
 *     the child table first).
 *   - Idempotent up migration via `CREATE TYPE IF NOT EXISTS` equivalent
 *     (PostgreSQL lacks a native form, so a `DO` block is used).
 */
export class CreateAiResultFoundation1745366400000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ai_score_band — interpretation band for AI scores (§17.10).
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type WHERE typname = 'ai_score_band'
        ) THEN
          CREATE TYPE "ai_score_band" AS ENUM ('green', 'amber', 'red');
        END IF;
      END
      $$;
    `);

    // ai_target_kind — (§17.3) target discriminator without referential
    // integrity. Covers the three project-owning table flavors.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type WHERE typname = 'ai_target_kind'
        ) THEN
          CREATE TYPE "ai_target_kind" AS ENUM (
            'project-group',
            'revised-project-group',
            'supplement-project-group'
          );
        END IF;
      END
      $$;
    `);

    // ai_staleness_policy — per-result policy (§17.4).
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type WHERE typname = 'ai_staleness_policy'
        ) THEN
          CREATE TYPE "ai_staleness_policy" AS ENUM (
            'strict',
            'snapshot-only',
            'warning-only'
          );
        END IF;
      END
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Strict LIFO reversal. DROP TYPE is rejected by PostgreSQL when any
    // column still references the enum; operator must remove dependent
    // tables first (per task file §11 operator contract).
    await queryRunner.query(
      `DROP TYPE IF EXISTS "ai_staleness_policy";`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "ai_target_kind";`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "ai_score_band";`,
    );
  }
}
