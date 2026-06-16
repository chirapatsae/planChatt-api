/**
 * Wave wave-ai-knowledge-structure-mgmt — SEC-01 (2026-06-13).
 *
 * Red-team / invariant proof: NO `ai_knowledge_*` structure-management
 * table FK-references a project / plan / tracking-owning table
 * (CLAUDE.md §17.3 / §17.16.4 storage rule; report §6.4 "no project FK").
 *
 * The §17.3 storage rule is ABSOLUTE: structure metadata is advisory
 * display / documentation data (§17.2). An FK into `project_groups` /
 * `revised_project_groups` / `supplement_project_groups` /
 * `equipment_project_groups` / `tracking_status` / a development-plan
 * table would (a) make advisory metadata cascade with project mutations,
 * (b) let a §14.6 rollback hard-delete or a §15 book lock reach into the
 * knowledge layer, and (c) tie actor identity to referential integrity
 * instead of the §4 WorkHistory-UUID-without-FK convention. ONLY
 * `ai_* → ai_*` FKs are allowed (catalog columns / relations → catalog
 * tables).
 *
 * Two complementary proofs:
 *
 *  1. ENTITY-METADATA scan — bootstrap the new entities through TypeORM's
 *     metadata builder (no DB connection) and walk every relation +
 *     foreign-key target. Assert every relation/FK target table name is
 *     in the `ai_knowledge_*` namespace. This is stronger than an
 *     import-grep: it inspects the relation graph TypeORM will actually
 *     materialize at `synchronize:true` time, so a `@ManyToOne(() =>
 *     ProjectGroup)` added later is caught even if the import is aliased.
 *
 *  2. STATIC import scan — defense-in-depth over the entity source files:
 *     no entity file imports a project / plan / tracking-status symbol.
 *
 * Both run with zero DB access (the metadata builder is pure in-memory),
 * so the spec is fast and deterministic in CI.
 */
import * as fs from 'fs';
import * as path from 'path';

import { DataSource } from 'typeorm';

import { AiKnowledgeAuditLog } from '../../entities/ai-knowledge-audit-log.entity';
import { AiKnowledgeCatalogColumn } from '../../entities/ai-knowledge-catalog-column.entity';
import { AiKnowledgeCatalogRelation } from '../../entities/ai-knowledge-catalog-relation.entity';
import { AiKnowledgeCatalogTable } from '../../entities/ai-knowledge-catalog-table.entity';
import { AiKnowledgeDomainMeta } from '../../entities/ai-knowledge-domain-meta.entity';
import { AiKnowledgeToolBinding } from '../../entities/ai-knowledge-tool-binding.entity';

/**
 * The five structure-management entities introduced by this wave (DB-01).
 * The catalog table is included so its INBOUND `ai_* → ai_*` FK targets
 * (columns / relations) are visible to the metadata walk.
 */
const STRUCTURE_ENTITIES = [
  AiKnowledgeDomainMeta,
  AiKnowledgeCatalogTable,
  AiKnowledgeCatalogColumn,
  AiKnowledgeCatalogRelation,
  AiKnowledgeToolBinding,
  // The shared audit sink is in the same write path — assert it too.
  AiKnowledgeAuditLog,
];

/** Any FK / relation target table name MUST live in this namespace. */
const AI_KNOWLEDGE_TABLE_RE = /^ai_knowledge_/;

/**
 * Project / plan / tracking-owning tables that §17.3 forbids an FK into.
 * Used by the import scan; the metadata scan asserts the positive
 * `ai_knowledge_*` invariant which is strictly stronger.
 */
const FORBIDDEN_TABLE_HINTS = [
  'project_groups',
  'revised_project_groups',
  'supplement_project_groups',
  'equipment_project_groups',
  'revised_equipment_project_groups',
  'supplement_equipment_project_groups',
  'tracking_status',
  'development_plan',
];

