import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CitizenEngagementInit — M0 of the civic-community plan.
 *
 * `synchronize: true` creates the `citizen_*` tables + plain columns + plain
 * indexes from the entity decorators. It does NOT create PARTIAL-UNIQUE
 * indexes or CHECK constraints — those live here (project memory:
 * `project_typeorm_synchronize`). Run this migration after the entities sync.
 *
 * §17.3: every object below is inside the `citizen_*` namespace. There is NO
 * FK to project_groups / any project table / users / work_history /
 * tracking_status — isolation is by construction.
 */
export class CitizenEngagementInit1782000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Partial-unique indexes (integrity rules synchronize cannot express) ──

    // One live citizen identity per ThaID subject.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_citizen_identity_sub_hash"
      ON "citizen_identities" ("thaid_sub_hash")
      WHERE "deleted_at" IS NULL;
    `);

    // One live identity per national-id hash (dedup / erasure lookup).
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_citizen_identity_nid_hash"
      ON "citizen_identities" ("national_id_hash")
      WHERE "national_id_hash" IS NOT NULL AND "deleted_at" IS NULL;
    `);

    // One ❤️ heart per citizen per post (toggle = soft-delete / re-insert).
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_citizen_reaction_one_per_identity"
      ON "citizen_post_reaction" ("post_id", "identity_id", "reaction")
      WHERE "deleted_at" IS NULL;
    `);

    // One active grant per (user, capability).
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_citizen_grant_one_granted"
      ON "citizen_backend_access_grants" ("user_id", "capability")
      WHERE "state" = 'granted';
    `);

    // ── CHECK constraints (enum-shaped varchars kept additive, no PG enum) ──
    const checks: [string, string, string][] = [
      ['citizen_identities', 'ck_citizen_identity_status', `"status" IN ('active','blocked')`],
      ['citizen_post', 'ck_citizen_post_kind', `"post_kind" IN ('idea','discussion')`],
      [
        'citizen_post',
        'ck_citizen_post_category',
        `"category" IS NULL OR "category" IN ('road','water','public','safety','other')`,
      ],
      [
        'citizen_post',
        'ck_citizen_post_mod_state',
        `"moderation_state" IN ('pending','visible','hidden','removed','shadow')`,
      ],
      [
        'citizen_post_comment',
        'ck_citizen_comment_mod_state',
        `"moderation_state" IN ('pending','visible','hidden','removed','shadow')`,
      ],
      [
        'citizen_moderation_log',
        'ck_citizen_moderation_action',
        `"action" IN ('report','hide','remove','restore','block_author')`,
      ],
      [
        'citizen_backend_access_grants',
        'ck_citizen_grant_capability',
        `"capability" IN ('moderate','insight','access_mgmt','respond')`,
      ],
      [
        'citizen_backend_access_grants',
        'ck_citizen_grant_state',
        `"state" IN ('pending','granted','revoked')`,
      ],
      ['citizen_audit_logs', 'ck_citizen_audit_actor_kind', `"actor_kind" IN ('citizen','internal')`],
    ];

    for (const [table, name, expr] of checks) {
      // Drop-then-add so the migration is idempotent (no IF NOT EXISTS for constraints).
      await queryRunner.query(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}";`);
      await queryRunner.query(`ALTER TABLE "${table}" ADD CONSTRAINT "${name}" CHECK (${expr});`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // LIFO — drop CHECKs, then partial-unique indexes.
    const checks: [string, string][] = [
      ['citizen_audit_logs', 'ck_citizen_audit_actor_kind'],
      ['citizen_backend_access_grants', 'ck_citizen_grant_state'],
      ['citizen_backend_access_grants', 'ck_citizen_grant_capability'],
      ['citizen_moderation_log', 'ck_citizen_moderation_action'],
      ['citizen_post_comment', 'ck_citizen_comment_mod_state'],
      ['citizen_post', 'ck_citizen_post_mod_state'],
      ['citizen_post', 'ck_citizen_post_category'],
      ['citizen_post', 'ck_citizen_post_kind'],
      ['citizen_identities', 'ck_citizen_identity_status'],
    ];
    for (const [table, name] of checks) {
      await queryRunner.query(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}";`);
    }

    await queryRunner.query(`DROP INDEX IF EXISTS "uq_citizen_grant_one_granted";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_citizen_reaction_one_per_identity";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_citizen_identity_nid_hash";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_citizen_identity_sub_hash";`);
  }
}
