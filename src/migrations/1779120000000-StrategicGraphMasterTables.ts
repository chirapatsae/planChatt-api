import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Wave 1 — Strategic Graph (DB-01)
 *
 * Creates the four EXTERNAL strategic-alignment master tables:
 *   - national_strategies
 *   - sdgs
 *   - milestones
 *   - province_strategies
 *
 * Source of truth:
 *   - docs/tasks/STRATEGIC_GRAPH_UMBRELLA.md   (§3 scope, §8 DB requirements)
 *   - docs/tasks/STRATEGIC_GRAPH_DB-01_master_tables.md
 *   - CLAUDE.md §10 (scope binding), §12 (audit — these are MASTER/CONFIG
 *     data and do NOT create TrackingStatus rows)
 *
 * Locked decisions (user-confirmed 2026-05-18):
 *   - All four tables share an identical column shape.
 *   - UUID primary key (`gen_random_uuid()`) — consistent with the majority
 *     of existing entities. Requires the `pgcrypto` extension (already
 *     enabled project-wide for other UUID columns).
 *   - `is_active boolean NOT NULL DEFAULT true` is the canonical "soft
 *     remove" flag. Junction tables in DB-02 / DB-03 will reference these
 *     rows via `ON DELETE RESTRICT`, so hard-delete is gated by the
 *     absence of mappings; routine deactivation flips `is_active`.
 *   - `deleted_at TIMESTAMP NULL` is included for TypeORM
 *     `@DeleteDateColumn` compatibility (mirrors `plans`, `users`, etc.).
 *   - Index on `code` per task DB-01 §8 (nullable but indexed for lookup)
 *     plus a secondary index on `is_active` so list endpoints can filter
 *     cheaply.
 *   - NO foreign keys are declared here — these tables are FK *targets*.
 *     The eight junction tables landing in DB-02 / DB-03 will point at
 *     these rows.
 *
 * §16 / §17 interaction: orthogonal. These tables hold reporting-metadata
 * vocabulary only; they MUST NOT gate any workflow transition.
 */
export class StrategicGraphMasterTables1779120000000
  implements MigrationInterface
{
  name = 'StrategicGraphMasterTables1779120000000';

  // Four master tables, identical shape. Kept as a const so `up` and
  // `down` cannot drift.
  private readonly TABLE_NAMES = [
    'national_strategies',
    'sdgs',
    'milestones',
    'province_strategies',
  ] as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Defensive: ensure pgcrypto is available for gen_random_uuid().
    // No-op on databases where the extension already exists.
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

    for (const tableName of this.TABLE_NAMES) {
      await queryRunner.createTable(
        new Table({
          name: tableName,
          columns: [
            {
              name: 'id',
              type: 'uuid',
              isPrimary: true,
              default: 'gen_random_uuid()',
            },
            {
              name: 'code',
              type: 'varchar',
              length: '64',
              isNullable: true,
            },
            {
              name: 'name_th',
              type: 'varchar',
              length: '500',
              isNullable: false,
            },
            {
              name: 'name_en',
              type: 'varchar',
              length: '255',
              isNullable: true,
            },
            {
              name: 'description',
              type: 'text',
              isNullable: true,
            },
            {
              name: 'is_active',
              type: 'boolean',
              isNullable: false,
              default: true,
            },
            {
              name: 'created_at',
              type: 'timestamp',
              isNullable: false,
              default: 'NOW()',
            },
            {
              name: 'updated_at',
              type: 'timestamp',
              isNullable: false,
              default: 'NOW()',
            },
            {
              name: 'deleted_at',
              type: 'timestamp',
              isNullable: true,
            },
          ],
        }),
        true, // ifNotExists — idempotent up()
      );

      // Lookup index on the optional `code` column (DB-01 §8).
      await queryRunner.createIndex(
        tableName,
        new TableIndex({
          name: `IDX_${tableName}_code`,
          columnNames: ['code'],
        }),
      );

      // List-filter index on `is_active` (user-locked, 2026-05-18).
      await queryRunner.createIndex(
        tableName,
        new TableIndex({
          name: `IDX_${tableName}_is_active`,
          columnNames: ['is_active'],
        }),
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop in reverse creation order for clean reversibility.
    const reversed = [...this.TABLE_NAMES].reverse();
    for (const tableName of reversed) {
      // dropTable cascades the implicit indexes; explicit drops are not
      // required, but we pass `true` for ifExists to keep down()
      // idempotent against partial-rollback scenarios.
      await queryRunner.dropTable(tableName, true);
    }
  }
}
