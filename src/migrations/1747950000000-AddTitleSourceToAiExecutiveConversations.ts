import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddTitleSourceToAiExecutiveConversations — Wave 51 DB-W51-01.
 *
 * Adds two metadata columns to `ai_executive_conversations` so the service
 * layer (BE-W51-02) can distinguish how each conversation's current title
 * was produced:
 *
 *   - `title_source varchar(32) NOT NULL DEFAULT 'default-placeholder'`
 *     Discriminator for the three title origins:
 *       - 'default-placeholder' — row was just inserted with the literal
 *         Thai placeholder `'บทสนทนาใหม่'` (unchanged shape from Wave 44)
 *       - 'llm-auto'            — Wave 51 background auto-title wrote it
 *       - 'user-rename'         — owner clicked the sidebar rename UI
 *
 *   - `title_generated_at timestamptz NULL`
 *     Timestamp of the last auto-title or user-rename write. NULL while
 *     the title is still the default placeholder.
 *
 * Migration-number deviation
 * --------------------------
 * The Wave 51 dispatch plan / task spec originally proposed the migration
 * number `1746259300000`. Investigation showed that number is already in
 * use by `1746259300000-FixAiExecutiveMessagesNullableColumns.ts` (Wave 44
 * HOTFIX), so this migration takes the next safe timestamp AFTER the
 * latest Wave 50 migration `1747900000000-AddTurnIndexToAiExecutiveMessages.ts`.
 * The resulting number `1747950000000` keeps strict chronological ordering
 * and avoids the collision. The file-name suffix and class-name suffix
 * both reflect the new number. The task's ACCEPTANCE CRITERIA do not
 * depend on the literal timestamp — only on reversibility, idempotency,
 * and column shape, all of which are preserved.
 *
 * Cold-boot parity
 * ----------------
 * Postgres `ALTER TABLE ... ADD COLUMN <col> <type> NOT NULL DEFAULT <v>`
 * is an atomic operation: the default materialises on every existing row
 * as part of the ALTER itself (Postgres 11+ uses a fast, metadata-only
 * path for non-volatile defaults). This means:
 *
 *   1. Fresh DB via `synchronize: true` — TypeORM emits ADD COLUMN with
 *      DEFAULT + NOT NULL from the entity metadata; succeeds immediately
 *      on the newly-created table.
 *   2. Legacy DB with pre-Wave-51 rows via `synchronize: true` — same ADD
 *      COLUMN statement materialises `'default-placeholder'` on every
 *      existing row before the NOT NULL is applied; succeeds.
 *   3. Migration-driven environments — this `up()` runs the same ALTER
 *      and is idempotent via the `IF NOT EXISTS` guard.
 *
 * Because the default-at-ALTER route is reliable on Postgres, no
 * three-step nullable→backfill→NOT NULL ritual is required (contrast
 * with Wave 50 `turn_index`, which HAD to stage the column nullable
 * because it had no default). The entity keeps `titleSource` strictly
 * non-null.
 *
 * Idempotency
 * -----------
 * `ADD COLUMN IF NOT EXISTS` — repeat runs are guaranteed no-ops.
 *
 * Reversibility
 * -------------
 * `down()` drops both columns in reverse declaration order. No data
 * outside these two columns is touched; rollback is byte-for-byte clean.
 *
 * CLAUDE.md compliance
 * --------------------
 *   - §12 Audit Rule — no `tracking_status` write, no TrackingStatus
 *     semantics. Title metadata is display-only per §17.2 advisory-only.
 *   - §17.3 Audit separation — the `ai_*` namespace is preserved. NO
 *     foreign key is introduced. Neither column references any other
 *     table.
 *   - §17.4 Staleness — `staleness_policy` is UNTOUCHED; conversation
 *     title is mutable metadata, not a snapshot-policy field. Adding
 *     `title_source` does NOT alter `isStale` semantics for any existing
 *     row in any `ai_*` table.
 *   - §17.11 No role exemption — the enum-like domain of `title_source`
 *     is application-enforced (see §16.4 / §16.5 precedent: app-layer
 *     enforcement of shape invariants; no DB CHECK required). No role
 *     (including super-admin) may coerce a non-member value; the service
 *     layer in BE-W51-02 is the single writer.
 *   - §14 / §15 — no project-table touch and no plan/book-level touch.
 */
export class AddTitleSourceToAiExecutiveConversations1747950000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1) title_source — non-null discriminator with a server-side default.
    //    Postgres materialises the default on every existing row during
    //    this ALTER, so NOT NULL is satisfied without a separate backfill.
    await queryRunner.query(`
      ALTER TABLE "ai_executive_conversations"
      ADD COLUMN IF NOT EXISTS "title_source" varchar(32)
        NOT NULL DEFAULT 'default-placeholder';
    `);

    // 2) title_generated_at — nullable timestamp; NULL until the first
    //    auto-title or manual rename write bumps it.
    await queryRunner.query(`
      ALTER TABLE "ai_executive_conversations"
      ADD COLUMN IF NOT EXISTS "title_generated_at" timestamptz NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse order: drop the nullable column first, then the non-null
    // discriminator. Both use IF EXISTS so a partially-applied run can
    // be cleanly rolled back.
    await queryRunner.query(`
      ALTER TABLE "ai_executive_conversations"
      DROP COLUMN IF EXISTS "title_generated_at";
    `);
    await queryRunner.query(`
      ALTER TABLE "ai_executive_conversations"
      DROP COLUMN IF EXISTS "title_source";
    `);
  }
}
