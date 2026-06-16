/**
 * Wave wave-ai-knowledge-structure-mgmt — SEC-01 (2026-06-13).
 *
 * Red-team: a hostile admin crafts catalog writes whose `tableName` /
 * `columnName` / `dataType` are SQL-injection / DDL payloads
 * ("`students; DROP TABLE project_groups; --`", "`uuid DEFAULT (SELECT
 * ...)`"). Prove the No-DDL guarantee (CLAUDE.md §17.16.3 / report §6.3 —
 * ABSOLUTE): the catalog is DOCUMENTATION; those fields are plain
 * `varchar` text stored VERBATIM and NEVER:
 *
 *   1. reach a query builder as an SQL IDENTIFIER,
 *   2. get concatenated into raw SQL,
 *   3. invoke any schema-mutating surface (`createQueryRunner` /
 *      `getSchemaBuilder` / `.synchronize()` / a raw `.query(DDL)`).
 *
 * This is the §3 task deliverable `no-ddl.red-team.spec.ts` — the
 * adversarial-INPUT companion to `__tests__/no-ddl-guard.spec.ts` (which
 * proves the same over clean inputs + a static grep). Here the inputs are
 * deliberately HOSTILE and the assertion is that (a) only
 * `ai_knowledge_catalog_*` rows move, (b) the payload round-trips
 * BYTE-FOR-BYTE (proving it was treated as data, not SQL), and (c) every
 * hostile DDL surface stays untouched.
 */
import { AiKnowledgeAuditLog } from '../../entities/ai-knowledge-audit-log.entity';
import { AiKnowledgeCatalogColumn } from '../../entities/ai-knowledge-catalog-column.entity';
import { AiKnowledgeCatalogRelation } from '../../entities/ai-knowledge-catalog-relation.entity';
import { AiKnowledgeCatalogTable } from '../../entities/ai-knowledge-catalog-table.entity';
import { KnowledgeAuditService } from '../../services/knowledge-audit.service';
import { KnowledgeCatalogService } from '../../services/knowledge-catalog.service';

/** A `tableName` that, if ever interpolated as SQL, would drop a project table. */
const DDL_INJECTION_TABLE_NAME = 'students; DROP TABLE project_groups; --';
/** A `columnName` injection variant. */
const DDL_INJECTION_COLUMN_NAME =
  'id" ); ALTER TABLE tracking_status DROP COLUMN status_id; --';
/** A `dataType` that smells like a real DDL default. */
const DDL_INJECTION_DATA_TYPE = 'uuid DEFAULT (SELECT current_database())';

const LIVE_TABLE = {
  id: 'tbl-live',
  tableName: 'doc_only',
  displayNameTh: 'doc',
  descriptionTh: null,
  domainKey: null,
  isSeeded: false,
  displayOrder: 0,
  deletedAt: null,
};

const ddlTripwire = (name: string) =>
  jest.fn(() => {
    throw new Error(`DDL surface invoked: ${name} (no-DDL violation)`);
  });

/**
 * Build a `KnowledgeCatalogService` over in-memory repos + a HOSTILE
 * DataSource whose schema-mutating surfaces THROW on contact. The table
 * repo's `findOne` returns a single LIVE parent row so the column-upsert
 * path resolves its parent; every other read is empty (no name clash on
 * create). A red-team write that ever tried to issue DDL trips a wire and
 * fails the test loudly; a clean write proves the path stays in
 * repository land regardless of how adversarial the field VALUES are.
 */
