import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: SuppAiWidenTargetKind — SUPP_AI_DB_01.
 *
 * Defensively widens the shared Postgres enum `ai_target_kind` (created
 * by `1745366400000-CreateAiResultFoundation`) to include the value
 * `'supplement-project-group'`.
 *
 * Why this migration is shipped
 * -----------------------------
 * The foundation migration `1745366400000-CreateAiResultFoundation` already
 * declared `ai_target_kind` with all three values from day one:
 *
 *   ('project-group', 'revised-project-group', 'supplement-project-group')
 *
 * On every environment where that foundation migration ran successfully,
 * this widening migration is a NO-OP (the value already exists). It is
 * shipped explicitly for two legacy-defence reasons:
 *
 *   1. Some long-running environments may have been built via TypeORM
 *      `synchronize: true` before the foundation migration was wired,
 *      which could have created the enum with only the two pre-supplement
 *      values. The idempotent `ADD VALUE IF NOT EXISTS` converges those
 *      databases to the canonical three-value shape.
 *
 *   2. Future maintainers reading the SUPP_AI wave plan see an explicit
 *      DB step rather than having to trace the value through an older
 *      foundation migration — preserves the audit trail of intent.
 *
 * Schema investigation (recorded at time of authoring SUPP_AI_DB_01):
 *
 *   - `ai_pre_submit_snapshots.target_kind` — typed as Postgres ENUM
 *     `ai_target_kind` via the shared base `AbstractAiResult` entity
 *     (`enumName: 'ai_target_kind'`). Entity `enum: [...]` array ALREADY
 *     contains `'supplement-project-group'`.
 *   - `ai_staff_review_runs.target_kind` (actual table name in this
 *     codebase — the task spec called it `ai_staff_review_snapshots`
 *     but the entity class `AiStaffReviewRun` maps to
 *     `@Entity('ai_staff_review_runs')`) — same shared Postgres enum
 *     `ai_target_kind`. Entity `enum: [...]` array ALREADY contains
 *     `'supplement-project-group'`.
 *   - `ai_executive_messages.target_kind` — same shared enum
 *     `ai_target_kind`. Inherited via `AbstractAiResult`.
 *
 * Because all three tables share the SAME Postgres enum type, ONE
 * `ALTER TYPE ai_target_kind ADD VALUE IF NOT EXISTS
 * 'supplement-project-group'` widens every dependent column atomically.
 *
 * `AttachmentKind` (the TS type alias in
 * `backend/src/document-analysis/document-analysis.service.ts` line 63)
 * is a backend TS type, NOT a database column. Each attachment kind lives
 * in its own physical table (`attachment_project_groups`,
 * `attachment_revised_project_groups`,
 * `attachment_supplement_project_groups`); there is NO `target_kind`
 * discriminator column on the attachment tables, so no DB widening is
 * required for `AttachmentKind`. The TS union widening for that type is
 * owned by SUPP_AI_BE_01 / SUPP_AI_FE_01 — explicitly out of scope here.
 *
 * Postgres caveat — non-transactional ALTER TYPE
 * ----------------------------------------------
 * Postgres requires `ALTER TYPE … ADD VALUE` to run OUTSIDE a transaction
 * block (it is a catalog-level operation that affects pg_enum). TypeORM's
 * migration runner wraps `up()` in a transaction by default, so we must
 * temporarily commit and reopen the transaction around the statement.
 * Mirrors the pattern documented in the project for analogous enum-widening
 * migrations.
 *
 * `IF NOT EXISTS` requires Postgres ≥ 12, which the project already targets
 * (production runs Postgres 14+).
 *
 * Down migration
 * --------------
 * Postgres does NOT support removing a value from an enum without
 * rewriting the type and rebinding every dependent column. The unused
 * enum value is harmless, so the down migration is intentionally a no-op
 * (forward-only). This follows the established convention in the codebase
 * for additive enum widening.
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
export class SuppAiWidenTargetKind1780000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // `ALTER TYPE … ADD VALUE` cannot run inside a transaction block.
    // The default TypeORM migration wrapper opens one for us — commit
    // it first, run the ALTER, then re-open so any subsequent statements
    // (or the migration tracking row write) still land inside a tx.
    await queryRunner.commitTransaction();
    try {
      await queryRunner.query(
        `ALTER TYPE "ai_target_kind" ADD VALUE IF NOT EXISTS 'supplement-project-group';`,
      );
    } finally {
      await queryRunner.startTransaction();
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Intentionally a no-op.
    //
    // Postgres does not support removing an enum value without rewriting
    // the type and rebinding every dependent column. The added value
    // `'supplement-project-group'` is harmless when unused. If a true
    // rollback is ever required, the operator must:
    //
    //   1. Backfill / soft-delete every ai_* row that uses the value.
    //   2. CREATE TYPE ai_target_kind_old AS ENUM (
    //        'project-group', 'revised-project-group'
    //      );
    //   3. ALTER every column of type ai_target_kind to ai_target_kind_old
    //      USING (target_kind::text::ai_target_kind_old).
    //   4. DROP TYPE ai_target_kind; ALTER TYPE ai_target_kind_old
    //      RENAME TO ai_target_kind;
    //
    // That sequence is destructive (cannot retain SPG rows) and outside
    // the safe-by-default down-migration contract, so we ship a no-op.
  }
}
