import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableIndex,
} from 'typeorm';

/**
 * Wave 2 — Strategic Graph (DB-02 + DB-03 combined)
 *
 * Creates the eight junction tables that wire the four EXTERNAL strategic
 * alignment masters (created by DB-01) into a graph and bind them to the
 * existing `plans` (แผนงาน) leaf rows.
 *
 *   Inter-master (DB-02):
 *     - sdg_national_strategy
 *     - milestone_sdg
 *     - province_strategy_sdg
 *     - province_strategy_national_strategy
 *
 *   Plan-mapping (DB-03):
 *     - plan_sdg
 *     - plan_national_strategy
 *     - plan_milestone
 *     - plan_province_strategy
 *
 * Source of truth:
 *   - docs/tasks/STRATEGIC_GRAPH_UMBRELLA.md       (§3 scope, §8 DB)
 *   - docs/tasks/STRATEGIC_GRAPH_DB-02_...md
 *   - docs/tasks/STRATEGIC_GRAPH_DB-03_...md
 *   - DB-01 migration: 1779120000000-StrategicGraphMasterTables.ts
 *   - CLAUDE.md §10 (scope binding), §12 (audit — these are MASTER /
 *     CONFIG mapping rows and MUST NOT create TrackingStatus records)
 *
 * Locked decisions (user-confirmed 2026-05-18):
 *   - Combined DB-02 + DB-03 into ONE migration for atomic apply and so the
 *     downstream BE-03 entity registration sees the full graph at once.
 *   - Every junction row carries a minimal config-audit pair:
 *         updated_at TIMESTAMP NOT NULL DEFAULT NOW()
 *         updated_by UUID NULL  REFERENCES users(id) ON DELETE SET NULL
 *     Replace-mode service layer rewrites BOTH columns on every replace.
 *     This is config audit, NOT §12 workflow audit.
 *   - Master → junction FKs use ON DELETE RESTRICT so a master row cannot
 *     vanish out from under a live mapping; soft-delete via is_active is
 *     the canonical removal path (umbrella §11 risks, §10 scope binding).
 *   - Plan → plan-mapping junction FKs use ON DELETE CASCADE: when a
 *     `plans` row is deleted (CASCADE upstream from WorkHistory deletion
 *     already exists in plan.entity.ts), its strategic mapping rows go
 *     with it. The reverse (master → junction) stays RESTRICT.
 *   - `plans.id` is varchar (PrimaryColumn() with string type → TypeORM
 *     default varchar(255) in Postgres). All `plan_id` FK columns mirror
 *     `varchar(255)` exactly to avoid type-mismatch FK rejection.
 *   - Each junction has:
 *       UNIQUE(side_a_id, side_b_id) — replace-mode duplicate guard
 *       plain b-tree index on each FK column individually — multi-dim
 *       filter performance
 *   - `updated_by` is NULLABLE because the DB-04 seed migration runs
 *     without a user context; ON DELETE SET NULL preserves the row when
 *     the actor user is later removed (audit history beats FK enforcement
 *     for this column).
 *
 * §14 / §15 interaction: orthogonal. Junction rows are config metadata;
 * they reference `plans` (strategy-tree leaf), NEVER `ProjectGroup` /
 * `RevisedProjectGroup` / `DevelopmentPlan*`, so neither project-lineage
 * nor book-lineage locks apply.
 *
 * §16 interaction: mappings ride on `plans.id` which is referenced ONLY
 * by STRATEGY_BASED projects (via project.plan_id). ISSUE_BASED projects
 * have plan_id NULL per the §16.5 shape invariant, so the strategic graph
 * is inherently scoped to STRATEGY_BASED reporting — the schema needs no
 * extra guard for this.
 */
