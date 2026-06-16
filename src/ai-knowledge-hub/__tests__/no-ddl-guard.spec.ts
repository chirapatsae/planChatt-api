/**
 * Wave wave-ai-knowledge-structure-mgmt — BE-03 (Phase 2, 2026-06-13) +
 * SEC-01 (shared).
 *
 * The ABSOLUTE No-DDL guarantee proof (CTO decision #2 / report §6.3 /
 * DOCS-01 §17.16.3). The catalog feature is DOCUMENTATION — `table_name` /
 * `column_name` are plain `varchar` text; it NEVER runs
 * `CREATE / ALTER / DROP / raw DDL` and NEVER mutates the real Postgres
 * schema.
 *
 * Two complementary proofs (task §7 No-DDL proof):
 *
 *  1. STATIC grep — every file on the catalog write path is scanned for
 *     DDL verbs (`CREATE TABLE` / `ALTER TABLE` / `DROP TABLE` /
 *     `createTable` / `dropTable` / `addColumn` / `createQueryRunner` /
 *     `query(` / `getSchemaBuilder`). Zero matches outside prose-comment
 *     lines. Also asserts the §17.3 no-project-FK invariant: no import of
 *     a project / tracking-status entity.
 *
 *  2. BEHAVIOURAL — a real catalog write is driven through the service
 *     against an instrumented `DataSource` whose schema-builder /
 *     query-runner / raw `query` surfaces THROW on contact. The write
 *     succeeds touching only the `ai_knowledge_catalog_*` repositories,
 *     proving the path never reaches the schema (a stand-in for the
 *     SEC-01 `information_schema.tables` runtime check).
 */
import * as fs from 'fs';
import * as path from 'path';

import { AiKnowledgeAuditLog } from '../entities/ai-knowledge-audit-log.entity';
import { AiKnowledgeCatalogColumn } from '../entities/ai-knowledge-catalog-column.entity';
import { AiKnowledgeCatalogRelation } from '../entities/ai-knowledge-catalog-relation.entity';
import { AiKnowledgeCatalogTable } from '../entities/ai-knowledge-catalog-table.entity';
import { KnowledgeAuditService } from '../services/knowledge-audit.service';
import { KnowledgeCatalogService } from '../services/knowledge-catalog.service';

// ────────────────────────────────────────────────────────────────────
// 1. STATIC grep — no DDL verb, no project-table import, no raw query
// ────────────────────────────────────────────────────────────────────

const CATALOG_PATH_FILES = [
  path.resolve(__dirname, '../services/knowledge-catalog.service.ts'),
  path.resolve(__dirname, '../controllers/knowledge-structure.controller.ts'),
  path.resolve(__dirname, '../dto/catalog-table.dto.ts'),
  path.resolve(__dirname, '../dto/catalog-column.dto.ts'),
  path.resolve(__dirname, '../dto/catalog-relation.dto.ts'),
];

