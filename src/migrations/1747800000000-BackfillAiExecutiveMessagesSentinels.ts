import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: BackfillAiExecutiveMessagesSentinels — Wave 45 DB-W45-01 Option B.
 *
 * One-shot DATA CORRECTION (not a schema change). Replaces Wave 44
 * HOTFIX-W44-01 legacy sentinel rows in `ai_executive_messages` with real
 * NULL values on `target_id` / `target_kind`. BE-W45-01 writes NULL
 * natively for non-project-scoped chat turns; this migration retroactively
 * normalizes historical rows so analytics / reporting see a single shape:
 *
 *   - target_id IS NULL      → no project context
 *   - target_id IS NOT NULL  → project-scoped chat turn
 *
 * Timestamp is strictly LATER than the nullability-drop migration
 * `1746259300000-FixAiExecutiveMessagesNullableColumns` — that migration
 * MUST run first so both columns are physically nullable before this
 * UPDATE can set them to NULL.
 *
 * Pre-run evidence captured on dev before authoring this migration
 * (see `docs/reports/wave45/DB-W45-01.md` §"Post-run Results"):
 *   - Verifier: `[DB-W45-01] ai_executive_messages target columns nullable: OK`
 *   - Sentinel count: `sentinel_rows: 13 / total_chat_rows: 13`
 *   - Decision rule (count < 100) → Option B, clean-up is cheap.
 *
 * Idempotency
 * -----------
 * The WHERE filter only matches the exact sentinel triplet:
 *     target_id   = '00000000-0000-0000-0000-000000000000'
 *   AND target_kind = 'project-group'
 *   AND endpoint    = 'executive-chat'
 *   AND deleted_at  IS NULL
 *
 * Once a row is updated, `target_id` becomes NULL and the row no longer
 * matches the filter. Re-running this migration (or running the same
 * statement via the Bootstrap hook on every boot) is a guaranteed no-op.
 * This property is what makes Option B safe to wire into
 * `BootstrapMigrationsService.STATEMENTS` for auto-heal on staging/prod.
 *
 * CLAUDE.md compliance
 * --------------------
 *   - §17.3 Audit separation — this is a FIELD-VALUE correction on two
 *     metadata columns. NO `tracking_status` row is created or mutated.
 *     NO row is deleted. NO FK is introduced. Chat is NOT a workflow
 *     audit table, so row-count preservation is sufficient.
 *   - §17.4 Staleness policy — `staleness_policy` column is UNTOUCHED.
 *     Chat continues to use `snapshot-only` with `isStale: false`.
 *   - §17.11 No role exemption — this is a one-time data normalization.
 *     No role (including super-admin) can override or coerce it.
 *
 * down() semantics
 * ----------------
 * Rollback is NON-RESTORATIVE by design. The pre-migration sentinel was
 * documented in Wave 44 HOTFIX-W44-01 as a meaningless placeholder (all-
 * zero UUID is provably not a real project id and carries zero audit
 * signal). A rollback that restored the sentinel onto EVERY
 * post-migration NULL row would ALSO overwrite legitimately-NULL
 * post-BE-W45-01 rows with the sentinel, corrupting forward data.
 *
 * We therefore intentionally leave down() as a no-op with a documented
 * escape hatch: operators who truly need to roll back BE-W45-01 must run
 * the commented UPDATE manually, accepting that they are stamping the
 * sentinel over BOTH legacy NULLs AND any legitimate post-BE NULLs.
 */
export class BackfillAiExecutiveMessagesSentinels1747800000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Note: `deleted_at IS NULL` guard is critical — Wave 44 soft-deleted
    // a handful of rows during hotfix rollout; we MUST NOT resurrect them
    // by mutating their metadata. See §17.3 (audit separation) — soft-
    // deleted rows retain their original values for forensic review.
    const result = await queryRunner.query(`
      UPDATE "ai_executive_messages"
         SET "target_id"   = NULL,
             "target_kind" = NULL
       WHERE "target_id"   = '00000000-0000-0000-0000-000000000000'
         AND "target_kind" = 'project-group'
         AND "endpoint"    = 'executive-chat'
         AND "deleted_at"  IS NULL
       RETURNING id
    `);
    const rowCount = Array.isArray(result) ? result.length : 0;
    // eslint-disable-next-line no-console
    console.log(
      `[DB-W45-01:Option-B] backfilled ${rowCount} legacy sentinel rows to NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Intentional no-op. See header comment "down() semantics".
    //
    // If an operator truly needs to restore the sentinel for rolled-back
    // BE-W45-01 code compatibility, run MANUALLY:
    //
    //   UPDATE "ai_executive_messages"
    //      SET "target_id"   = '00000000-0000-0000-0000-000000000000',
    //          "target_kind" = 'project-group'
    //    WHERE "target_id"   IS NULL
    //      AND "endpoint"    = 'executive-chat'
    //      AND "deleted_at"  IS NULL;
    //
    // The all-zero UUID does NOT FK into any project table (§17.3), so
    // the restored rows remain schema-valid. HOWEVER, this manual rollback
    // OVER-REACHES: it cannot distinguish legacy-sentinel NULLs from
    // legitimate post-BE-W45-01 NULLs, and will stamp the sentinel over
    // both. That is the reason this migration does NOT run it
    // automatically.
    //
    // Silence unused-param lint without executing DDL:
    void queryRunner;
  }
}
