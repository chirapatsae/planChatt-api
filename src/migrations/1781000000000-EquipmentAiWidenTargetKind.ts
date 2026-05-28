import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: EquipmentAiWidenTargetKind — Wave Equipment ผ.03 Phase 2,
 * BE-06 (2026-05-28).
 *
 * Adds the value `'equipment-project-group'` to the shared Postgres enum
 * `ai_target_kind` (created by
 * `1745366400000-CreateAiResultFoundation`). The new value lets
 * `ai_pre_submit_snapshots` (and any future `ai_*` result table that
 * reuses the same enum) discriminate equipment items written by the
 * §17.4 `no-ai-baseline` trigger in `EquipmentProjectGroupService.create`.
 *
 * Why a dedicated migration alongside the bootstrap-migration entry
 * ----------------------------------------------------------------
 * The project memory file (`project_typeorm_synchronize.md`) records
 * that `synchronize: true` does NOT execute migration files — it only
 * reconciles entity column metadata against the DB. Postgres enums in
 * particular are NEVER mutated by synchronize.
 *
 * To converge every environment we ship the change in TWO places, both
 * idempotent:
 *
 *   1. This migration — runs via `typeorm migration:run` on production /
 *      staging (the canonical migration trail).
 *   2. `BootstrapMigrationsService` entry — runs on every app boot for
 *      dev boxes that never invoke the migration runner. Same
 *      `ALTER TYPE ... ADD VALUE IF NOT EXISTS` statement.
 *
 * On any environment where one path has already widened the enum, the
 * other path is a no-op thanks to `IF NOT EXISTS` (Postgres ≥ 12).
 *
 * Mirrors `1780000000000-SuppAiWidenTargetKind.ts` byte-for-spirit;
 * documentation cross-references that migration for additional context.
 *
 * Postgres caveat — non-transactional ALTER TYPE
 * ----------------------------------------------
 * Postgres requires `ALTER TYPE … ADD VALUE` to run OUTSIDE a
 * transaction block. TypeORM's migration runner wraps `up()` in a
 * transaction by default, so we commit it first, run the ALTER, then
 * re-open so the migration tracking row write still lands inside a tx.
 *
 * Down migration
 * --------------
 * Postgres does NOT support removing a value from an enum without
 * rewriting the type and rebinding every dependent column. The added
 * value is harmless when unused. Forward-only — matches the SUPP
 * predecessor.
 *
 * CLAUDE.md references:
 *   - §17.3 Audit separation — `ai_*` tables continue to reference
 *     projects by `(target_id, target_kind)` without FK. This migration
 *     only widens the discriminator; no FK is introduced.
 *   - §17.4 Staleness model preserved — no change to `staleness_policy`
 *     or any read-side semantics.
 *   - §17.11 No role exemption — schema-level integrity, unreachable
 *     from any request context.
 */
export class EquipmentAiWidenTargetKind1781000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.commitTransaction();
    try {
      await queryRunner.query(
        `ALTER TYPE "ai_target_kind" ADD VALUE IF NOT EXISTS 'equipment-project-group';`,
      );
    } finally {
      await queryRunner.startTransaction();
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Intentionally a no-op. See class-level comment for rationale and
    // the destructive rebuild sequence required for a true rollback.
  }
}