export class StrategicGraphJunctions1779130000000
  implements MigrationInterface
{
  name = 'StrategicGraphJunctions1779130000000';

  // ---------------------------------------------------------------------------
  // Schema descriptors — declarative so up() / down() cannot drift.
  // ---------------------------------------------------------------------------

  /**
   * Inter-master junctions (DB-02). Both sides are UUID (master tables from
   * DB-01). Both FKs use ON DELETE RESTRICT.
   */
  private readonly INTER_MASTER_JUNCTIONS: ReadonlyArray<{
    table: string;
    sideA: { column: string; referencedTable: string };
    sideB: { column: string; referencedTable: string };
  }> = [
    {
      table: 'sdg_national_strategy',
      sideA: { column: 'sdg_id', referencedTable: 'sdgs' },
      sideB: {
        column: 'national_strategy_id',
        referencedTable: 'national_strategies',
      },
    },
    {
      table: 'milestone_sdg',
      sideA: { column: 'milestone_id', referencedTable: 'milestones' },
      sideB: { column: 'sdg_id', referencedTable: 'sdgs' },
    },
    {
      table: 'province_strategy_sdg',
      sideA: {
        column: 'province_strategy_id',
        referencedTable: 'province_strategies',
      },
      sideB: { column: 'sdg_id', referencedTable: 'sdgs' },
    },
    {
      table: 'province_strategy_national_strategy',
      sideA: {
        column: 'province_strategy_id',
        referencedTable: 'province_strategies',
      },
      sideB: {
        column: 'national_strategy_id',
        referencedTable: 'national_strategies',
      },
    },
  ];

  /**
   * Plan-mapping junctions (DB-03). Side A is always `plan_id` (varchar(255),
   * ON DELETE CASCADE), side B is a master UUID (ON DELETE RESTRICT).
   */
  private readonly PLAN_JUNCTIONS: ReadonlyArray<{
    table: string;
    masterColumn: string;
    masterTable: string;
  }> = [
    {
      table: 'plan_sdg',
      masterColumn: 'sdg_id',
      masterTable: 'sdgs',
    },
    {
      table: 'plan_national_strategy',
      masterColumn: 'national_strategy_id',
      masterTable: 'national_strategies',
    },
    {
      table: 'plan_milestone',
      masterColumn: 'milestone_id',
      masterTable: 'milestones',
    },
    {
      table: 'plan_province_strategy',
      masterColumn: 'province_strategy_id',
      masterTable: 'province_strategies',
    },
  ];

  // ---------------------------------------------------------------------------
  // up()
  // ---------------------------------------------------------------------------

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Defensive — pgcrypto is also required by DB-01; cheap no-op if present.
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

    // 1) Inter-master junctions first — they only depend on DB-01 masters.
    for (const j of this.INTER_MASTER_JUNCTIONS) {
      await queryRunner.createTable(
        new Table({
          name: j.table,
          columns: [
            {
              name: 'id',
              type: 'uuid',
              isPrimary: true,
              default: 'gen_random_uuid()',
            },
            {
              name: j.sideA.column,
              type: 'uuid',
              isNullable: false,
            },
            {
              name: j.sideB.column,
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
              name: `FK_${j.table}_${j.sideA.column}`,
              columnNames: [j.sideA.column],
              referencedTableName: j.sideA.referencedTable,
              referencedColumnNames: ['id'],
              onDelete: 'RESTRICT',
            },
            {
              name: `FK_${j.table}_${j.sideB.column}`,
              columnNames: [j.sideB.column],
              referencedTableName: j.sideB.referencedTable,
              referencedColumnNames: ['id'],
              onDelete: 'RESTRICT',
            },
            {
              name: `FK_${j.table}_updated_by`,
              columnNames: ['updated_by'],
              referencedTableName: 'users',
              referencedColumnNames: ['id'],
              onDelete: 'SET NULL',
            },
          ],
        }),
        true, // ifNotExists — idempotent up()
      );

      // UNIQUE composite on (side_a, side_b) — replace-mode dedupe guard.
      await queryRunner.createIndex(
        j.table,
        new TableIndex({
          name: `UQ_${j.table}_pair`,
          columnNames: [j.sideA.column, j.sideB.column],
          isUnique: true,
        }),
      );

      // Per-FK b-tree indexes for graph traversal performance.
      await queryRunner.createIndex(
        j.table,
        new TableIndex({
          name: `IDX_${j.table}_${j.sideA.column}`,
          columnNames: [j.sideA.column],
        }),
      );
      await queryRunner.createIndex(
        j.table,
        new TableIndex({
          name: `IDX_${j.table}_${j.sideB.column}`,
          columnNames: [j.sideB.column],
        }),
      );
    }

    // 2) Plan-mapping junctions — depend on `plans` (existing) and masters.
    for (const j of this.PLAN_JUNCTIONS) {
      await queryRunner.createTable(
        new Table({
          name: j.table,
          columns: [
            {
              name: 'id',
              type: 'uuid',
              isPrimary: true,
              default: 'gen_random_uuid()',
            },
            {
              name: 'plan_id',
              // Mirrors plan.entity.ts `@PrimaryColumn() id: string` which
              // TypeORM materializes as varchar(255) in Postgres.
              type: 'varchar',
              length: '255',
              isNullable: false,
            },
            {
              name: j.masterColumn,
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
              name: `FK_${j.table}_plan_id`,
              columnNames: ['plan_id'],
              referencedTableName: 'plans',
              referencedColumnNames: ['id'],
              onDelete: 'CASCADE',
            },
            {
              name: `FK_${j.table}_${j.masterColumn}`,
              columnNames: [j.masterColumn],
              referencedTableName: j.masterTable,
              referencedColumnNames: ['id'],
              onDelete: 'RESTRICT',
            },
            {
              name: `FK_${j.table}_updated_by`,
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
        j.table,
        new TableIndex({
          name: `UQ_${j.table}_pair`,
          columnNames: ['plan_id', j.masterColumn],
          isUnique: true,
        }),
      );

      await queryRunner.createIndex(
        j.table,
        new TableIndex({
          name: `IDX_${j.table}_plan_id`,
          columnNames: ['plan_id'],
        }),
      );
      await queryRunner.createIndex(
        j.table,
        new TableIndex({
          name: `IDX_${j.table}_${j.masterColumn}`,
          columnNames: [j.masterColumn],
        }),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // down()
  // ---------------------------------------------------------------------------

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse creation order: plan-mapping junctions first (they reference
    // both masters and `plans`), then inter-master junctions.
    for (const j of [...this.PLAN_JUNCTIONS].reverse()) {
      await queryRunner.dropTable(j.table, true);
    }
    for (const j of [...this.INTER_MASTER_JUNCTIONS].reverse()) {
      await queryRunner.dropTable(j.table, true);
    }
  }
}
