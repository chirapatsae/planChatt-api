import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: W86CreateLineUserBindings — Wave 86 W86-DB-LINE-USER-BINDING.
 *
 * Creates the `line_user_bindings` table that maps a LINE user
 * (`line_user_id`) to a Project Bank `User`. The binding row is created
 * when a user completes the LINE Login OIDC flow on the profile page,
 * and is soft-unlinked (NOT hard-deleted) when the user clicks
 * "ยกเลิกการเชื่อมต่อ".
 *
 * Schema:
 *   - id              uuid PK (default uuid_generate_v4())
 *   - user_id         uuid NOT NULL, FK → users(id) ON DELETE CASCADE
 *   - line_user_id    varchar(64) NOT NULL
 *   - display_name    varchar(255) NULL  (snapshot at link, NOT synced)
 *   - picture_url     varchar(1024) NULL (snapshot at link, NOT synced)
 *   - linked_at       timestamptz NOT NULL DEFAULT now()
 *   - unlinked_at     timestamptz NULL   (soft unlink — preserves audit)
 *   - last_seen_at    timestamptz NULL   (bumped on webhook activity)
 *   - created_at      timestamptz NOT NULL DEFAULT now()
 *   - updated_at      timestamptz NOT NULL DEFAULT now()
 *
 * Indexes:
 *   1. idx_line_user_bindings_active_unique — UNIQUE partial on
 *      (line_user_id) WHERE unlinked_at IS NULL. Enforces at most one
 *      ACTIVE binding per LINE user globally while allowing historical
 *      soft-unlinked rows to coexist for the same line_user_id.
 *   2. idx_line_user_bindings_user_active — partial on (user_id) WHERE
 *      unlinked_at IS NULL. Fast lookup for "does this Project Bank
 *      user have an active LINE binding?".
 *   3. idx_line_user_bindings_line_user_id — plain on (line_user_id)
 *      for soft-deleted lookups (audit / forensic queries).
 *
 * CLAUDE.md references:
 *
 *   - §17.3 Audit separation. The soft-unlink pattern preserves history;
 *     the unique partial index lets re-link work without DB-level
 *     contention. NO FK to project / plan / tracking tables — the only
 *     FK is `user_id → users(id)`, which is appropriate for a
 *     user-scoped personal-data table (§14 lineage immutability does
 *     NOT apply because this is not a project row).
 *
 *   - §17.11 No role exemption. The schema is an integrity guarantee;
 *     no role (including super-admin) can bypass the active-uniqueness
 *     invariant.
 *
 *   - §12 Audit Rule. No `tracking_status` writes — bindings are NOT
 *     a workflow status.
 *
 * Idempotency:
 *   - `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`
 *     guards make `up()` safe to re-run on a partially applied DB.
 *
 * Reversibility:
 *   - `down()` drops indexes (LIFO) then the table. The User table is
 *     untouched (this migration MUST NOT modify the `users` table).
 */
export class W86CreateLineUserBindings1777680000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Table: line_user_bindings ─────────────────────────────────────
    // The only FK is `user_id → users(id) ON DELETE CASCADE`. Per §17.3
    // there is NO FK to any project / plan / tracking table — bindings
    // are user-scoped personal data, not workflow audit.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "line_user_bindings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "line_user_id" varchar(64) NOT NULL,
        "display_name" varchar(255) NULL,
        "picture_url" varchar(1024) NULL,
        "linked_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "unlinked_at" TIMESTAMP WITH TIME ZONE NULL,
        "last_seen_at" TIMESTAMP WITH TIME ZONE NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_line_user_bindings" PRIMARY KEY ("id"),
        CONSTRAINT "fk_line_user_bindings_user"
          FOREIGN KEY ("user_id")
          REFERENCES "users" ("id")
          ON DELETE CASCADE
      );
    `);

    // ── Index 1: UNIQUE partial — at most one ACTIVE binding per LINE
    //   user globally. Soft-unlinked rows (unlinked_at IS NOT NULL) are
    //   excluded from the uniqueness invariant so re-link works after
    //   unlink without DB-level contention.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        "idx_line_user_bindings_active_unique"
      ON "line_user_bindings" ("line_user_id")
      WHERE "unlinked_at" IS NULL;
    `);

    // ── Index 2: partial on (user_id) for the active-binding lookup
    //   path used by the profile page ("does this user have an active
    //   LINE binding?").
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "idx_line_user_bindings_user_active"
      ON "line_user_bindings" ("user_id")
      WHERE "unlinked_at" IS NULL;
    `);

    // ── Index 3: plain on (line_user_id) for soft-deleted / forensic
    //   lookups that DO want to see the unlinked history.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "idx_line_user_bindings_line_user_id"
      ON "line_user_bindings" ("line_user_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // LIFO — drop indexes first, then the table. The `users` table is
    // intentionally NOT touched by this migration (§14 lineage and the
    // task contract both forbid modifying `users`).
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_line_user_bindings_line_user_id";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_line_user_bindings_user_active";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_line_user_bindings_active_unique";
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "line_user_bindings";
    `);
  }
}
