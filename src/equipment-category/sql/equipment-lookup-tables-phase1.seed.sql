-- =============================================================================
-- Wave Equipment ผ.03, Phase 1 — DB-01 (2026-05-27)
--
-- Standalone psql-runnable seed script. Equivalent to the TypeORM
-- migration `1782100000000-EquipmentLookupTablesPhase1.ts` — included
-- because the backend uses `synchronize: true` and does NOT auto-run
-- migration files (see MEMORY: typeorm synchronize). With synchronize
-- the empty tables will exist after the backend restarts; this script
-- is what actually seeds them.
--
-- Run with:
--   PGPASSWORD='Pao@1234!' /Library/PostgreSQL/17/bin/psql \
--     -U postgres -d project_bank \
--     -f backend/src/equipment-category/sql/equipment-lookup-tables-phase1.seed.sql
--
-- Idempotent — re-run safe (ON CONFLICT DO NOTHING on both seeds).
-- The post-insert assertion will RAISE EXCEPTION if the expected
-- counts (14 categories, 42 scopes) are not met.
-- =============================================================================

-- ── Step 1: equipment_categories table (synchronize creates this too) ────────
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

CREATE UNIQUE INDEX IF NOT EXISTS "uq_equipment_categories_code"
  ON "equipment_categories" ("code");

-- ── Step 2: equipment_category_scopes table ──────────────────────────────────
CREATE TABLE IF NOT EXISTS "equipment_category_scopes" (
  "id"                       uuid        NOT NULL DEFAULT gen_random_uuid(),
  "equipment_category_id"    uuid        NOT NULL,
  "tactic_id"                varchar     NOT NULL,
  "plan_id"                  varchar     NOT NULL,
  "created_at"               TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "PK_equipment_category_scopes" PRIMARY KEY ("id")
);

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

CREATE UNIQUE INDEX IF NOT EXISTS "uq_equipment_category_scope_triple"
  ON "equipment_category_scopes"
  ("equipment_category_id", "tactic_id", "plan_id");

CREATE INDEX IF NOT EXISTS "idx_equipment_category_scope_tactic_plan"
  ON "equipment_category_scopes" ("tactic_id", "plan_id");

CREATE INDEX IF NOT EXISTS "idx_equipment_category_scope_plan"
  ON "equipment_category_scopes" ("plan_id");

-- ── Step 3: Seed 14 categories ───────────────────────────────────────────────
INSERT INTO equipment_categories (code, name, sort_order) VALUES
  (1,  'ครุภัณฑ์สำนักงาน',                  1),
  (2,  'ครุภัณฑ์การศึกษา',                  2),
  (3,  'ครุภัณฑ์ยานพาหนะและขนส่ง',          3),
  (4,  'ครุภัณฑ์การเกษตร',                  4),
  (5,  'ครุภัณฑ์ก่อสร้าง',                   5),
  (6,  'ครุภัณฑ์ไฟฟ้าและวิทยุ',              6),
  (7,  'ครุภัณฑ์โฆษณาและเผยแพร่',            7),
  (8,  'ครุภัณฑ์วิทยาศาสตร์หรือการแพทย์',     8),
  (9,  'ครุภัณฑ์งานบ้านงานครัว',              9),
  (11, 'ครุภัณฑ์กีฬา',                       11),
  (12, 'ครุภัณฑ์สำรวจ',                      12),
  (13, 'ครุภัณฑ์ดนตรีและนาฏศิลป์',           13),
  (14, 'ครุภัณฑ์คอมพิวเตอร์หรืออิเล็กทรอนิกส์', 14),
  (16, 'ครุภัณฑ์อื่น',                       16)   -- F6: no trailing ๆ
ON CONFLICT (code) DO NOTHING;

-- ── Step 4: F7 pre-flight + seed 42 scopes ───────────────────────────────────
-- Pre-flight: assert every (tactic_id, plan_id) in the seed list exists
-- in plan_tactics. Abort migration BEFORE any scope insert if violated.
DO $$
DECLARE
  missing_count int;
  missing_list  text;