describe('No-project-FK invariant — TypeORM entity-metadata scan (§17.3 / §17.16.4)', () => {
  let dataSource: DataSource;

  beforeAll(() => {
    // Build metadata WITHOUT connecting — `buildMetadatas()` is pure
    // in-memory (no DB, no DDL). This materializes exactly the relation
    // graph `synchronize:true` would create.
    dataSource = new DataSource({
      type: 'postgres',
      entities: STRUCTURE_ENTITIES,
      synchronize: false,
    });
    // @ts-expect-error — `buildMetadatas` is an internal but stable helper
    // that constructs entity metadata without opening a connection.
    dataSource.buildMetadatas();
  });

  it('registers exactly the six ai_knowledge_* structure tables (all in namespace)', () => {
    const tableNames = dataSource.entityMetadatas.map((m) => m.tableName).sort();
    expect(tableNames).toEqual(
      [
        'ai_knowledge_audit_logs',
        'ai_knowledge_catalog_columns',
        'ai_knowledge_catalog_relations',
        'ai_knowledge_catalog_tables',
        'ai_knowledge_domain_meta',
        'ai_knowledge_tool_binding',
      ].sort(),
    );
    for (const name of tableNames) {
      expect(name).toMatch(AI_KNOWLEDGE_TABLE_RE);
    }
  });

  it('every RELATION target table is in the ai_knowledge_* namespace (no project relation)', () => {
    const offenders: string[] = [];
    for (const meta of dataSource.entityMetadatas) {
      for (const relation of meta.relations) {
        const target = relation.inverseEntityMetadata.tableName;
        if (!AI_KNOWLEDGE_TABLE_RE.test(target)) {
          offenders.push(
            `${meta.tableName}.${relation.propertyName} → ${target}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every FOREIGN KEY target table is in the ai_knowledge_* namespace', () => {
    const offenders: string[] = [];
    for (const meta of dataSource.entityMetadatas) {
      for (const fk of meta.foreignKeys) {
        const target = fk.referencedEntityMetadata.tableName;
        if (!AI_KNOWLEDGE_TABLE_RE.test(target)) {
          offenders.push(`${meta.tableName} FK → ${target}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('catalog children DO carry an ai_* → ai_* FK to ai_knowledge_catalog_tables (allowed)', () => {
    // Positive control: the only legitimate FKs in this wave are the
    // column / relation → catalog-table edges. Their presence proves the
    // metadata walk is actually seeing relations (not silently empty).
    const columnMeta = dataSource.entityMetadatas.find(
      (m) => m.tableName === 'ai_knowledge_catalog_columns',
    )!;
    const relationMeta = dataSource.entityMetadatas.find(
      (m) => m.tableName === 'ai_knowledge_catalog_relations',
    )!;

    const columnTargets = columnMeta.relations.map(
      (r) => r.inverseEntityMetadata.tableName,
    );
    expect(columnTargets).toContain('ai_knowledge_catalog_tables');

    const relationTargets = relationMeta.relations.map(
      (r) => r.inverseEntityMetadata.tableName,
    );
    // both `from` + `to` ends point at the catalog-table
    expect(relationTargets).toEqual([
      'ai_knowledge_catalog_tables',
      'ai_knowledge_catalog_tables',
    ]);
  });

  it('actor + key columns are plain uuid/text (NO relation) — §4 actor-by-UUID', () => {
    // `created_by_work_history_id` etc. MUST be plain columns, never a
    // relation, so a WorkHistory delete never cascades into the hub.
    const ACTOR_OR_KEY_COLUMNS = [
      'created_by_work_history_id',
      'updated_by_work_history_id',
      'actor_work_history_id',
      'domain_key',
      'tool_name',
    ];
    for (const meta of dataSource.entityMetadatas) {
      const relationFkColumnNames = new Set(
        meta.relations.flatMap((r) =>
          r.foreignKeys.flatMap((fk) =>
            fk.columns.map((c) => c.databaseName),
          ),
        ),
      );
      for (const colName of ACTOR_OR_KEY_COLUMNS) {
        if (relationFkColumnNames.has(colName)) {
          throw new Error(
            `${meta.tableName}.${colName} is a relation FK — §17.3 requires a plain column`,
          );
        }
      }
    }
    // Sanity: the assertion above never fell through to a no-op (there is
    // at least one actor column across the entity set).
    const allColumns = dataSource.entityMetadatas.flatMap((m) =>
      m.columns.map((c) => c.databaseName),
    );
    expect(allColumns).toContain('created_by_work_history_id');
    expect(allColumns).toContain('actor_work_history_id');
  });
});

describe('No-project-FK invariant — static import scan of the entity files (defense-in-depth)', () => {
  const ENTITY_FILES = [
    'ai-knowledge-domain-meta.entity.ts',
    'ai-knowledge-catalog-table.entity.ts',
    'ai-knowledge-catalog-column.entity.ts',
    'ai-knowledge-catalog-relation.entity.ts',
    'ai-knowledge-tool-binding.entity.ts',
  ].map((f) => path.resolve(__dirname, '../../entities', f));

  it.each(ENTITY_FILES)(
    '%s imports no project / plan / tracking-status entity',
    (file) => {
      const importLines = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => /^\s*(import|export)\s.*from\s+['"]/.test(line));
      const offenders = importLines.filter((line) =>
        FORBIDDEN_TABLE_HINTS.some((hint) =>
          new RegExp(hint.replace(/_/g, '[-_]'), 'i').test(line),
        ),
      );
      expect(offenders).toEqual([]);
    },
  );
});