function createHostileHarness() {
  const tableRows: Array<Record<string, unknown>> = [];
  const columnRows: Array<Record<string, unknown>> = [];
  const relationRows: Array<Record<string, unknown>> = [];
  const auditRows: Array<Record<string, unknown>> = [];

  let nextTableId = 0;
  let nextColumnId = 0;
  let nextRelationId = 0;

  const tableRepo: Record<string, unknown> = {
    create: jest.fn((input: Record<string, unknown>) => ({ ...input })),
    save: jest.fn(async (input: Record<string, unknown>) => {
      const created = { ...input, id: input.id ?? `tbl-${(nextTableId += 1)}` };
      tableRows.push(created);
      return created;
    }),
    // On create, no name clash (null); on upsert, return the live parent.
    findOne: jest.fn(async (opts: { where?: { id?: string } }) =>
      opts?.where?.id === LIVE_TABLE.id ? { ...LIVE_TABLE } : null,
    ),
    find: jest.fn(async () => []),
    softDelete: jest.fn(async () => ({ affected: 0 })),
    query: ddlTripwire('tableRepo.query'),
  };

  const columnRepo: Record<string, unknown> = {
    create: jest.fn((input: Record<string, unknown>) => ({ ...input })),
    save: jest.fn(
      async (
        input: Record<string, unknown> | Array<Record<string, unknown>>,
      ) => {
        const many = Array.isArray(input) ? input : [input];
        const saved = many.map((one) => ({
          ...one,
          id: one.id ?? `col-${(nextColumnId += 1)}`,
        }));
        for (const row of saved) {
          const idx = columnRows.findIndex((r) => r.id === row.id);
          if (idx >= 0) columnRows[idx] = row;
          else columnRows.push(row);
        }
        return Array.isArray(input) ? saved : saved[0];
      },
    ),
    find: jest.fn(async () => columnRows.filter((c) => !c.deletedAt)),
    findOne: jest.fn(async () => null),
    softDelete: jest.fn(async () => ({ affected: 0 })),
    query: ddlTripwire('columnRepo.query'),
  };

  const relationRepo: Record<string, unknown> = {
    create: jest.fn((input: Record<string, unknown>) => ({ ...input })),
    save: jest.fn(async (input: Record<string, unknown>) => {
      const created = { ...input, id: input.id ?? `rel-${(nextRelationId += 1)}` };
      relationRows.push(created);
      return created;
    }),
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    softDelete: jest.fn(async () => ({ affected: 0 })),
    query: ddlTripwire('relationRepo.query'),
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
      if (entity === AiKnowledgeCatalogColumn) return columnRepo;
      if (entity === AiKnowledgeCatalogRelation) return relationRepo;
      if (entity === AiKnowledgeAuditLog) return txAuditRepo;
      throw new Error('unexpected repository');
    },
    query: ddlTripwire('manager.query'),
  };

  const transaction = jest.fn(
    async (cb: (m: unknown) => Promise<unknown>) => cb(entityManagerFake),
  );

  // Each service repo arg needs `.manager.transaction`; share one manager.
  const withManager = (repo: Record<string, unknown>) => ({
    ...repo,
    manager: { transaction },
  });

  const workHistoryRepoFake = {
    findOne: jest.fn(async () => ({ id: 'wh-1', role: { name: 'super-admin' } })),
  };

  // Base audit repo THROWS — proves the audit row rides the caller's tx.
  const auditService = new KnowledgeAuditService({
    insert: jest.fn(() => {
      throw new Error(
        'audit row written OUTSIDE the mutation transaction (§17.3 atomicity violation)',
      );
    }),
  } as never);

  // HOSTILE DataSource — every schema-mutating surface throws on contact.
  const hostileDataSource = {
    entityMetadatas: [],
    createQueryRunner: ddlTripwire('dataSource.createQueryRunner'),
    getSchemaBuilder: ddlTripwire('dataSource.getSchemaBuilder'),
    synchronize: ddlTripwire('dataSource.synchronize'),
    query: ddlTripwire('dataSource.query'),
  };

  const service = new KnowledgeCatalogService(
    withManager(tableRepo) as never,
    withManager(columnRepo) as never,
    withManager(relationRepo) as never,
    workHistoryRepoFake as never,
    auditService,
    hostileDataSource as never,
  );

  return { service, tableRows, columnRows, relationRows, auditRows, hostileDataSource };
}

