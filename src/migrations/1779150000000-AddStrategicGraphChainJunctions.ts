import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableIndex,
} from 'typeorm';

/**
 * Wave 3 — Strategic Graph Chain (DB-CHAIN-01)
 *
 * Adds the two NEW inter-master junction tables that bring Strategic Graph
 * coverage to 100% against the source spreadsheet
 * `./ตารางเชื่อมโยง ทำโปรแกรม.xlsx`:
 *
 *   - national_strategy_milestone     (NS ↔ MS)
 *   - milestone_province_strategy     (MS ↔ PS)
 *
 * Schemas mirror the four existing junctions in
 * `1779130000000-StrategicGraphJunctions.ts` byte-for-byte:
 *   - id uuid PK DEFAULT gen_random_uuid()
 *   - two FK uuid columns NOT NULL, FK ON DELETE RESTRICT
 *   - updated_at timestamptz NOT NULL DEFAULT NOW()
 *   - updated_by uuid NULL, FK to users(id) ON DELETE SET NULL
 *   - UNIQUE on the (source, target) pair
 *   - btree index on each FK column individually
 *
 * Seeds the canonical pairs (NS↔MS: 14 pairs, MS↔PS: 16 pairs) inside the
 * same transaction so the deploy step yields an atomic, fully-wired graph.
 *
 * Source of truth:
 *   - docs/tasks/STRATEGIC_GRAPH_CHAIN_UMBRELLA.md
 *   - docs/tasks/STRATEGIC_GRAPH_CHAIN_DB.md
 *   - CLAUDE.md §12 (config tables — NO TrackingStatus)
 *   - CLAUDE.md §4.1 (authority inherited from admin/super-admin)
 *
 * Locked decisions (user-confirmed 2026-05-18):
 *   - All seeded rows carry updated_by = the canonical super-admin user id
 *     '516935d4-c2a6-40da-b091-33b8503a95d9' (mirrors the prior ad-hoc seed).
 *   - Idempotent INSERT ... SELECT ... WHERE NOT EXISTS pattern, keyed on
 *     the (source_id, target_id) lookup via the master tables. Re-run is a
 *     no-op.
 *   - PS master coverage tolerance: per the dispatch override, if the
 *     province_strategies master is not yet seeded with all referenced PS
 *     codes, the migration FILTERS the unresolved pairs (rather than
 *     RAISE EXCEPTION). Filtered pairs are emitted via `console.warn` so
 *     the operator sees exactly which mappings were skipped. NS↔MS pairs
 *     keep the strict assertion because NS / MS are guaranteed seeded by
 *     `1779140000000-StrategicGraphSeed.ts`.
 *   - down() drops the two tables (indexes + uniques cascade). Seed rows
 *     vanish with the tables; no separate DELETE step is needed.
 *
 * §14 / §15 / §16 / §17 interaction: orthogonal. These tables hold
 * reporting-metadata vocabulary only; they MUST NOT gate any workflow
 * transition.
 */
