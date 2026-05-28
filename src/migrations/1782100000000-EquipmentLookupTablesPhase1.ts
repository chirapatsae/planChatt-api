import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wave Equipment ผ.03, Phase 1 — DB-01 (2026-05-27).
 *
 * Creates and seeds two reference tables that back the future
 * cascading-filter endpoint "given (tacticId, planId), which
 * equipment categories are valid?":
 *
 *   equipment_categories       — 14 ครุภัณฑ์ categories (sparse codes:
 *                                1..9, 11..14, 16; 10 and 15 omitted
 *                                per the MOI ผ.03 form itself)
 *
 *   equipment_category_scopes  — 42 junction rows encoding the
 *                                user-submitted (category, tactic, plan)
 *                                triples. Note: the original CTO spec
 *                                said "41" but the user-corrected count
 *                                is 42 (DB-01 task message §"Two
 *                                corrections" — also fixes the spec's
 *                                non-existent `tactics.code` / `plans.code`
 *                                columns by resolving codes to natural-key
 *                                IDs at migration-authoring time).
 *
 * Out of scope (Phase 2):
 *   - `equipment_project_groups` entity
 *   - tracking-status / attachment FKs into equipment tables
 *   - §16.5 classification-shape CHECK extension
 *
 * Verification findings carried over byte-for-byte:
 *   - F1, F2 — store by code only (natural-key IDs).
 *   - F4    — PLAN011 is dead data; the 42-tuple set excludes it.
 *   - F6    — code 16 name is `ครุภัณฑ์อื่น` (no trailing "ๆ").
 *   - F7    — every (tactic_id, plan_id) in the seed MUST already
 *             exist in `plan_tactics`; if absent, abort migration
 *             with a clear error listing the offending tuple(s).
 *
 * Idempotency:
 *   - `CREATE TABLE IF NOT EXISTS` keeps schema creation re-run safe.
 *     (synchronize:true will also auto-create the tables from entity
 *     metadata on boot — this migration tolerates that prior state.)
 *   - `ON CONFLICT DO NOTHING` on both seed targets keeps row inserts
 *     re-run safe.
 *   - Post-insert assertion compares COUNT(*) against the expected 42
 *     scope rows; if less, the migration RAISEs an exception listing
 *     the missing tuples so the operator can resolve the F7 invariant
 *     violation before retrying.
 *
 * Integrity invariants:
 *   - CLAUDE.md §10 — reference data only; no FK into project / plan /
 *     tracking tables. The junction's FKs are to `equipment_categories`,
 *     `tactics`, `plans` — all reference-data tables.
 *   - CLAUDE.md §12 — no TrackingStatus side-effects (reference data is
 *     not a workflow transition).
 *   - CLAUDE.md §14 / §15 — orthogonal; no lineage involvement.
 *   - CLAUDE.md §16 — orthogonal; equipment is format-agnostic (Phase 2).
 *   - CLAUDE.md §18 — orphan cleanup does not touch reference data.
 */
