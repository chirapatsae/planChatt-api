import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: SupplementEquipmentAiWidenTargetKind — Wave
 * wave-supplement-equipment-por03, BE-B1 (2026-06-08).
 *
 * Adds the value `'supplement-equipment-project-group'` to the shared
 * Postgres enum `ai_target_kind` (created by
 * `1745366400000-CreateAiResultFoundation`). The new value lets
 * `ai_pre_submit_snapshots` discriminate SEPG
 * (SupplementEquipmentProjectGroup — ครุภัณฑ์ ผ.03 under เล่มเพิ่มเติม)
 * rows written by the §17.4 `no-ai-baseline` trigger in
 * `SupplementEquipmentProjectGroupService.create` (publish: Ready →
 * Pending).
 *
 * Why a dedicated migration alongside the bootstrap-migration entry
 * ----------------------------------------------------------------
 * `synchronize: true` does NOT execute migration files — it only
 * reconciles entity column metadata against the DB, and Postgres enums
 * are NEVER mutated by synchronize. To converge every environment we
 * ship the change in TWO idempotent places:
 *
 *   1. This migration — `typeorm migration:run` on prod / staging.
 *   2. `BootstrapMigrationsService` — runs on every app boot for dev
 *      boxes that never invoke the migration runner.
 *
 * `IF NOT EXISTS` makes either path a no-op once the other has run.
 *
 * Mirrors `1782400000000-RevisedEquipmentAiWidenTargetKind.ts` and
 * `1781000000000-EquipmentAiWidenTargetKind.ts` byte-for-spirit.
 *
 * Postgres caveat — non-transactional ALTER TYPE: requires
 * `ALTER TYPE … ADD VALUE` to run OUTSIDE a transaction block, so we
 * commit first, run the ALTER, then re-open so the migration tracking
 * row write still lands inside a tx.
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
export class SupplementEquipmentAiWidenTargetKind1782900000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.commitTransaction();
    try {
      await queryRunner.query(
        `ALTER TYPE "ai_target_kind" ADD VALUE IF NOT EXISTS 'supplement-equipment-project-group';`,
      );
    } finally {
      await queryRunner.startTransaction();
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Intentionally a no-op. See class-level comment for rationale.
  }
}