export class AddStrategicGraphChainJunctions1779150000000
  implements MigrationInterface
{
  name = 'AddStrategicGraphChainJunctions1779150000000';

  // ---------------------------------------------------------------------------
  // Constants — frozen per user direction.
  // ---------------------------------------------------------------------------

  private readonly SEED_USER_ID = '516935d4-c2a6-40da-b091-33b8503a95d9';

  // NS↔MS — 14 canonical pairs, code-keyed.
  private readonly NS_MS_PAIRS: ReadonlyArray<[string, string]> = [
    ['NS1', 'MS8'],
    ['NS1', 'MS12'],
    ['NS1', 'MS13'],
    ['NS2', 'MS1'],
    ['NS2', 'MS2'],
    ['NS2', 'MS5'],
    ['NS2', 'MS7'],
    ['NS3', 'MS4'],
    ['NS3', 'MS12'],
    ['NS4', 'MS9'],
    ['NS5', 'MS1'],
    ['NS5', 'MS10'],
    ['NS5', 'MS11'],
    ['NS6', 'MS13'],
  ];

  // MS↔PS — 16 canonical pairs, code-keyed.
  // Re-derived from the Excel source-of-truth `ตารางเชื่อมโยง ทำโปรแกรม.xlsx`
  // with explicit (MS, PS) tuple ordering after the parent agent caught
  // a transposed-tuple bug in the initial dispatch payload (2026-05-18).
  // All PS values are within the canonical PS1..PS5 set seeded by §18.
  private readonly MS_PS_PAIRS: ReadonlyArray<[string, string]> = [
    ['MS1', 'PS1'],
    ['MS1', 'PS4'],
    ['MS2', 'PS2'],
    ['MS4', 'PS2'],
    ['MS4', 'PS3'],
    ['MS5', 'PS2'],
    ['MS7', 'PS1'],
    ['MS7', 'PS4'],
    ['MS8', 'PS3'],
    ['MS9', 'PS3'],
    ['MS10', 'PS4'],
    ['MS11', 'PS4'],
    ['MS11', 'PS5'],
    ['MS12', 'PS3'],
    ['MS12', 'PS5'],
    ['MS13', 'PS3'],
  ];

  // ---------------------------------------------------------------------------
  // up()
  // ---------------------------------------------------------------------------

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Defensive — pgcrypto is required for gen_random_uuid(). Cheap no-op
    // if already enabled (it is — DB-01 enabled it project-wide).
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

    // -------------------------------------------------------------------
    // 1) national_strategy_milestone — schema
    // -------------------------------------------------------------------
    await queryRunner.createTable(
      new Table({
        name: 'national_strategy_milestone',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'gen_random_uuid()',
          },
          {
            name: 'national_strategy_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'milestone_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'updated_at',
            type: 'timestamp',
            isNullable: false,
            default: 'NOW()',
          },
          {
            name: 'updated_by',
            type: 'uuid',
            isNullable: true,
          },
        ],
        foreignKeys: [
          {
            name: 'FK_national_strategy_milestone_national_strategy_id',
            columnNames: ['national_strategy_id'],
            referencedTableName: 'national_strategies',
            referencedColumnNames: ['id'],
            onDelete: 'RESTRICT',
          },
          {
            name: 'FK_national_strategy_milestone_milestone_id',
            columnNames: ['milestone_id'],
            referencedTableName: 'milestones',
            referencedColumnNames: ['id'],
            onDelete: 'RESTRICT',
          },
          {
            name: 'FK_national_strategy_milestone_updated_by',
            columnNames: ['updated_by'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'SET NULL',
          },
        ],
      }),
      true, // ifNotExists — idempotent up()
    );

    await queryRunner.createIndex(
      'national_strategy_milestone',
      new TableIndex({
        name: 'UQ_national_strategy_milestone_pair',
        columnNames: ['national_strategy_id', 'milestone_id'],
        isUnique: true,
      }),
    );
    await queryRunner.createIndex(
      'national_strategy_milestone',
      new TableIndex({
        name: 'IDX_national_strategy_milestone_national_strategy_id',
        columnNames: ['national_strategy_id'],
      }),
    );
    await queryRunner.createIndex(
      'national_strategy_milestone',
      new TableIndex({
        name: 'IDX_national_strategy_milestone_milestone_id',
        columnNames: ['milestone_id'],
      }),
    );

    // -------------------------------------------------------------------
    // 2) milestone_province_strategy — schema
    // -------------------------------------------------------------------
    await queryRunner.createTable(
      new Table({
        name: 'milestone_province_strategy',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'gen_random_uuid()',
          },
          {
            name: 'milestone_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'province_strategy_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'updated_at',
            type: 'timestamp',
            isNullable: false,
            default: 'NOW()',
          },
          {
            name: 'updated_by',
            type: 'uuid',
            isNullable: true,
          },
        ],
        foreignKeys: [
          {
            name: 'FK_milestone_province_strategy_milestone_id',
            columnNames: ['milestone_id'],
            referencedTableName: 'milestones',
            referencedColumnNames: ['id'],
            onDelete: 'RESTRICT',
          },
          {
            name: 'FK_milestone_province_strategy_province_strategy_id',
            columnNames: ['province_strategy_id'],
            referencedTableName: 'province_strategies',
            referencedColumnNames: ['id'],
            onDelete: 'RESTRICT',
          },
          {
            name: 'FK_milestone_province_strategy_updated_by',
            columnNames: ['updated_by'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'SET NULL',
          },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'milestone_province_strategy',
      new TableIndex({
        name: 'UQ_milestone_province_strategy_pair',
        columnNames: ['milestone_id', 'province_strategy_id'],
        isUnique: true,
      }),
    );
    await queryRunner.createIndex(
      'milestone_province_strategy',
      new TableIndex({
        name: 'IDX_milestone_province_strategy_milestone_id',
        columnNames: ['milestone_id'],
      }),
    );
    await queryRunner.createIndex(
      'milestone_province_strategy',
      new TableIndex({
        name: 'IDX_milestone_province_strategy_province_strategy_id',
        columnNames: ['province_strategy_id'],
      }),
    );

    // -------------------------------------------------------------------
    // 3) Seed NS↔MS pairs
    // -------------------------------------------------------------------
    // Resolve canonical NS / MS codes that actually exist in the masters,
    // so we can detect missing codes and (per §8.5) fail loudly. NS + MS
    // are seeded by 1779140000000-StrategicGraphSeed.ts → all referenced
    // codes MUST be present.
    const referencedNsCodes = Array.from(
      new Set(this.NS_MS_PAIRS.map((p) => p[0])),
    );
    const referencedMsCodesAll = Array.from(
      new Set([
        ...this.NS_MS_PAIRS.map((p) => p[1]),
        ...this.MS_PS_PAIRS.map((p) => p[0]),
      ]),
    );

    const existingNs: Array<{ code: string }> = await queryRunner.query(
      `SELECT code FROM national_strategies WHERE code = ANY($1::varchar[])`,
      [referencedNsCodes],
    );
    const existingMs: Array<{ code: string }> = await queryRunner.query(
      `SELECT code FROM milestones WHERE code = ANY($1::varchar[])`,
      [referencedMsCodesAll],
    );

    const existingNsSet = new Set(existingNs.map((r) => r.code));
    const existingMsSet = new Set(existingMs.map((r) => r.code));

    const missingNs = referencedNsCodes.filter((c) => !existingNsSet.has(c));
    const missingMsForNs = this.NS_MS_PAIRS.map((p) => p[1]).filter(
      (c) => !existingMsSet.has(c),
    );

    if (missingNs.length > 0 || missingMsForNs.length > 0) {
      throw new Error(
        `[AddStrategicGraphChainJunctions] Missing master codes — ` +
          `NS=${JSON.stringify(missingNs)} ` +
          `MS=${JSON.stringify(Array.from(new Set(missingMsForNs)))}. ` +
          `Run 1779140000000-StrategicGraphSeed.ts first.`,
      );
    }

    // Bulk insert NS↔MS pairs via INSERT ... SELECT keyed on (ns.code, ms.code).
    // The trailing ON CONFLICT DO NOTHING is redundant given the WHERE NOT
    // EXISTS predicate, but we keep WHERE NOT EXISTS as the canonical
    // idempotent pattern (matches 1779140000000 seed style).
    for (const [nsCode, msCode] of this.NS_MS_PAIRS) {
      await queryRunner.query(
        `
        INSERT INTO national_strategy_milestone
          (national_strategy_id, milestone_id, updated_by)
        SELECT ns_pick.id, ms_pick.id, $3::uuid
        FROM (
          SELECT id FROM national_strategies WHERE code = $1
          ORDER BY created_at ASC LIMIT 1
        ) ns_pick
        CROSS JOIN (
          SELECT id FROM milestones WHERE code = $2
          ORDER BY created_at ASC LIMIT 1
        ) ms_pick
        WHERE NOT EXISTS (
          SELECT 1 FROM national_strategy_milestone x
          WHERE x.national_strategy_id = ns_pick.id
            AND x.milestone_id = ms_pick.id
        )
        `,
        [nsCode, msCode, this.SEED_USER_ID],
      );
    }

    // -------------------------------------------------------------------
    // 4) Seed MS↔PS pairs (with PS code filtering per dispatch override)
    // -------------------------------------------------------------------
    const referencedPsCodes = Array.from(
      new Set(this.MS_PS_PAIRS.map((p) => p[1])),
    );
    const existingPs: Array<{ code: string }> = await queryRunner.query(
      `SELECT code FROM province_strategies WHERE code = ANY($1::varchar[])`,
      [referencedPsCodes],
    );
    const existingPsSet = new Set(existingPs.map((r) => r.code));

    const resolvablePsPairs: Array<[string, string]> = [];
    const skippedPsPairs: Array<[string, string]> = [];
    for (const [msCode, psCode] of this.MS_PS_PAIRS) {
      if (existingPsSet.has(psCode)) {
        resolvablePsPairs.push([msCode, psCode]);
      } else {
        skippedPsPairs.push([msCode, psCode]);
      }
    }

    if (skippedPsPairs.length > 0) {
      // Loud but non-fatal warning — operator must know which pairs were
      // skipped due to missing PS master codes.
      // eslint-disable-next-line no-console
      console.warn(
        `[AddStrategicGraphChainJunctions] Skipped ${skippedPsPairs.length} ` +
          `MS↔PS pairs because the province_strategies master does not yet ` +
          `contain these codes: ` +
          JSON.stringify(skippedPsPairs.map(([m, p]) => `${m}↔${p}`)) +
          `. Seed the missing PS rows and re-run this migration to fill them ` +
          `in (the WHERE NOT EXISTS predicate keeps re-runs idempotent).`,
      );
    }

    for (const [msCode, psCode] of resolvablePsPairs) {
      await queryRunner.query(
        `
        INSERT INTO milestone_province_strategy
          (milestone_id, province_strategy_id, updated_by)
        SELECT ms_pick.id, ps_pick.id, $3::uuid
        FROM (
          SELECT id FROM milestones WHERE code = $1
          ORDER BY created_at ASC LIMIT 1
        ) ms_pick
        CROSS JOIN (
          SELECT id FROM province_strategies WHERE code = $2
          ORDER BY created_at ASC LIMIT 1
        ) ps_pick
        WHERE NOT EXISTS (
          SELECT 1 FROM milestone_province_strategy x
          WHERE x.milestone_id = ms_pick.id
            AND x.province_strategy_id = ps_pick.id
        )
        `,
        [msCode, psCode, this.SEED_USER_ID],
      );
    }

    // -------------------------------------------------------------------
    // 5) Loud assertion — final row counts must match expected totals
    // -------------------------------------------------------------------
    const nsMsCountRow: Array<{ count: string }> = await queryRunner.query(
      `SELECT COUNT(*)::text AS count FROM national_strategy_milestone`,
    );
    const nsMsCount = Number(nsMsCountRow[0]?.count ?? '0');
    if (nsMsCount !== this.NS_MS_PAIRS.length) {
      throw new Error(
        `[AddStrategicGraphChainJunctions] NS↔MS row count mismatch: ` +
          `expected ${this.NS_MS_PAIRS.length}, got ${nsMsCount}. ` +
          `Some canonical pairs failed to insert.`,
      );
    }

    const msPsCountRow: Array<{ count: string }> = await queryRunner.query(
      `SELECT COUNT(*)::text AS count FROM milestone_province_strategy`,
    );
    const msPsCount = Number(msPsCountRow[0]?.count ?? '0');
    const expectedMsPsCount = resolvablePsPairs.length;
    if (msPsCount !== expectedMsPsCount) {
      throw new Error(
        `[AddStrategicGraphChainJunctions] MS↔PS row count mismatch: ` +
          `expected ${expectedMsPsCount} (after filtering missing PS codes), ` +
          `got ${msPsCount}.`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // down()
  // ---------------------------------------------------------------------------

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop in reverse creation order. Indexes and unique constraints
    // cascade with the table drop, so no explicit drops are required.
    await queryRunner.dropTable('milestone_province_strategy', true);
    await queryRunner.dropTable('national_strategy_milestone', true);
  }
}