export class EquipmentLookupTablesPhase11782100000000
  implements MigrationInterface
{
  name = 'EquipmentLookupTablesPhase11782100000000';

  // ---------------------------------------------------------------------------
  // Seed data — frozen at migration-authoring time per DB-01 task message.
  // ---------------------------------------------------------------------------

  /**
   * The 14 master categories. Codes are sparse (the MOI ผ.03 form
   * skips 10 and 15). Per F6, code 16 name is `ครุภัณฑ์อื่น`
   * (NOT `ครุภัณฑ์อื่นๆ`).
   */
  private readonly CATEGORIES: ReadonlyArray<{
    code: number;
    name: string;
    sortOrder: number;
  }> = [
    { code: 1,  name: 'ครุภัณฑ์สำนักงาน', sortOrder: 1 },
    { code: 2,  name: 'ครุภัณฑ์การศึกษา', sortOrder: 2 },
    { code: 3,  name: 'ครุภัณฑ์ยานพาหนะและขนส่ง', sortOrder: 3 },
    { code: 4,  name: 'ครุภัณฑ์การเกษตร', sortOrder: 4 },
    { code: 5,  name: 'ครุภัณฑ์ก่อสร้าง', sortOrder: 5 },
    { code: 6,  name: 'ครุภัณฑ์ไฟฟ้าและวิทยุ', sortOrder: 6 },
    { code: 7,  name: 'ครุภัณฑ์โฆษณาและเผยแพร่', sortOrder: 7 },
    { code: 8,  name: 'ครุภัณฑ์วิทยาศาสตร์หรือการแพทย์', sortOrder: 8 },
    { code: 9,  name: 'ครุภัณฑ์งานบ้านงานครัว', sortOrder: 9 },
    { code: 11, name: 'ครุภัณฑ์กีฬา', sortOrder: 11 },
    { code: 12, name: 'ครุภัณฑ์สำรวจ', sortOrder: 12 },
    { code: 13, name: 'ครุภัณฑ์ดนตรีและนาฏศิลป์', sortOrder: 13 },
    { code: 14, name: 'ครุภัณฑ์คอมพิวเตอร์หรืออิเล็กทรอนิกส์', sortOrder: 14 },
    { code: 16, name: 'ครุภัณฑ์อื่น', sortOrder: 16 },
  ];

  /**
   * Pre-resolved 42 (categoryCode, tacticId, planId) triples per the
   * DB-01 task message. The user-supplied prefix codes (e.g. "2.1",
   * "3.2") were resolved at migration-authoring time to the
   * canonical natural-key IDs from `tactics.id` / `plans.id`.
   *
   * Do NOT try to extract codes from name prefixes at runtime —
   * the migration is the single source of truth for these triples.
   */
  private readonly SEED_SCOPES: ReadonlyArray<[number, string, string]> = [
    // category 1 — ครุภัณฑ์สำนักงาน
    [1,  'TACT004', 'PLAN003'],
    [1,  'TACT010', 'PLAN010'],
    [1,  'TACT020', 'PLAN001'],
    // category 2 — ครุภัณฑ์การศึกษา
    [2,  'TACT004', 'PLAN003'],
    // category 3 — ครุภัณฑ์ยานพาหนะและขนส่ง
    [3,  'TACT004', 'PLAN003'],
    [3,  'TACT005', 'PLAN005'],
    [3,  'TACT007', 'PLAN004'],
    [3,  'TACT014', 'PLAN009'],
    [3,  'TACT016', 'PLAN002'],
    [3,  'TACT020', 'PLAN001'],
    [3,  'TACT020', 'PLAN009'],
    // category 4 — ครุภัณฑ์การเกษตร
    [4,  'TACT004', 'PLAN003'],
    [4,  'TACT007', 'PLAN004'],
    [4,  'TACT010', 'PLAN010'],
    [4,  'TACT016', 'PLAN002'],
    [4,  'TACT020', 'PLAN009'],
    // category 5 — ครุภัณฑ์ก่อสร้าง
    [5,  'TACT014', 'PLAN009'],
    [5,  'TACT016', 'PLAN002'],
    [5,  'TACT020', 'PLAN009'],
    // category 6 — ครุภัณฑ์ไฟฟ้าและวิทยุ
    [6,  'TACT004', 'PLAN003'],
    [6,  'TACT007', 'PLAN004'],
    [6,  'TACT016', 'PLAN002'],
    // category 7 — ครุภัณฑ์โฆษณาและเผยแพร่
    [7,  'TACT004', 'PLAN003'],
    [7,  'TACT005', 'PLAN005'],
    [7,  'TACT007', 'PLAN004'],
    [7,  'TACT010', 'PLAN010'],
    [7,  'TACT016', 'PLAN002'],
    // category 8 — ครุภัณฑ์วิทยาศาสตร์หรือการแพทย์
    [8,  'TACT004', 'PLAN003'],
    [8,  'TACT007', 'PLAN004'],
    [8,  'TACT016', 'PLAN002'],
    // category 9 — ครุภัณฑ์งานบ้านงานครัว
    [9,  'TACT004', 'PLAN003'],
    // category 11 — ครุภัณฑ์กีฬา
    [11, 'TACT004', 'PLAN003'],
    // category 12 — ครุภัณฑ์สำรวจ
    [12, 'TACT014', 'PLAN009'],
    // category 13 — ครุภัณฑ์ดนตรีและนาฏศิลป์
    [13, 'TACT004', 'PLAN003'],
    // category 14 — ครุภัณฑ์คอมพิวเตอร์หรืออิเล็กทรอนิกส์
    [14, 'TACT004', 'PLAN003'],
    [14, 'TACT005', 'PLAN005'],
    [14, 'TACT007', 'PLAN004'],
    [14, 'TACT010', 'PLAN010'],
    [14, 'TACT016', 'PLAN002'],
    // category 16 — ครุภัณฑ์อื่น (NOT 'ครุภัณฑ์อื่นๆ' per F6)
    [16, 'TACT014', 'PLAN009'],
    [16, 'TACT016', 'PLAN002'],
    [16, 'TACT020', 'PLAN006'],
  ];

  // ---------------------------------------------------------------------------
  // up()
  // ---------------------------------------------------------------------------

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Step 1: Create equipment_categories table (idempotent) ──────────────
    // `synchronize:true` may have already created this from the entity
    // metadata — `IF NOT EXISTS` tolerates that prior state.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "equipment_categories" (
        "id"          uuid        NOT NULL DEFAULT gen_random_uuid(),
        "code"        integer     NOT NULL,
        "name"        text        NOT NULL,
        "sort_order"  integer     NOT NULL,
        "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at"  TIMESTAMPTZ,
        CONSTRAINT "PK_equipment_categories" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_equipment_categories_code"
        ON "equipment_categories" ("code");
    `);

    // ── Step 2: Create equipment_category_scopes table (idempotent) ─────────
    // tactic_id and plan_id are varchar to match the natural-key string
    // PKs on `tactics.id` and `plans.id` (e.g. 'TACT004', 'PLAN003').
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "equipment_category_scopes" (
        "id"                       uuid        NOT NULL DEFAULT gen_random_uuid(),
        "equipment_category_id"    uuid        NOT NULL,
        "tactic_id"                varchar     NOT NULL,
        "plan_id"                  varchar     NOT NULL,
        "created_at"               TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"               TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_equipment_category_scopes" PRIMARY KEY ("id")
      );
    `);

    // FKs — guarded with DO blocks so re-runs are no-ops.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_ecs_equipment_category'
        ) THEN
          ALTER TABLE "equipment_category_scopes"
            ADD CONSTRAINT "FK_ecs_equipment_category"
              FOREIGN KEY ("equipment_category_id")
              REFERENCES "equipment_categories" ("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_ecs_tactic'
        ) THEN
          ALTER TABLE "equipment_category_scopes"
            ADD CONSTRAINT "FK_ecs_tactic"
              FOREIGN KEY ("tactic_id")
              REFERENCES "tactics" ("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_ecs_plan'
        ) THEN
          ALTER TABLE "equipment_category_scopes"
            ADD CONSTRAINT "FK_ecs_plan"
              FOREIGN KEY ("plan_id")
              REFERENCES "plans" ("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;
      END$$;
    `);

    // Indexes — UNIQUE composite is the dedup/idempotency key.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_equipment_category_scope_triple"
        ON "equipment_category_scopes"
        ("equipment_category_id", "tactic_id", "plan_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_equipment_category_scope_tactic_plan"
        ON "equipment_category_scopes" ("tactic_id", "plan_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_equipment_category_scope_plan"
        ON "equipment_category_scopes" ("plan_id");
    `);

    // ── Step 3: Seed equipment_categories (14 rows, idempotent) ─────────────
    for (const row of this.CATEGORIES) {
      await queryRunner.query(
        `INSERT INTO equipment_categories (code, name, sort_order)
         VALUES ($1, $2, $3)
         ON CONFLICT (code) DO NOTHING`,
        [row.code, row.name, row.sortOrder],
      );
    }

    // ── Step 4: F7 pre-flight check ─────────────────────────────────────────
    // Verify every (tactic_id, plan_id) in SEED_SCOPES exists in
    // plan_tactics BEFORE attempting any junction insert. Surface the
    // FULL list of offending tuples in one error so the operator can
    // resolve them in one pass.
    const missingPlanTactics: Array<{ tacticId: string; planId: string }> = [];
    for (const [, tacticId, planId] of this.SEED_SCOPES) {
      const rows: Array<{ exists: boolean }> = await queryRunner.query(
        `SELECT EXISTS (
           SELECT 1 FROM plan_tactics
           WHERE tactic_id = $1 AND plan_id = $2
         ) AS exists`,
        [tacticId, planId],
      );
      if (!rows[0]?.exists) {
        missingPlanTactics.push({ tacticId, planId });
      }
    }
    if (missingPlanTactics.length > 0) {
      throw new Error(
        `[EquipmentLookupTablesPhase1] F7 invariant violation — ` +
          `${missingPlanTactics.length} (tactic_id, plan_id) tuple(s) ` +
          `missing from plan_tactics: ` +
          missingPlanTactics
            .map((t) => `(${t.tacticId}, ${t.planId})`)
            .join(', '),
      );
    }

    // ── Step 5: Seed equipment_category_scopes (42 rows, idempotent) ────────
    // Resolve category_id by code; tactic_id/plan_id are natural keys
    // so they map straight through. ON CONFLICT DO NOTHING on the
    // composite UNIQUE handles re-runs.
    let insertedCount = 0;
    let skippedCount = 0;
    for (const [categoryCode, tacticId, planId] of this.SEED_SCOPES) {
      const result: [unknown[], number] = await queryRunner.query(
        `INSERT INTO equipment_category_scopes (equipment_category_id, tactic_id, plan_id)
         SELECT ec.id, $2, $3
         FROM equipment_categories ec
         WHERE ec.code = $1
         ON CONFLICT (equipment_category_id, tactic_id, plan_id) DO NOTHING`,
        [categoryCode, tacticId, planId],
      );
      // pg driver returns affected rows in result[1] for INSERT...SELECT
      const affected = Array.isArray(result) ? result[1] : 0;
      if (affected && affected > 0) {
        insertedCount += affected;
      } else {
        skippedCount += 1;
      }
    }

    // ── Step 6: Post-insert assertion ───────────────────────────────────────
    // Total rows MUST equal 42 (the user-corrected count; the spec's
    // "41" is wrong — see DB-01 task message §"Two corrections").
    const countRows: Array<{ count: string }> = await queryRunner.query(
      `SELECT COUNT(*)::text AS count FROM equipment_category_scopes`,
    );
    const totalScopes = parseInt(countRows[0]?.count ?? '0', 10);
    const EXPECTED_SCOPE_COUNT = 42;

    if (totalScopes !== EXPECTED_SCOPE_COUNT) {
      throw new Error(
        `[EquipmentLookupTablesPhase1] post-insert assertion failed: ` +
          `expected ${EXPECTED_SCOPE_COUNT} equipment_category_scopes ` +
          `rows, found ${totalScopes}. ` +
          `Inserted this run: ${insertedCount}; already-present skips: ${skippedCount}. ` +
          `Investigate which (category, tactic, plan) triple failed to insert.`,
      );
    }

    // eslint-disable-next-line no-console
    console.log(
      `[EquipmentLookupTablesPhase1] seed OK — ` +
        `${this.CATEGORIES.length} categories, ${totalScopes} scopes ` +
        `(this run: ${insertedCount} inserted, ${skippedCount} already present).`,
    );
  }

  // ---------------------------------------------------------------------------
  // down()
  // ---------------------------------------------------------------------------

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Per spec §8.3: TRUNCATE scopes, TRUNCATE categories, then DROP both
    // in dependency order. CASCADE on DROP TABLE removes FKs + indexes.
    await queryRunner.query(
      `TRUNCATE TABLE "equipment_category_scopes" RESTART IDENTITY CASCADE;`,
    );
    await queryRunner.query(
      `TRUNCATE TABLE "equipment_categories" RESTART IDENTITY CASCADE;`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "equipment_category_scopes" CASCADE;`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "equipment_categories" CASCADE;`,
    );
  }
}
