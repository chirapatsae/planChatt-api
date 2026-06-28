import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CitizenBlock — W-T1 of the citizen-social-platform wave (block / mute).
 *
 * One new `citizen_*` table `citizen_block` storing a DIRECTED mute/block edge
 * (`blocker_identity_id → blocked_identity_id`, `kind IN ('mute','block')`).
 *
 * §17.3 isolation (CRITICAL): the citizen isolation spec scans the raw text of
 * every citizen migration and FAILS the build if the SQL foreign-key keyword
 * (the bare word it bans) appears in any of them — even inside a comment. So the
 * CREATE TABLE below declares ONLY columns + indexes + the partial-unique + the
 * kind CHECK; it emits NO foreign-key clause whatsoever. The actual foreign key
 * (`blocker_identity_id → citizen_identities`) is materialised by
 * `synchronize: true` in dev from the `@ManyToOne` relation on the entity. The
 * table therefore stays purely within the engagement namespace — zero foreign
 * key into any project table / users / work_history / tracking_status.
 *
 * In dev, `synchronize: true` already creates the table + columns + indexes from
 * the entity decorators; this migration is for prod/record parity and does NOT
 * auto-run (project memory: `project_typeorm_synchronize`). It is idempotent.
 * §17.2 advisory — a block / mute creates no project and changes no workflow
 * status.
 */
export class CitizenBlock1794000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── citizen_block — directed mute/block edge (columns + indexes ONLY) ─────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "citizen_block" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "blocker_identity_id" uuid NOT NULL,
        "blocked_identity_id" uuid NOT NULL,
        "kind" varchar(8) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        CONSTRAINT "pk_citizen_block" PRIMARY KEY ("id")
      );
    `);

    // kind is one of the two FROZEN values.
    await queryRunner.query(
      `ALTER TABLE "citizen_block" DROP CONSTRAINT IF EXISTS "ck_citizen_block_kind";`,
    );
    await queryRunner.query(
      `ALTER TABLE "citizen_block" ADD CONSTRAINT "ck_citizen_block_kind" CHECK ("kind" IN ('mute','block'));`,
    );

    // Per-blocker lookup (the read-filter "who do I hide?" + owner-scoped list).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_citizen_block_blocker"
      ON "citizen_block" ("blocker_identity_id");
    `);

    // At most ONE live edge per directed (blocker, blocked) pair — switching
    // kind UPDATEs this same row; a re-block after unblock re-inserts. The
    // partial predicate lets a soft-deleted history row coexist with a fresh one.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_citizen_block_pair"
      ON "citizen_block" ("blocker_identity_id", "blocked_identity_id")
      WHERE "deleted_at" IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_citizen_block_pair";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "ix_citizen_block_blocker";`);
    await queryRunner.query(
      `ALTER TABLE "citizen_block" DROP CONSTRAINT IF EXISTS "ck_citizen_block_kind";`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "citizen_block";`);
  }
}
