import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: WidenPrevProjectTypeForSupplement — Wave SUPP-4 DB-01.
 *
 * Adds the value `'supplement'` to the Postgres native enum that backs
 * `revised_project_groups.prev_project_type`. After this migration the
 * enum contains the labels `{'original', 'revised', 'supplement'}`.
 *
 * Business purpose:
 *   The Wave SUPP-4 fork path (BE-01) introduces RevisedProjectGroup
 *   rows whose lineage parent is a SupplementProjectGroup. Those rows
 *   carry `prev_project_type = 'supplement'`. Without the enum widen,
 *   BE-01's INSERT would fail with `invalid input value for enum
 *   revised_project_groups_prev_project_type_enum: "supplement"`. This
 *   migration MUST land before BE-01 deploys.
 *
 * Source of truth:
 *   - CLAUDE.md §11 Versioning Rule — RPG is the only versioning object;
 *     original / parent rows preserved.
 *   - CLAUDE.md §12 Audit Rule — zero data mutation, all rows preserved.
 *   - CLAUDE.md §14 Version Lineage Immutability — the column is the
 *     authoritative descendant FK; lookup pattern in §14.7 continues to
 *     work post-widen against the new label.
 *   - docs/tasks/wave-supp-4-fork-supplement/DB-01.md (this task).
 *   - docs/workflow-add-project-supplement.md §0 (year-1.5 supplement →
 *     year-2 RPG fork via `prev_project_type='supplement'`).
 *
 * §14 lineage immutability:
 *   Column SEMANTICS unchanged — only a new label is registered. The
 *   §14.7 reference query
 *     SELECT 1 FROM revised_project_groups
 *     WHERE prev_project_id = $1
 *       AND prev_project_type = 'supplement'
 *       AND deleted_at IS NULL
 *     LIMIT 1
 *   becomes legal AS-IS after this migration; no schema rewrite of
 *   LineageLockService SQL is required.
 *
 * Index decision:
 *   The existing partial index `idx_rpg_prev_project_id` on
 *   `(prev_project_id) WHERE deleted_at IS NULL` (created in
 *   `1744502400000-AddPrevProjectIdPartialIndex.ts`) already covers the
 *   lookup path that the new `'supplement'` value will use. The label
 *   does not affect index selection — Postgres uses the same B-tree on
 *   `prev_project_id` regardless of which enum value the row carries.
 *   Therefore NO new index is added by this migration (matches DB-01
 *   §4 Out of Scope).
 *
 * Idempotency:
 *   `ADD VALUE IF NOT EXISTS` is a no-op when the label already exists,
 *   so re-running the migration on an environment that received a
 *   manual hotfix (or a dev DB where TypeORM `synchronize: true`
 *   auto-widened after BE-01's TS enum edit) is safe.
 *
 * Postgres version requirement:
 *   `ALTER TYPE ... ADD VALUE IF NOT EXISTS` requires PG ≥ 9.6.
 *   `ALTER TYPE ... ADD VALUE` is transaction-safe since PG 12. Target
 *   deployment is PG 17.4 (confirmed 2026-05-24), so the migration
 *   runner's default transactional wrapper is fine; no
 *   `runInTransaction = false` override needed.
 *
 * Zero data mutation:
 *   No UPDATE, no DELETE, no row rewrite. The on-disk representation
 *   of existing 'original' / 'revised' rows is unchanged — the new
 *   label is appended to the type's value list only.
 *
 * IRREVERSIBLE:
 *   Postgres does not provide `ALTER TYPE ... DROP VALUE`. Reverting
 *   would require a full type-rebuild dance (RENAME old type, CREATE
 *   new type without the label, ALTER COLUMN ... USING ::text::newtype,
 *   DROP TYPE old). That dance is unsafe once any production row uses
 *   the new value. The `down()` below therefore throws loudly so an
 *   accidental rollback fails fast.
 */
export class WidenPrevProjectTypeForSupplement1780200000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Idempotency: ADD VALUE IF NOT EXISTS is a no-op when 'supplement'
    // is already a label of the enum type. Safe to re-run.
    await queryRunner.query(
      `ALTER TYPE "revised_project_groups_prev_project_type_enum" ADD VALUE IF NOT EXISTS 'supplement'`,
    );
  }

  // IRREVERSIBLE — see header comment for rationale.
  public async down(): Promise<void> {
    throw new Error(
      "DB-01 down(): Postgres does not support removing enum values. " +
        "To roll back, restore from snapshot or manually rebuild the type via " +
        "DROP TYPE / CREATE TYPE / column re-cast.",
    );
  }
}
