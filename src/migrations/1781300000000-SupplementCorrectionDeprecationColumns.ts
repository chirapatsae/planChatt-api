import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: SupplementCorrectionDeprecationColumns
 *
 * Wave wave-supplement-correction-workflow DB-01 (2026-05-25).
 *
 * Adds correction + deprecation columns to the supplement-assembly
 * tables so BE-01 can ship the correction workflow (parity with
 * main-plan `book_assembly_*` correction). All new columns are
 * NULL-able; pre-existing Wave-A rows are unaffected.
 *
 * Schema deltas:
 *
 *   supplement_assembly_versions:
 *     - correction_mode    "supplement_assembly_correction_mode" NULL
 *     - correction_reason  TEXT                                   NULL
 *     - deprecated_at      TIMESTAMPTZ                            NULL
 *     - deprecated_by_id   UUID                                   NULL
 *     - deprecation_reason TEXT                                   NULL
 *
 *   supplement_assembly_drafts:
 *     - target_version       INT                                  NULL
 *     - previous_version_id  UUID                                 NULL
 *           FK -> supplement_assembly_versions(id) ON DELETE RESTRICT
 *     - correction_mode      "supplement_assembly_correction_mode" NULL
 *     - correction_reason    TEXT                                 NULL
 *
 *   supplement_assembly_version_status enum:
 *     + 'deprecated'   (added via ALTER TYPE ADD VALUE IF NOT EXISTS)
 *
 *   supplement_assembly_correction_mode enum (NEW):
 *     ('correction_part1','correction_part2','correction_part3')
 *
 * Critical invariants preserved:
 *
 *   - CLAUDE.md §15 — additive-only schema change. All new columns
 *     NULL-able so pre-existing version + draft rows are not rewritten;
 *     finalize / cancel / softRemove paths are unaffected.
 *
 *   - CLAUDE.md §17.3 — no FK from any `ai_*` table is added. The new
 *     `previous_version_id` FK targets `supplement_assembly_versions`,
 *     which is a book-assembly artifact, not a project table — §17.3
 *     "no FK from ai_* into project tables" does not apply.
 *
 *   - CLAUDE.md §18 / §18.2.1 SUPPLEMENT finalize trigger — the orphan
 *     cleanup cascade contract is untouched. None of the new columns
 *     feed the cascade; the cascade still keys off
 *     `DevelopmentPlanSupplement` softRemove + the
 *     `SupplementAssemblyService.merge` finalize trigger.
 *
 *   - Q3=B duplicate-enum policy — the new pg enum
 *     `supplement_assembly_correction_mode` is a SEPARATE type from
 *     `book_assembly_correction_mode`. Do NOT consolidate.
 *
 *   - Q4=C deferral resolved — the `deprecated` value is added to
 *     `supplement_assembly_version_status` (previously `completed`
 *     only).
 *
 *   - Idempotency — every DDL is wrapped in `IF NOT EXISTS` /
 *     `ADD COLUMN IF NOT EXISTS` / `ADD VALUE IF NOT EXISTS` so the
 *     migration can be re-run safely.
 *
 * Reversibility:
 *
 *   - down() drops every added column in reverse order.
 *   - down() drops the new `supplement_assembly_correction_mode` enum
 *     via `DROP TYPE IF EXISTS` after its dependent columns are gone.
 *   - down() does NOT remove the `deprecated` value from
 *     `supplement_assembly_version_status`. Pg does not support
 *     `ALTER TYPE ... DROP VALUE`. The safe swap-type pattern (CREATE
 *     new type → ALTER COLUMN → DROP old → RENAME) is intentionally
 *     NOT executed because: (1) any version row whose `status =
 *     'deprecated'` would block the ALTER COLUMN cast; (2) leaving the
 *     value present is harmless — no code path will produce it without
 *     the application-level enum agreeing, which is reverted via the
 *     entity rollback; (3) the swap-type pattern is the wave's
 *     well-known "if needed" fallback per task §11 and is documented
 *     here for future operators who need a clean enum surface.
 *     Operators that need a fully-clean down MUST first ensure no row
 *     carries `status = 'deprecated'`, then run the swap-type pattern
 *     manually. See task DB-01 §11.
 *
 * Backend interaction:
 *
 *   - `synchronize: true` is enabled at `app.module.ts:434`. `ADD
 *     COLUMN IF NOT EXISTS` on a NULL-able column will auto-apply on
 *     next backend restart even without the migration runner, BUT
 *     synchronize is unreliable for pg enum value additions and for
 *     creating new pg enum types. The migration MUST be run explicitly
 *     to land the `deprecated` enum value and the
 *     `supplement_assembly_correction_mode` type before BE-01 reads /
 *     writes them. See QA-01 notes.
 */
