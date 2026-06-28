import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CitizenFollowPersonKind — W-GATE-1 (person follow + public profiles).
 *
 * The C3 migration (1784000000000-CitizenFollowNotification) installed a CHECK
 * constraint `ck_citizen_follow_kind` restricting `target_kind` to
 * `('amphoe','category')` — the pre-§10 D11 forbid. §10 (APPROVED 2026-06-25)
 * now PERMITS follow-a-person, so this migration WIDENS that CHECK to also allow
 * `'person'`. `synchronize: true` does NOT alter existing CHECK constraints
 * (project memory: `project_typeorm_synchronize`), so the widening MUST run as a
 * migration.
 *
 * No new column / table / FK / index — only the `target_kind` CHECK is widened.
 * For `target_kind = 'person'`, `target_key` holds the followed citizen's
 * identity_id as a PLAIN uuid (NOT a new FK — kept a plain string like
 * amphoe/category to preserve the §17.3 table-level zero-FK invariant).
 *
 * §17.3 isolation: this migration touches ONLY the `citizen_follow` CHECK
 * constraint inside the `citizen_*` namespace. There is NO foreign key and
 * NO link to any project / users / work_history / tracking_status table —
 * the isolation spec's forbidden-table scan stays green.
 */
export class CitizenFollowPersonKind1784500000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop-then-add so the migration is idempotent (no IF NOT EXISTS for
    // constraints). Widen to include the new 'person' target kind.
    await queryRunner.query(
      `ALTER TABLE "citizen_follow" DROP CONSTRAINT IF EXISTS "ck_citizen_follow_kind";`,
    );
    await queryRunner.query(
      `ALTER TABLE "citizen_follow" ADD CONSTRAINT "ck_citizen_follow_kind" CHECK ("target_kind" IN ('amphoe','category','person'));`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Revert to the pre-W-GATE-1 (amphoe|category-only) CHECK. NOTE: if any live
    // 'person' follows exist this ADD would fail — operationally the down path
    // should soft-delete person rows first; left as a plain revert for symmetry.
    await queryRunner.query(
      `ALTER TABLE "citizen_follow" DROP CONSTRAINT IF EXISTS "ck_citizen_follow_kind";`,
    );
    await queryRunner.query(
      `ALTER TABLE "citizen_follow" ADD CONSTRAINT "ck_citizen_follow_kind" CHECK ("target_kind" IN ('amphoe','category'));`,
    );
  }
}
