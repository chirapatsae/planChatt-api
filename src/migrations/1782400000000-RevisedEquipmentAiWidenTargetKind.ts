import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: RevisedEquipmentAiWidenTargetKind — Wave Equipment Revision
 * Management, BE-01 (Phase 3).
 *
 * Adds the value `'revised-equipment-project-group'` to the shared
 * Postgres enum `ai_target_kind` (created by
 * `1745366400000-CreateAiResultFoundation`). The new value lets
 * `ai_pre_submit_snapshots` discriminate RELPG
 * (RevisedEquipmentProjectGroup) rows written by the §17.4
 * `no-ai-baseline` trigger in `RevisedEquipmentProjectGroupService`
 * (submit: Ready → Pending).
 *
 * Why a dedicated migration alongside the bootstrap-migration entry
 * ----------------------------------------------------------------
 * The project memory file (`project_typeorm_synchronize.md`) records that
 * `synchronize: true` does NOT execute migration files — it only
 * reconciles entity column metadata against the DB. Postgres enums are
 * NEVER mutated by synchronize. To converge every environment we ship the
 * change in TWO idempotent places:
 *
 *   1. This migration — `typeorm migration:run` on prod / staging.
 *   2. `BootstrapMigrationsService` — runs on every app boot for dev
 *      boxes that never invoke the migration runner.
 *
 * `IF NOT EXISTS` makes either path a no-op once the other has run.
 *
 * Mirrors `1781000000000-EquipmentAiWidenTargetKind.ts` and
 * `1780000000000-SuppAiWidenTargetKind.ts` byte-for-spirit.
 *
 * Postgres caveat — non-transactional ALTER TYPE
 * ----------------------------------------------
 * Postgres requires `ALTER TYPE … ADD VALUE` to run OUTSIDE a transaction
 * block. TypeORM wraps `up()` in a transaction by default, so we commit
 * first, run the ALTER, then re-open so the migration tracking-row write
 * still lands inside a tx.
 *
 * Down migration — forward-only (Postgres cannot drop an enum value
 * without rewriting the type and rebinding every dependent column). The
 * added value is harmless when unused.
 *
 * CLAUDE.md references:
 *   - §17.3 Audit separation — `ai_*` rows reference projects by
 *     `(target_id, target_kind)` without FK. This migration only widens
 *     the discriminator; no FK introduced.
 *   - §17.4 Staleness model preserved — no read-side semantic change.
 *   - §17.11 No role exemption — schema-level integrity.
 */
export class RevisedEquipmentAiWidenTargetKind1782400000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.commitTransaction();
    try {
      await queryRunner.query(
        `ALTER TYPE "ai_target_kind" ADD VALUE IF NOT EXISTS 'revised-equipment-project-group';`,
      );
    } finally {
      await queryRunner.startTransaction();
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Intentionally a no-op. See class-level comment for rationale.
  }
}