export class SupplementCorrectionDeprecationColumns1781300000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. New pg enum type for supplement correction mode. Separate from
    //    `book_assembly_correction_mode` per Q3=B. `CANCELLATION` is
    //    intentionally absent — supplement cancel uses the existing
    //    `/cancel` endpoint, not the correction workflow.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type
           WHERE typname = 'supplement_assembly_correction_mode'
        ) THEN
          CREATE TYPE "supplement_assembly_correction_mode" AS ENUM (
            'correction_part1', 'correction_part2', 'correction_part3'
          );
        END IF;
      END$$;
    `);

    // 2. Extend `supplement_assembly_version_status` with `deprecated`.
    //    `ALTER TYPE ... ADD VALUE IF NOT EXISTS` is idempotent and
    //    runs outside an explicit BEGIN/COMMIT in modern pg. TypeORM
    //    runs each `query()` in its own implicit transaction unless
    //    the runner is started transactionally — the migration runner
    //    handles this correctly for ADD VALUE.
    await queryRunner.query(`
      ALTER TYPE "supplement_assembly_version_status"
        ADD VALUE IF NOT EXISTS 'deprecated';
    `);

    // 3. Add correction + deprecation columns to
    //    `supplement_assembly_versions`. All NULL.
    await queryRunner.query(`
      ALTER TABLE "supplement_assembly_versions"
        ADD COLUMN IF NOT EXISTS "correction_mode"
          "supplement_assembly_correction_mode" NULL,
        ADD COLUMN IF NOT EXISTS "correction_reason" TEXT NULL,
        ADD COLUMN IF NOT EXISTS "deprecated_at"     TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS "deprecated_by_id"  UUID NULL,
        ADD COLUMN IF NOT EXISTS "deprecation_reason" TEXT NULL;
    `);

    // 4. Add correction-lineage columns to
    //    `supplement_assembly_drafts`. All NULL.
    await queryRunner.query(`
      ALTER TABLE "supplement_assembly_drafts"
        ADD COLUMN IF NOT EXISTS "target_version"      INT NULL,
        ADD COLUMN IF NOT EXISTS "previous_version_id" UUID NULL,
        ADD COLUMN IF NOT EXISTS "correction_mode"
          "supplement_assembly_correction_mode" NULL,
        ADD COLUMN IF NOT EXISTS "correction_reason"   TEXT NULL;
    `);

    // 5. FK on `previous_version_id` -> `supplement_assembly_versions`.
    //    `ON DELETE RESTRICT` preserves the correction audit chain —
    //    a version row that is referenced by an in-flight correction
    //    draft cannot be hard-deleted. Soft-delete semantics on the
    //    version side are handled by `deprecated_at` (not by SQL
    //    deletion), so RESTRICT is the right contract.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'fk_sad_previous_version'
        ) THEN
          ALTER TABLE "supplement_assembly_drafts"
            ADD CONSTRAINT "fk_sad_previous_version"
            FOREIGN KEY ("previous_version_id")
            REFERENCES "supplement_assembly_versions" ("id")
            ON DELETE RESTRICT;
        END IF;
      END$$;
    `);

    // 6. Optional supporting index for correction-draft lookup by the
    //    version being corrected. Cheap and BE-01 will read this path.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sad_previous_version"
        ON "supplement_assembly_drafts" ("previous_version_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse order. `IF EXISTS` guards keep `down()` idempotent.

    // 6 → 5 (index + FK)
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_sad_previous_version";
    `);
    await queryRunner.query(`
      ALTER TABLE "supplement_assembly_drafts"
        DROP CONSTRAINT IF EXISTS "fk_sad_previous_version";
    `);

    // 4 (draft columns)
    await queryRunner.query(`
      ALTER TABLE "supplement_assembly_drafts"
        DROP COLUMN IF EXISTS "correction_reason",
        DROP COLUMN IF EXISTS "correction_mode",
        DROP COLUMN IF EXISTS "previous_version_id",
        DROP COLUMN IF EXISTS "target_version";
    `);

    // 3 (version columns)
    await queryRunner.query(`
      ALTER TABLE "supplement_assembly_versions"
        DROP COLUMN IF EXISTS "deprecation_reason",
        DROP COLUMN IF EXISTS "deprecated_by_id",
        DROP COLUMN IF EXISTS "deprecated_at",
        DROP COLUMN IF EXISTS "correction_reason",
        DROP COLUMN IF EXISTS "correction_mode";
    `);

    // 1 (new correction-mode enum — safe to drop because all
    //    dependent columns are now gone).
    await queryRunner.query(`
      DROP TYPE IF EXISTS "supplement_assembly_correction_mode";
    `);

    // 2 (version-status enum 'deprecated' value) — intentionally NOT
    //    reverted. See class-doc Reversibility note. Pg does not
    //    support DROP VALUE; the swap-type fallback requires a
    //    pre-condition (no row with status='deprecated') that this
    //    migration cannot guarantee. Leaving the value present is
    //    harmless because the entity rollback removes the application
    //    code path that would write it.
  }
}