function assertNoDdlSurfaceTouched(h: ReturnType<typeof createHostileHarness>) {
  expect(h.hostileDataSource.createQueryRunner).not.toHaveBeenCalled();
  expect(h.hostileDataSource.getSchemaBuilder).not.toHaveBeenCalled();
  expect(h.hostileDataSource.synchronize).not.toHaveBeenCalled();
  expect(h.hostileDataSource.query).not.toHaveBeenCalled();
}

describe('No-DDL red-team — a DDL-shaped catalog write moves only ai_knowledge_* rows', () => {
  it('createTable with a "; DROP TABLE project_groups; --" name stores it as DATA, touches no schema', async () => {
    const h = createHostileHarness();

    const result = await h.service.createTable(
      {
        tableName: DDL_INJECTION_TABLE_NAME,
        displayNameTh: 'ตารางทดสอบ',
        descriptionTh: 'red-team',
      },
      'super-admin-id',
    );

    // The hostile string round-tripped BYTE-FOR-BYTE → treated as a
    // documentation value, never an identifier or SQL fragment.
    expect(result.tableName).toBe(DDL_INJECTION_TABLE_NAME);
    expect(h.tableRows).toHaveLength(1);
    expect(h.tableRows[0].tableName).toBe(DDL_INJECTION_TABLE_NAME);

    // Exactly ONE ai_knowledge_audit_logs row; nothing else moved.
    expect(h.auditRows).toHaveLength(1);
    expect(h.auditRows[0]).toMatchObject({
      action: 'catalog_table_create',
      targetKind: 'catalog_table',
    });
    expect(h.columnRows).toHaveLength(0);
    expect(h.relationRows).toHaveLength(0);

    assertNoDdlSurfaceTouched(h);
  });

  it('upsertColumns with an injection columnName + DDL-shaped dataType stays in repository land', async () => {
    const h = createHostileHarness();

    const result = await h.service.upsertColumns(
      LIVE_TABLE.id,
      {
        columns: [
          {
            columnName: DDL_INJECTION_COLUMN_NAME,
            dataType: DDL_INJECTION_DATA_TYPE,
            isNullable: true,
          },
        ],
      },
      'super-admin-id',
    );

    // Hostile columnName + dataType round-trip VERBATIM.
    const stored = h.columnRows.find(
      (c) => c.columnName === DDL_INJECTION_COLUMN_NAME,
    );
    expect(stored).toBeDefined();
    expect(stored?.dataType).toBe(DDL_INJECTION_DATA_TYPE);
    expect(result.diff.inserted).toContain(DDL_INJECTION_COLUMN_NAME);

    // One batch audit row; no table / relation row moved; no schema touched.
    expect(h.auditRows).toHaveLength(1);
    expect(h.auditRows[0]).toMatchObject({ action: 'catalog_column_upsert' });
    expect(h.tableRows).toHaveLength(0);
    expect(h.relationRows).toHaveLength(0);
    assertNoDdlSurfaceTouched(h);
  });

  it('createRelation with a DDL-shaped onDeleteNote stores it as documentation text', async () => {
    const h = createHostileHarness();

    const result = await h.service.createRelation(
      {
        fromTableId: LIVE_TABLE.id,
        toTableId: LIVE_TABLE.id,
        relationType: 'one_to_many',
        onDeleteNote: 'CASCADE; DROP TABLE project_groups; --',
        allowSelf: true,
      },
      'super-admin-id',
    );

    expect(result.onDeleteNote).toBe('CASCADE; DROP TABLE project_groups; --');
    expect(h.relationRows).toHaveLength(1);
    expect(h.auditRows).toHaveLength(1);
    expect(h.auditRows[0]).toMatchObject({ action: 'relation_create' });
    assertNoDdlSurfaceTouched(h);
  });

  it('seedFromEntities reads metadata read-only — a hostile (empty) metadata set issues no DDL', async () => {
    const h = createHostileHarness();
    const result = await h.service.seedFromEntities('super-admin-id');
    expect(result.tablesInserted).toBe(0);
    assertNoDdlSurfaceTouched(h);
  });
});