/**
 * Strip line + block comments so the §17.16.3 documentation prose
 * (which legitimately mentions "CREATE TABLE", "ALTER", "DROP", "no-DDL")
 * is NOT treated as an offender — only EXECUTABLE code is scanned.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '')) // line comments
    .join('\n');
}

// DDL verbs + schema-builder / query-runner surfaces. Case-insensitive for
// the SQL keywords; the method names are matched as-is.
//
// NOTE: `createTable` / `addColumn` are TypeORM `QueryRunner` schema-builder
// methods AND, coincidentally, plausible domain method names (this service
// legitimately owns a `createTable(dto, userId)` documentation-row creator).
// To avoid a false positive on the legit method, the schema-builder method
// patterns require a `queryRunner` / `schemaBuilder` receiver — the only way
// these reach the real schema. The `.createQueryRunner(` /
// `.getSchemaBuilder(` patterns independently catch the entry points, so a
// schema-builder call cannot slip through unflagged.
const DDL_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'CREATE TABLE', re: /\bCREATE\s+TABLE\b/i },
  { label: 'ALTER TABLE', re: /\bALTER\s+TABLE\b/i },
  { label: 'DROP TABLE', re: /\bDROP\s+TABLE\b/i },
  { label: 'CREATE INDEX', re: /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i },
  { label: 'TRUNCATE', re: /\bTRUNCATE\b/i },
  {
    label: 'queryRunner.createTable(',
    re: /(queryRunner|schemaBuilder)\s*\.\s*createTable\s*\(/i,
  },
  {
    label: 'queryRunner.dropTable(',
    re: /(queryRunner|schemaBuilder)?\s*\.\s*dropTable\s*\(/i,
  },
  {
    label: 'queryRunner.addColumn(',
    re: /(queryRunner|schemaBuilder)?\s*\.\s*addColumn\s*\(/i,
  },
  {
    label: 'queryRunner.dropColumn(',
    re: /(queryRunner|schemaBuilder)?\s*\.\s*dropColumn\s*\(/i,
  },
  { label: '.createQueryRunner(', re: /\.createQueryRunner\s*\(/ },
  { label: '.getSchemaBuilder(', re: /\.getSchemaBuilder\s*\(/ },
  { label: '.synchronize(', re: /\.synchronize\s*\(/ },
  // A raw `.query(` on a repo / manager / dataSource is the escape hatch
  // for arbitrary SQL incl. DDL — forbidden on the catalog path.
  { label: '.query(', re: /\.query\s*\(/ },
];

describe('No-DDL guarantee — static grep of the catalog path (§17.16.3)', () => {
  it.each(CATALOG_PATH_FILES)(
    '%s contains zero DDL / schema-builder / raw-query verbs',
    (file) => {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      const offenders: string[] = [];
      for (const { label, re } of DDL_PATTERNS) {
        if (re.test(code)) offenders.push(label);
      }
      expect(offenders).toEqual([]);
    },
  );

  it.each(CATALOG_PATH_FILES)(
    '%s imports no project / tracking-status entity (§17.3 no-project-FK)',
    (file) => {
      const importLines = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => /^\s*(import|export)\s.*from\s+['"]/.test(line));
      const offenders = importLines.filter(
        (line) =>
          /tracking[-_]?status/i.test(line) ||
          /project-group|project_groups/i.test(line) ||
          /development-plan/i.test(line) ||
          /\/entities\/(project|revised|supplement|equipment)/i.test(line),
      );
      expect(offenders).toEqual([]);
    },
  );

  it('catalog service uses ONLY repository methods (no raw SQL builder for writes)', () => {
    const code = stripComments(
      fs.readFileSync(CATALOG_PATH_FILES[0], 'utf8'),
    );
    // It MAY read `dataSource.entityMetadatas` (the read-only seed source)
    // but MUST NOT touch `dataSource.createQueryRunner` / a schema builder.
    expect(code).toContain('entityMetadatas');
    expect(/createQueryRunner|getSchemaBuilder|\.synchronize\s*\(/.test(code)).toBe(
      false,
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// 2. BEHAVIOURAL — a write never reaches the schema
// ────────────────────────────────────────────────────────────────────

describe('No-DDL guarantee — behavioural (a catalog write touches no schema)', () => {
  /**
   * Build a service over in-memory repos + a HOSTILE DataSource whose
   * schema-mutating surfaces throw. If the write path ever tries to issue
   * DDL (directly or via a query runner / schema builder), the test fails
   * loudly. A successful write proves the path stays in repository land.
   */
  function createHostileHarness() {
    const tables: Array<Record<string, unknown>> = [];
    const auditRows: Array<Record<string, unknown>> = [];

    const ddlTripwire = (name: string) =>
      jest.fn(() => {
        throw new Error(`DDL surface invoked: ${name} (no-DDL violation)`);
      });

    const tableRepo: Record<string, unknown> = {
      create: jest.fn((input: Record<string, unknown>) => ({ ...input })),
      save: jest.fn(async (input: Record<string, unknown>) => {
        const created = { ...input, id: input.id ?? `tbl-${tables.length + 1}` };
        tables.push(created);
        return created;
      }),
      find: jest.fn(async () => []),
      findOne: jest.fn(async () => null),
      softDelete: jest.fn(async () => ({ affected: 0 })),
      // A raw `.query` on the repo is itself a DDL escape hatch → tripwire.
      query: ddlTripwire('repo.query'),
    };

    const txAuditRepo = {
      insert: jest.fn(async (row: Record<string, unknown>) => {
        auditRows.push({ ...row });
        return { identifiers: [] };
      }),
    };

    const entityManagerFake = {
      getRepository: (entity: unknown) => {
        if (entity === AiKnowledgeCatalogTable) return tableRepo;
        if (entity === AiKnowledgeAuditLog) return txAuditRepo;
        if (entity === AiKnowledgeCatalogColumn) return tableRepo;
        if (entity === AiKnowledgeCatalogRelation) return tableRepo;
        throw new Error('unexpected repository');
      },
      query: ddlTripwire('manager.query'),
    };

    const transaction = jest.fn(
      async (cb: (m: unknown) => Promise<unknown>) => cb(entityManagerFake),
    );

    const repoWithManager = { ...tableRepo, manager: { transaction } };

    const workHistoryRepoFake = {
      findOne: jest.fn(async () => ({ id: 'wh-1', role: { name: 'admin' } })),
    };
    const auditService = new KnowledgeAuditService({
      insert: jest.fn(async (row: Record<string, unknown>) => {
        auditRows.push({ ...row });
      }),
    } as never);

    // HOSTILE DataSource — every schema-mutating surface throws on contact.
    const hostileDataSource = {
      entityMetadatas: [],
      createQueryRunner: ddlTripwire('dataSource.createQueryRunner'),
      getSchemaBuilder: ddlTripwire('dataSource.getSchemaBuilder'),
      synchronize: ddlTripwire('dataSource.synchronize'),
      query: ddlTripwire('dataSource.query'),
      get driver() {
        throw new Error('DDL surface invoked: dataSource.driver (no-DDL)');
      },
    };

    const service = new KnowledgeCatalogService(
      repoWithManager as never,
      repoWithManager as never,
      repoWithManager as never,
      workHistoryRepoFake as never,
      auditService,
      hostileDataSource as never,
    );

    return { service, tables, auditRows, hostileDataSource };
  }

  it('createTable succeeds without invoking any DDL surface', async () => {
    const harness = createHostileHarness();
    const result = await harness.service.createTable(
      { tableName: 'plain_text_name', displayNameTh: 'x' },
      'user-id',
    );
    expect(result.tableName).toBe('plain_text_name');
    expect(harness.tables).toHaveLength(1);
    // The hostile DDL surfaces were never touched (no throw escaped).
    expect(
      harness.hostileDataSource.createQueryRunner,
    ).not.toHaveBeenCalled();
    expect(harness.hostileDataSource.synchronize).not.toHaveBeenCalled();
    expect(harness.hostileDataSource.query).not.toHaveBeenCalled();
  });

  it('seedFromEntities reads entityMetadatas read-only — no schema mutation', async () => {
    const harness = createHostileHarness();
    // Empty metadata → zero inserts, but the call must complete without
    // touching a single DDL surface.
    const result = await harness.service.seedFromEntities('user-id');
    expect(result.tablesInserted).toBe(0);
    expect(
      harness.hostileDataSource.createQueryRunner,
    ).not.toHaveBeenCalled();
    expect(harness.hostileDataSource.synchronize).not.toHaveBeenCalled();
    expect(harness.hostileDataSource.query).not.toHaveBeenCalled();
    expect(harness.hostileDataSource.getSchemaBuilder).not.toHaveBeenCalled();
  });
});