BEGIN
  WITH seed (tactic_id, plan_id) AS (
    VALUES
      ('TACT004','PLAN003'),('TACT010','PLAN010'),('TACT020','PLAN001'),
      ('TACT004','PLAN003'),
      ('TACT004','PLAN003'),('TACT005','PLAN005'),('TACT007','PLAN004'),
      ('TACT014','PLAN009'),('TACT016','PLAN002'),('TACT020','PLAN001'),
      ('TACT020','PLAN009'),
      ('TACT004','PLAN003'),('TACT007','PLAN004'),('TACT010','PLAN010'),
      ('TACT016','PLAN002'),('TACT020','PLAN009'),
      ('TACT014','PLAN009'),('TACT016','PLAN002'),('TACT020','PLAN009'),
      ('TACT004','PLAN003'),('TACT007','PLAN004'),('TACT016','PLAN002'),
      ('TACT004','PLAN003'),('TACT005','PLAN005'),('TACT007','PLAN004'),
      ('TACT010','PLAN010'),('TACT016','PLAN002'),
      ('TACT004','PLAN003'),('TACT007','PLAN004'),('TACT016','PLAN002'),
      ('TACT004','PLAN003'),
      ('TACT004','PLAN003'),
      ('TACT014','PLAN009'),
      ('TACT004','PLAN003'),
      ('TACT004','PLAN003'),('TACT005','PLAN005'),('TACT007','PLAN004'),
      ('TACT010','PLAN010'),('TACT016','PLAN002'),
      ('TACT014','PLAN009'),('TACT016','PLAN002'),('TACT020','PLAN006')
  ),
  unique_seed AS (
    SELECT DISTINCT tactic_id, plan_id FROM seed
  ),
  missing AS (
    SELECT us.tactic_id, us.plan_id
    FROM unique_seed us
    WHERE NOT EXISTS (
      SELECT 1 FROM plan_tactics pt
      WHERE pt.tactic_id = us.tactic_id AND pt.plan_id = us.plan_id
    )
  )
  SELECT count(*), string_agg('(' || tactic_id || ', ' || plan_id || ')', ', ')
  INTO missing_count, missing_list
  FROM missing;

  IF missing_count > 0 THEN
    RAISE EXCEPTION
      '[EquipmentLookupTablesPhase1] F7 invariant violation — % (tactic_id, plan_id) tuple(s) missing from plan_tactics: %',
      missing_count, missing_list;
  END IF;
END$$;

-- Seed the 42 scope rows. Resolve equipment_category_id by code; tactic_id
-- and plan_id are natural keys so they map straight through. ON CONFLICT
-- on the composite UNIQUE handles re-runs.
INSERT INTO equipment_category_scopes (equipment_category_id, tactic_id, plan_id)
SELECT ec.id, s.tactic_id, s.plan_id
FROM (VALUES
  (1,  'TACT004','PLAN003'),
  (1,  'TACT010','PLAN010'),
  (1,  'TACT020','PLAN001'),
  (2,  'TACT004','PLAN003'),
  (3,  'TACT004','PLAN003'),
  (3,  'TACT005','PLAN005'),
  (3,  'TACT007','PLAN004'),
  (3,  'TACT014','PLAN009'),
  (3,  'TACT016','PLAN002'),
  (3,  'TACT020','PLAN001'),
  (3,  'TACT020','PLAN009'),
  (4,  'TACT004','PLAN003'),
  (4,  'TACT007','PLAN004'),
  (4,  'TACT010','PLAN010'),
  (4,  'TACT016','PLAN002'),
  (4,  'TACT020','PLAN009'),
  (5,  'TACT014','PLAN009'),
  (5,  'TACT016','PLAN002'),
  (5,  'TACT020','PLAN009'),
  (6,  'TACT004','PLAN003'),
  (6,  'TACT007','PLAN004'),
  (6,  'TACT016','PLAN002'),
  (7,  'TACT004','PLAN003'),
  (7,  'TACT005','PLAN005'),
  (7,  'TACT007','PLAN004'),
  (7,  'TACT010','PLAN010'),
  (7,  'TACT016','PLAN002'),
  (8,  'TACT004','PLAN003'),
  (8,  'TACT007','PLAN004'),
  (8,  'TACT016','PLAN002'),
  (9,  'TACT004','PLAN003'),
  (11, 'TACT004','PLAN003'),
  (12, 'TACT014','PLAN009'),
  (13, 'TACT004','PLAN003'),
  (14, 'TACT004','PLAN003'),
  (14, 'TACT005','PLAN005'),
  (14, 'TACT007','PLAN004'),
  (14, 'TACT010','PLAN010'),
  (14, 'TACT016','PLAN002'),
  (16, 'TACT014','PLAN009'),
  (16, 'TACT016','PLAN002'),
  (16, 'TACT020','PLAN006')
) AS s(code, tactic_id, plan_id)
JOIN equipment_categories ec ON ec.code = s.code
ON CONFLICT (equipment_category_id, tactic_id, plan_id) DO NOTHING;

-- ── Step 5: Post-insert assertions ───────────────────────────────────────────
DO $$
DECLARE
  cat_count   int;
  scope_count int;
BEGIN
  SELECT count(*) INTO cat_count FROM equipment_categories;
  IF cat_count <> 14 THEN
    RAISE EXCEPTION
      '[EquipmentLookupTablesPhase1] expected 14 equipment_categories rows, found %',
      cat_count;
  END IF;

  SELECT count(*) INTO scope_count FROM equipment_category_scopes;
  IF scope_count <> 42 THEN
    RAISE EXCEPTION
      '[EquipmentLookupTablesPhase1] expected 42 equipment_category_scopes rows, found %',
      scope_count;
  END IF;

  RAISE NOTICE
    '[EquipmentLookupTablesPhase1] seed OK — % categories, % scopes',
    cat_count, scope_count;
END$$;
