import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: SupplementAssemblyMultiVersionParity
 *
 * Wave wave-supplement-convergence-milestone-3-multi-version / DB-01
 * (2026-05-25).
 *
 * Adds the ONE missing DB-level invariant required to bring
 * `supplement_assembly_versions` to multi-version (v1/v2/v3...) parity
 * with `book_assembly_versions`:
 *
 *   - Partial UNIQUE index `idx_single_completed_per_supplement`
 *     enforces "at most one COMPLETED (non-deprecated) version per
 *     supplement" at the DB layer. Mirrors the main-plan precedent
 *     `idx_single_completed_per_source` declared at
 *     `1743724800000-CreateBookAssemblyTables.ts:121-124` which has
 *     guarded the BookAssembly single-active invariant since W76.
 *
 * Why this gap exists:
 *
 *   The Wave-A init (`1779019200000-SuppStandaloneInit.ts`) shipped
 *   `uniq_sav_supplement_version` on `(development_plan_supplement_id,
 *   version_number)` which guarantees per-supplement monotonic version
 *   numbering (Q8=A / Q9=A) but is silent about HOW MANY versions can
 *   carry `status = 'completed'` at the same time.
 *
 *   The correction wave (`1781300000000-SupplementCorrectionDeprecationColumns`)
 *   added the `deprecated` enum value + `deprecated_at` / `deprecated_by_id`
 *   / `deprecation_reason` columns so the service layer can transition
 *   `completed → deprecated` during correction. The service contract
 *   (`SupplementAssemblyService.correct`, lines 654 / 831) deprecates the
 *   prior `completed` row in the same transaction as inserting the new
 *   `completed` row, so the invariant IS maintained at the application
 *   layer today.
 *
 *   M3 multi-version exercises that path repeatedly (v1 → v2 → v3 ...);
 *   any service-layer bug or future code path that forgets to flip the
 *   prior `completed` row to `deprecated` would silently leave TWO
 *   active versions per supplement and break every read site that
 *   resolves "the current version" via `WHERE status = 'completed'`
 *   (pdf renderers, version-card DTOs, FE selector). A DB-level partial
 *   UNIQUE is the belt-and-braces guarantee that mirrors how main-plan
 *   shipped this invariant from day one.
 *
 * Schema delta:
 *
 *   supplement_assembly_versions:
 *     + idx_single_completed_per_supplement (PARTIAL UNIQUE)
 *         (development_plan_supplement_id)
 *         WHERE status = 'completed'
 *
 * No table / column / enum changes. No backfill required (see §3).
 *
 * Critical invariants preserved:
 *
 *   - CLAUDE.md §15 — additive-only index add. No row is rewritten;
 *     no enum value is added; no FK is altered. Pre-existing rows
 *     trivially satisfy the constraint (current live state: 1 booked
 *     supplement × 1 version row with status='completed' per probe
 *     in task brief).
 *
 *   - CLAUDE.md §17.3 — no `ai_*` table touched. AI snapshot rows
 *     reference book artifacts by UUID without FK and are unaffected.
 *
 *   - CLAUDE.md §18 / §18.2.1 SUPPLEMENT finalize trigger — orphan
 *     cleanup cascade contract untouched. Finalize already deprecates
 *     the prior version inside the same transaction, so the index
 *     never blocks a legitimate finalize.
 *
 *   - CLAUDE.md §20 parity — supplement now carries the same
 *     "single-active completed per source" guarantee that book_assembly
 *     has had since W76. Future multi-version waves (M4+) inherit the
 *     guarantee transitively.
 *
 *   - Q3=B (PLAN.md) — separate index name from main-plan
 *     (`idx_single_completed_per_supplement` vs
 *     `idx_single_completed_per_source`). Index is local to the
 *     supplement table; no cross-table coupling.
 *
 * Backfill:
 *
 *   - Audit query before index creation:
 *
 *       SELECT development_plan_supplement_id, COUNT(*)
 *       FROM supplement_assembly_versions
 *       WHERE status = 'completed'
 *       GROUP BY development_plan_supplement_id
 *       HAVING COUNT(*) > 1;
 *
 *     Expected: zero rows (Wave-A invariant maintained at app layer).
 *     If non-zero, the CREATE UNIQUE INDEX will fail with detail
 *     "Key (development_plan_supplement_id)=(...) is duplicated" and
 *     the operator MUST resolve manually before retry — DO NOT auto-
 *     deprecate stale rows from a migration.
 *
 * Idempotency:
 *
 *   - `CREATE UNIQUE INDEX IF NOT EXISTS` keeps the up safe to re-run.
 *   - `DROP INDEX IF EXISTS` keeps the down safe to re-run.
 *
 * Backend interaction:
 *
 *   - `synchronize: true` does NOT create partial indexes from entity
 *     metadata (TypeORM has no decorator for PARTIAL UNIQUE). This
 *     migration MUST be run explicitly before BE-01 lands multi-
 *     version finalize / correction logic that depends on the
 *     invariant.
 *
 *   - Existing service paths (`SupplementAssemblyService.correct` at
 *     line 654 / 831, `finalize` at line 1743) already perform the
 *     deprecate-prior-then-insert-next sequence inside a single
 *     transaction, so existing code remains correct under the new
 *     index. No service change required for this migration.
 */
export class SupplementAssemblyMultiVersionParity1781500000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Pre-flight audit — fail-loud if any supplement carries >1
    // completed version today. Running the audit in the same
    // transaction as the index creation means a duplicate-finding
    // raised below rolls back cleanly with a clear error message.
    const duplicates: Array<{
      development_plan_supplement_id: string;
      count: string;
    }> = await queryRunner.query(`
      SELECT "development_plan_supplement_id", COUNT(*)::text AS count
        FROM "supplement_assembly_versions"
       WHERE "status" = 'completed'
       GROUP BY "development_plan_supplement_id"
      HAVING COUNT(*) > 1;
    `);

    if (duplicates.length > 0) {
      const detail = duplicates
        .map(
          (row) =>
            `  - supplement=${row.development_plan_supplement_id} count=${row.count}`,
        )
        .join('\n');
      throw new Error(
        `SupplementAssemblyMultiVersionParity1781500000000: ` +
          `cannot create unique index — ${duplicates.length} supplement(s) ` +
          `already carry >1 completed version. Resolve manually before retry.\n` +
          detail,
      );
    }

    // Single-active invariant — mirror of main-plan's
    // idx_single_completed_per_source. NOTE: this is a SEPARATE index
    // from `uniq_sav_supplement_version` — the latter scopes per
    // version_number (monotonic numbering), the former scopes per
    // status (single-active).
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        "idx_single_completed_per_supplement"
        ON "supplement_assembly_versions"
        ("development_plan_supplement_id")
       WHERE "status" = 'completed';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_single_completed_per_supplement";
    `);
  }
}
