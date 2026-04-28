import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: PrevProjectIdToUuid — Wave 57 W57-DB-01.
 *
 * Converts `revised_project_groups.prev_project_id` from `varchar` to
 * `uuid`. The column was originally declared on the entity without a
 * `type:` annotation, which caused TypeORM (with `synchronize: true`)
 * to materialise it as `character varying`. The Wave 57 unified
 * project aggregator anti-joins the column against `pg.id` / `rpg.id`
 * (both `uuid`), and Postgres rejects the comparison
 * (`operator does not exist: character varying = uuid`) without a
 * cast. A 2026-04-25 hotfix introduced inline `::uuid` casts at both
 * anti-join sites to unblock the merge; this migration removes the
 * type mismatch at the source so the casts can be deleted.
 *
 * §14 lineage immutability: column SEMANTICS are unchanged — only the
 * Postgres column type is reconciled to match the upstream `uuid`
 * primary keys it references logically. No row data is mutated; the
 * `USING prev_project_id::uuid` clause performs an in-place type
 * coercion of every existing non-null value.
 *
 * §12 audit rule: this migration MUST NOT delete any data. To honor
 * that, the `up` step prechecks that EVERY non-null `prev_project_id`
 * value is a syntactically valid UUID before issuing the ALTER. If
 * any row fails the regex test, the migration aborts loudly with the
 * offending row id surfaced — operators can then triage manually
 * (legacy seed bug, partial backfill, etc.) without losing audit data.
 *
 * Index preservation: there is no current index that names
 * `prev_project_id` exclusively (lineage detection per §14.7 uses the
 * composite `(prev_project_id, prev_project_type)`). Postgres
 * preserves indexes across `ALTER COLUMN ... TYPE` when the USING
 * clause is a direct cast (no rewrite of the predicate), so any
 * existing index survives automatically. No DROP/RECREATE is needed.
 *
 * Reversibility: the `down` step reverses to `varchar` using a plain
 * cast — UUIDs round-trip through varchar losslessly.
 *
 * Online-migration note: at current dev / pilot row counts (< 1M)
 * this ALTER is fast (sub-second). For prod-sized tables coordinate a
 * brief lock window; the rewrite is a single-pass type coercion.
 */
export class PrevProjectIdToUuid1748200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Idempotency guard: skip if already uuid. ─────────────────────
    // Reading information_schema avoids erroring on a re-run after a
    // partial deploy, and prevents us from running the precheck against
    // a column that no longer needs converting.
    const rows: { data_type: string }[] = await queryRunner.query(`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_name = 'revised_project_groups'
        AND column_name = 'prev_project_id'
    `);
    if (rows.length === 0) {
      throw new Error(
        'PrevProjectIdToUuid: column revised_project_groups.prev_project_id not found',
      );
    }
    if (rows[0].data_type === 'uuid') {
      // Already converted (e.g. a prior partial run, or
      // `synchronize: true` post-entity-edit). No-op.
      return;
    }

    // ── Precheck: every non-null value must be a valid UUID. ─────────
    // Audit rule (§12): we MUST NOT silently drop or rewrite data. If
    // a legacy row carries a non-UUID string, fail the migration so the
    // operator can investigate. The regex matches the canonical 8-4-4-
    // 4-12 hex form (case-insensitive), which is what `uuid_generate_v4`
    // and TypeORM's `@PrimaryGeneratedColumn('uuid')` emit.
    const offenders: { id: string; prev_project_id: string }[] =
      await queryRunner.query(`
        SELECT id, prev_project_id
        FROM revised_project_groups
        WHERE prev_project_id IS NOT NULL
          AND prev_project_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        LIMIT 5
      `);
    if (offenders.length > 0) {
      const summary = offenders
        .map((r) => `${r.id} -> "${r.prev_project_id}"`)
        .join('; ');
      throw new Error(
        `PrevProjectIdToUuid: refusing to migrate — non-UUID prev_project_id detected. ` +
          `Offending rows (id -> value): ${summary}. Resolve the data manually before re-running.`,
      );
    }

    // ── Type coercion. ──────────────────────────────────────────────
    // `USING prev_project_id::uuid` performs the per-row cast. NULLs
    // pass through unchanged. Composite indexes that include this
    // column survive Postgres' in-place rewrite — the operator class
    // (`uuid_ops`) is compatible with a column whose previously-stored
    // varchar values were already syntactically UUIDs (verified above).
    await queryRunner.query(`
      ALTER TABLE "revised_project_groups"
        ALTER COLUMN "prev_project_id" TYPE uuid
        USING "prev_project_id"::uuid;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // ── Idempotency guard for revert. ────────────────────────────────
    const rows: { data_type: string }[] = await queryRunner.query(`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_name = 'revised_project_groups'
        AND column_name = 'prev_project_id'
    `);
    if (rows.length === 0 || rows[0].data_type !== 'uuid') {
      // Already varchar or column missing — nothing to reverse.
      return;
    }

    // UUIDs cast losslessly to text/varchar. No data risk.
    await queryRunner.query(`
      ALTER TABLE "revised_project_groups"
        ALTER COLUMN "prev_project_id" TYPE varchar
        USING "prev_project_id"::text;
    `);
  }
}
