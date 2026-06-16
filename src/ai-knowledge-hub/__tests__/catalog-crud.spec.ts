/**
 * Wave wave-ai-knowledge-structure-mgmt — BE-03 (Phase 2, 2026-06-13).
 *
 * Class-A data-catalog + relationship CRUD acceptance specs (task §6 /
 * §7):
 *
 *  1. Role matrix (Q-03) — the BE-03 catalog mutations are admin +
 *     super-admin ONLY through the canonical `RolesGuard` against REAL
 *     controller metadata: `user` / `staff` / `c-level` → 403; `admin` /
 *     `super-admin` → pass.
 *  2. Catalog table CRUD — create (+ duplicate-name guard), patch
 *     (merge + rename collision + 404), soft-delete with the SERVICE
 *     cascade to columns + dangling relations (NOT a DB CASCADE).
 *  3. Column bulk upsert — diff (insert / update / soft-delete) keyed by
 *     name; duplicate-name body guard; 404 on missing parent.
 *  4. Relation CRUD — soft-deleted-table reject; self-loop reject (+
 *     allowSelf); type / label / note / order edit; soft-delete + 404.
 *  5. Seed (Q-02) — idempotent: a second run inserts zero duplicates and
 *     preserves a hand-edited row; reads metadata read-only.
 *  6. Audit (§17.3) — every mutation writes EXACTLY ONE (or one batch)
 *     `ai_knowledge_audit_logs` row on the caller's transactional manager;
 *     NEVER TrackingStatus.
 */
import {
  ExecutionContext,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { JwtAuthGuard } from '../../auth/auth.guard';
import { ADMIN_OR_ABOVE } from '../../auth/role-groups';
import { ROLES_KEY } from '../../auth/roles.decorator';
import { Role } from '../../auth/roles.enum';
import { RolesGuard } from '../../auth/roles.guard';
import { WorkStatusApprovedGuard } from '../../auth/work-status-approved.guard';
import { KnowledgeStructureController } from '../controllers/knowledge-structure.controller';
import { AiKnowledgeAuditLog } from '../entities/ai-knowledge-audit-log.entity';
import { AiKnowledgeCatalogColumn } from '../entities/ai-knowledge-catalog-column.entity';
import { AiKnowledgeCatalogRelation } from '../entities/ai-knowledge-catalog-relation.entity';
import { AiKnowledgeCatalogTable } from '../entities/ai-knowledge-catalog-table.entity';
import { KnowledgeAuditService } from '../services/knowledge-audit.service';
import { KnowledgeCatalogService } from '../services/knowledge-catalog.service';

// ────────────────────────────────────────────────────────────────────
// Shared helpers
// ────────────────────────────────────────────────────────────────────

async function expectHttpError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(HttpException);
  const exception = caught as HttpException;
  expect(exception.getStatus()).toBe(status);
  const response = exception.getResponse();
  if (typeof response === 'string') {
    expect(response).toBe(code);
  } else {
    const body = response as Record<string, unknown>;
    expect(body.code ?? body.message).toBe(code);
  }
}

const ACTOR_WH_ID = 'wh-admin-1';

interface Row {
  id: string;
  [key: string]: unknown;
  deletedAt: Date | null;
}

interface CatalogHarness {
  service: KnowledgeCatalogService;
  tables: Row[];
  columns: Row[];
  relations: Row[];
  auditRows: Array<Record<string, unknown>>;
  entityMetadatas: unknown[];
  spies: {
    transaction: jest.Mock;
    auditInsert: jest.Mock;
    tableSoftDelete: jest.Mock;
    columnSoftDelete: jest.Mock;
    relationSoftDelete: jest.Mock;
  };
}

/**
 * In-memory harness over the BE-03 catalog write path. The REAL
 * `KnowledgeAuditService` is wired with a THROWING base repo so the spec
 * proves every audit row joins the caller's transactional manager (§17.3
 * atomicity). `IsNull()` becomes a FindOperator with `_type === 'isNull'`.
 */
function createCatalogHarness(
  seed: {
    tables?: Array<Partial<Row> & { id: string }>;
    columns?: Array<Partial<Row> & { id: string }>;
    relations?: Array<Partial<Row> & { id: string }>;
    entityMetadatas?: unknown[];
  } = {},
  options: { actorRole?: string } = {},
): CatalogHarness {
  let idSeq = 0;
  const nextId = (prefix: string) => `${prefix}-${++idSeq}`;

  const tables: Row[] = (seed.tables ?? []).map((row) => ({
    tableName: '',
    displayNameTh: '',
    descriptionTh: null,
    domainKey: null,
    isSeeded: false,
    displayOrder: 0,
    createdByWorkHistoryId: ACTOR_WH_ID,
    updatedByWorkHistoryId: ACTOR_WH_ID,
    deletedAt: null,
    ...row,
  }));
  const columns: Row[] = (seed.columns ?? []).map((row) => ({
    tableId: '',
    columnName: '',
    dataType: null,
    isNullable: true,
    descriptionTh: null,
    isPii: false,
    displayOrder: 0,
    deletedAt: null,
    ...row,
  }));
  const relations: Row[] = (seed.relations ?? []).map((row) => ({
    fromTableId: '',
    toTableId: '',
    relationType: 'one_to_many',
    labelTh: null,
    onDeleteNote: null,
    displayOrder: 0,
    deletedAt: null,
    ...row,
  }));
  const auditRows: Array<Record<string, unknown>> = [];

  // Resolve a FindOperator-or-scalar where value (IsNull → null match).
  const matchValue = (rowValue: unknown, whereValue: unknown): boolean => {
    if (
      whereValue &&
      typeof whereValue === 'object' &&
      '_type' in (whereValue as Record<string, unknown>)
    ) {
      const op = whereValue as { _type?: string; _value?: unknown };
      if (op._type === 'isNull') return rowValue === null || rowValue === undefined;
      if (op._type === 'in') {
        return (op._value as unknown[]).includes(rowValue);
      }
      return rowValue === op._value;
    }
    return rowValue === whereValue;
  };

  const makeRepo = (store: Row[], prefix: string) => {
    const repo = {
      create: jest.fn((input: Record<string, unknown>) => ({ ...input })),
      save: jest.fn(async (input: Record<string, unknown> | unknown[]) => {
        const upsertOne = (one: Record<string, unknown>) => {
          const existing = one.id
            ? store.find((row) => row.id === one.id)
            : undefined;
          if (existing) {
            Object.assign(existing, one);
            return existing;
          }
          const created: Row = {
            ...(one as Record<string, unknown>),
            id: (one.id as string) ?? nextId(prefix),
            deletedAt: (one.deletedAt as Date | null) ?? null,
          } as Row;
          store.push(created);
          return created;
        };
        if (Array.isArray(input)) return input.map(upsertOne);
        return upsertOne(input);
      }),
      find: jest.fn(
        async (opts?: { where?: Record<string, unknown> }) => {
          const where = opts?.where ?? {};
          return store.filter((row) =>
            Object.entries(where).every(([k, v]) => matchValue(row[k], v)),
          );
        },
      ),
      findOne: jest.fn(
        async (opts: { where: Record<string, unknown> }) =>
          store.find((row) =>
            Object.entries(opts.where).every(([k, v]) =>
              matchValue(row[k], v),
            ),
          ) ?? null,
      ),
      softDelete: jest.fn(async (criteria: string | string[] | { id: string }) => {
        const ids = Array.isArray(criteria)
          ? criteria
          : typeof criteria === 'string'
            ? [criteria]
            : [criteria.id];
        let affected = 0;
        for (const id of ids) {
          const row = store.find((r) => r.id === id && !r.deletedAt);
          if (row) {
            row.deletedAt = new Date();
            affected += 1;
          }
        }
        return { affected };
      }),
    };
    return repo;
  };

  const tableRepo = makeRepo(tables, 'tbl');
  const columnRepo = makeRepo(columns, 'col');
  const relationRepo = makeRepo(relations, 'rel');

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
      throw new Error('unexpected repository request in transaction');
    },
  };

  const transaction = jest.fn(
    async (callback: (manager: unknown) => Promise<unknown>) =>
      callback(entityManagerFake),
  );

  // Each injected repo exposes `.manager.transaction` (only the table
  // repo's manager is used by the service, but wire all three for parity).
  const withManager = (repo: Record<string, unknown>) => ({
    ...repo,
    manager: { transaction },
  });

  const workHistoryRepoFake = {
    findOne: jest.fn(async () => ({
      id: ACTOR_WH_ID,
      role: { name: options.actorRole ?? 'admin' },
    })),
  };

  const throwingBaseAuditRepo = {
    insert: jest.fn(() => {
      throw new Error(
        'audit row written OUTSIDE the mutation transaction (§17.3 atomicity violation)',
      );
    }),
  };
  const auditService = new KnowledgeAuditService(throwingBaseAuditRepo as never);

  const dataSourceFake = {
    entityMetadatas: seed.entityMetadatas ?? [],
  };

  const service = new KnowledgeCatalogService(
    withManager(tableRepo) as never,
    withManager(columnRepo) as never,
    withManager(relationRepo) as never,
    workHistoryRepoFake as never,
    auditService,
    dataSourceFake as never,
  );

  return {
    service,
    tables,
    columns,
    relations,
    auditRows,
    entityMetadatas: dataSourceFake.entityMetadatas,
    spies: {
      transaction,
      auditInsert: txAuditRepo.insert,
      tableSoftDelete: tableRepo.softDelete,
      columnSoftDelete: columnRepo.softDelete,
      relationSoftDelete: relationRepo.softDelete,
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// 1. Role matrix (Q-03) — real controller metadata through RolesGuard
// ────────────────────────────────────────────────────────────────────

describe('KnowledgeStructureController — BE-03 catalog role gate (Q-03)', () => {
  const guard = new RolesGuard(new Reflector());

  const contextFor = (
    handler: (...args: never[]) => unknown,
    role: string,
  ): ExecutionContext =>
    ({
      getHandler: () => handler,
      getClass: () => KnowledgeStructureController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    }) as unknown as ExecutionContext;

  const CATALOG_HANDLERS: Array<[string, (...args: never[]) => unknown]> = [
    [
      'createCatalogTable',
      KnowledgeStructureController.prototype.createCatalogTable,
    ],
    [
      'updateCatalogTable',
      KnowledgeStructureController.prototype.updateCatalogTable,
    ],
    [
      'deleteCatalogTable',
      KnowledgeStructureController.prototype.deleteCatalogTable,
    ],
    [
      'upsertCatalogColumns',
      KnowledgeStructureController.prototype.upsertCatalogColumns,
    ],
    [
      'createCatalogRelation',
      KnowledgeStructureController.prototype.createCatalogRelation,
    ],
    [
      'updateCatalogRelation',
      KnowledgeStructureController.prototype.updateCatalogRelation,
    ],
    [
      'deleteCatalogRelation',
      KnowledgeStructureController.prototype.deleteCatalogRelation,
    ],
    ['seedCatalog', KnowledgeStructureController.prototype.seedCatalog],
  ];

  it.each(CATALOG_HANDLERS)(
    '%s declares @Roles(...ADMIN_OR_ABOVE) + the canonical guard chain',
    (_name, handler) => {
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([
        ...ADMIN_OR_ABOVE,
      ]);
      expect(Reflect.getMetadata('__guards__', handler)).toEqual([
        JwtAuthGuard,
        RolesGuard,
        WorkStatusApprovedGuard,
      ]);
    },
  );

  it.each(CATALOG_HANDLERS)(
    '%s: admin + super-admin pass; user / staff / c-level → 403',
    (_name, handler) => {
      expect(guard.canActivate(contextFor(handler, Role.ADMIN))).toBe(true);
      expect(
        guard.canActivate(contextFor(handler, Role.SUPER_ADMIN)),
      ).toBe(true);
      for (const role of [Role.USER, Role.STAFF, Role.C_LEVEL]) {
        expect(() => guard.canActivate(contextFor(handler, role))).toThrow(
          ForbiddenException,
        );
      }
    },
  );
});

// ────────────────────────────────────────────────────────────────────
// 2. Catalog table CRUD
// ────────────────────────────────────────────────────────────────────

describe('catalog table CRUD', () => {
  it('creates a table (is_seeded=false) and audits catalog_table_create', async () => {
    const harness = createCatalogHarness();
    const result = await harness.service.createTable(
      {
        tableName: 'project_groups',
        displayNameTh: 'โครงการ',
        descriptionTh: 'ตารางโครงการหลัก',
        domainKey: 'projects',
        displayOrder: 1,
      },
      'user-id',
    );
    expect(result.tableName).toBe('project_groups');
    expect(result.isSeeded).toBe(false);
    expect(result.domainKey).toBe('projects');
    expect(harness.tables).toHaveLength(1);
    expect(harness.auditRows).toHaveLength(1);
    expect(harness.auditRows[0].action).toBe('catalog_table_create');
    expect(harness.auditRows[0].targetKind).toBe('catalog_table');
    expect(harness.auditRows[0].actorWorkHistoryId).toBe(ACTOR_WH_ID);
    // Audit rode the tx manager (throwing base repo never hit).
    expect(harness.spies.transaction).toHaveBeenCalledTimes(1);
  });

  it('rejects a duplicate LIVE table name with 409', async () => {
    const harness = createCatalogHarness({
      tables: [{ id: 't1', tableName: 'project_groups' }],
    });
    await expectHttpError(
      harness.service.createTable(
        { tableName: 'project_groups', displayNameTh: 'x' },
        'user-id',
      ),
      409,
      'CATALOG_TABLE_NAME_DUPLICATE',
    );
    expect(harness.auditRows).toHaveLength(0);
  });

  it('ALLOWS reusing the name of a SOFT-DELETED table', async () => {
    const harness = createCatalogHarness({
      tables: [
        { id: 't1', tableName: 'project_groups', deletedAt: new Date() },
      ],
    });
    const result = await harness.service.createTable(
      { tableName: 'project_groups', displayNameTh: 'x' },
      'user-id',
    );
    expect(result.tableName).toBe('project_groups');
  });

  it('patches display fields (merge), audits catalog_table_update', async () => {
    const harness = createCatalogHarness({
      tables: [
        {
          id: 't1',
          tableName: 'project_groups',
          displayNameTh: 'เก่า',
          domainKey: 'projects',
        },
      ],
    });
    const result = await harness.service.updateTable(
      't1',
      { displayNameTh: 'ใหม่' },
      'user-id',
    );
    expect(result.displayNameTh).toBe('ใหม่');
    expect(result.domainKey).toBe('projects'); // untouched
    expect(harness.auditRows[0].action).toBe('catalog_table_update');
    expect(
      (harness.auditRows[0].detail as Record<string, unknown>).changedFields,
    ).toEqual(['displayNameTh']);
  });

  it('404s patch on a missing / soft-deleted table', async () => {
    const harness = createCatalogHarness();
    await expectHttpError(
      harness.service.updateTable('ghost', { displayNameTh: 'x' }, 'user-id'),
      404,
      'CATALOG_TABLE_NOT_FOUND',
    );
  });

  it('rejects a rename collision with another LIVE table (409)', async () => {
    const harness = createCatalogHarness({
      tables: [
        { id: 't1', tableName: 'a' },
        { id: 't2', tableName: 'b' },
      ],
    });
    await expectHttpError(
      harness.service.updateTable('t1', { tableName: 'b' }, 'user-id'),
      409,
      'CATALOG_TABLE_NAME_DUPLICATE',
    );
  });

  it('soft-deletes a table + SERVICE-cascades columns & dangling relations', async () => {
    const harness = createCatalogHarness({
      tables: [
        { id: 't1', tableName: 'a' },
        { id: 't2', tableName: 'b' },
      ],
      columns: [
        { id: 'c1', tableId: 't1', columnName: 'id' },
        { id: 'c2', tableId: 't1', columnName: 'name' },
        { id: 'c3', tableId: 't2', columnName: 'id' },
      ],
      relations: [
        { id: 'r1', fromTableId: 't1', toTableId: 't2' },
        { id: 'r2', fromTableId: 't2', toTableId: 't1' },
        { id: 'r3', fromTableId: 't2', toTableId: 't2' },
      ],
    });
    const result = await harness.service.deleteTable('t1', 'user-id');
    expect(result.softDeleted).toBe(true);
    expect(result.columnsSoftDeleted).toBe(2);
    expect(result.relationsSoftDeleted).toBe(2); // r1 + r2 touch t1

    // The table + its columns + both dangling relations are tombstoned;
    // t2's own column + the t2↔t2 relation survive.
    expect(harness.tables.find((t) => t.id === 't1')?.deletedAt).toBeInstanceOf(
      Date,
    );
    expect(harness.columns.find((c) => c.id === 'c1')?.deletedAt).toBeInstanceOf(
      Date,
    );
    expect(harness.columns.find((c) => c.id === 'c3')?.deletedAt).toBeNull();
    expect(harness.relations.find((r) => r.id === 'r1')?.deletedAt).toBeInstanceOf(
      Date,
    );
    expect(harness.relations.find((r) => r.id === 'r3')?.deletedAt).toBeNull();

    // Tombstone audit row BEFORE the table soft-delete.
    expect(harness.auditRows).toHaveLength(1);
    expect(harness.auditRows[0].action).toBe('catalog_table_delete');
    expect(
      harness.spies.auditInsert.mock.invocationCallOrder[0],
    ).toBeLessThan(harness.spies.tableSoftDelete.mock.invocationCallOrder[0]);
  });
});

// ────────────────────────────────────────────────────────────────────
// 3. Column bulk upsert
// ────────────────────────────────────────────────────────────────────

describe('catalog column bulk upsert', () => {
  it('diffs insert / update / soft-delete keyed by columnName', async () => {
    const harness = createCatalogHarness({
      tables: [{ id: 't1', tableName: 'a' }],
      columns: [
        { id: 'c1', tableId: 't1', columnName: 'id', displayOrder: 0 },
        { id: 'c2', tableId: 't1', columnName: 'old', displayOrder: 1 },
      ],
    });
    const result = await harness.service.upsertColumns(
      't1',
      {
        columns: [
          { columnName: 'id', dataType: 'uuid' }, // update
          { columnName: 'name', dataType: 'varchar(200)' }, // insert
        ],
      },
      'user-id',
    );
    expect(result.diff.inserted).toEqual(['name']);
    expect(result.diff.updated).toEqual(['id']);
    expect(result.diff.deleted).toEqual(['old']);
    // 'old' tombstoned; 'id' updated in place; 'name' inserted.
    expect(harness.columns.find((c) => c.id === 'c2')?.deletedAt).toBeInstanceOf(
      Date,
    );
    expect(harness.columns.find((c) => c.id === 'c1')?.dataType).toBe('uuid');
    expect(
      harness.columns.find((c) => c.columnName === 'name')?.tableId,
    ).toBe('t1');
    // ONE batch audit row with the diff.
    expect(harness.auditRows).toHaveLength(1);
    expect(harness.auditRows[0].action).toBe('catalog_column_upsert');
    const detail = harness.auditRows[0].detail as Record<string, unknown>;
    expect(detail.batchUpsert).toBe(true);
    expect(detail.inserted).toEqual(['name']);
  });

  it('uses the array index as displayOrder when omitted', async () => {
    const harness = createCatalogHarness({
      tables: [{ id: 't1', tableName: 'a' }],
    });
    const result = await harness.service.upsertColumns(
      't1',
      { columns: [{ columnName: 'a' }, { columnName: 'b' }] },
      'user-id',
    );
    expect(result.columns.map((c) => [c.columnName, c.displayOrder])).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
  });

  it('clears every column with an empty array', async () => {
    const harness = createCatalogHarness({
      tables: [{ id: 't1', tableName: 'a' }],
      columns: [{ id: 'c1', tableId: 't1', columnName: 'id' }],
    });
    const result = await harness.service.upsertColumns(
      't1',
      { columns: [] },
      'user-id',
    );
    expect(result.diff.deleted).toEqual(['id']);
    expect(result.columns).toHaveLength(0);
  });

  it('rejects a duplicate columnName within the body (400)', async () => {
    const harness = createCatalogHarness({
      tables: [{ id: 't1', tableName: 'a' }],
    });
    await expectHttpError(
      harness.service.upsertColumns(
        't1',
        { columns: [{ columnName: 'dup' }, { columnName: 'dup' }] },
        'user-id',
      ),
      400,
      'CATALOG_COLUMN_DUPLICATE',
    );
    expect(harness.auditRows).toHaveLength(0);
  });

  it('404s upsert on a missing parent table', async () => {
    const harness = createCatalogHarness();
    await expectHttpError(
      harness.service.upsertColumns(
        'ghost',
        { columns: [{ columnName: 'a' }] },
        'user-id',
      ),
      404,
      'CATALOG_TABLE_NOT_FOUND',
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// 4. Relationship CRUD
// ────────────────────────────────────────────────────────────────────

describe('catalog relation CRUD', () => {
  it('creates a relation between two LIVE tables, audits relation_create', async () => {
    const harness = createCatalogHarness({
      tables: [
        { id: 't1', tableName: 'a' },
        { id: 't2', tableName: 'b' },
      ],
    });
    const result = await harness.service.createRelation(
      {
        fromTableId: 't1',
        toTableId: 't2',
        relationType: 'one_to_many',
        labelTh: 'ลบแม่ = ลบตาม',
        onDeleteNote: 'CASCADE',
      },
      'user-id',
    );
    expect(result.relationType).toBe('one_to_many');
    expect(result.onDeleteNote).toBe('CASCADE');
    expect(harness.relations).toHaveLength(1);
    expect(harness.auditRows[0].action).toBe('relation_create');
  });

  it('rejects relating a SOFT-DELETED table (400)', async () => {
    const harness = createCatalogHarness({
      tables: [
        { id: 't1', tableName: 'a' },
        { id: 't2', tableName: 'b', deletedAt: new Date() },
      ],
    });
    await expectHttpError(
      harness.service.createRelation(
        { fromTableId: 't1', toTableId: 't2', relationType: 'one_to_one' },
        'user-id',
      ),
      400,
      'CATALOG_RELATION_TABLE_INVALID',
    );
    expect(harness.auditRows).toHaveLength(0);
  });

  it('rejects a self-loop without allowSelf (400), accepts it WITH allowSelf', async () => {
    const harness = createCatalogHarness({
      tables: [{ id: 't1', tableName: 'a' }],
    });
    await expectHttpError(
      harness.service.createRelation(
        { fromTableId: 't1', toTableId: 't1', relationType: 'one_to_many' },
        'user-id',
      ),
      400,
      'CATALOG_RELATION_SELF_LOOP',
    );
    const ok = await harness.service.createRelation(
      {
        fromTableId: 't1',
        toTableId: 't1',
        relationType: 'one_to_many',
        allowSelf: true,
      },
      'user-id',
    );
    expect(ok.fromTableId).toBe('t1');
    expect(ok.toTableId).toBe('t1');
  });

  it('patches type / label / note / order, audits relation_update', async () => {
    const harness = createCatalogHarness({
      tables: [
        { id: 't1', tableName: 'a' },
        { id: 't2', tableName: 'b' },
      ],
      relations: [
        {
          id: 'r1',
          fromTableId: 't1',
          toTableId: 't2',
          relationType: 'one_to_one',
        },
      ],
    });
    const result = await harness.service.updateRelation(
      'r1',
      { relationType: 'many_to_many', labelTh: 'ป้ายใหม่' },
      'user-id',
    );
    expect(result.relationType).toBe('many_to_many');
    expect(result.labelTh).toBe('ป้ายใหม่');
    expect(harness.auditRows[0].action).toBe('relation_update');
    expect(
      (harness.auditRows[0].detail as Record<string, unknown>).changedFields,
    ).toEqual(['relationType', 'labelTh']);
  });

  it('404s patch on a missing relation', async () => {
    const harness = createCatalogHarness();
    await expectHttpError(
      harness.service.updateRelation('ghost', { labelTh: 'x' }, 'user-id'),
      404,
      'CATALOG_RELATION_NOT_FOUND',
    );
  });

  it('soft-deletes a relation with the audit row BEFORE deletedAt', async () => {
    const harness = createCatalogHarness({
      relations: [{ id: 'r1', fromTableId: 't1', toTableId: 't2' }],
    });
    const result = await harness.service.deleteRelation('r1', 'user-id');
    expect(result.softDeleted).toBe(true);
    expect(harness.relations.find((r) => r.id === 'r1')?.deletedAt).toBeInstanceOf(
      Date,
    );
    expect(harness.auditRows[0].action).toBe('relation_delete');
    expect(
      harness.spies.auditInsert.mock.invocationCallOrder[0],
    ).toBeLessThan(
      harness.spies.relationSoftDelete.mock.invocationCallOrder[0],
    );
  });

  it('404s delete on an already-deleted relation', async () => {
    const harness = createCatalogHarness({
      relations: [{ id: 'r1', fromTableId: 't1', toTableId: 't2', deletedAt: new Date() }],
    });
    await expectHttpError(
      harness.service.deleteRelation('r1', 'user-id'),
      404,
      'CATALOG_RELATION_NOT_FOUND',
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// 5. Seed (Q-02) — idempotent import from entity metadata (read-only)
// ────────────────────────────────────────────────────────────────────

describe('catalog seed-from-entity (Q-02)', () => {
  const META = [
    {
      tableName: 'project_groups',
      synchronize: true,
      tableType: 'regular',
      columns: [
        { databaseName: 'id', type: 'uuid', isNullable: false },
        { databaseName: 'title', type: 'varchar', length: '300', isNullable: false },
      ],
    },
    {
      tableName: 'tracking_status',
      synchronize: true,
      tableType: 'regular',
      columns: [{ databaseName: 'id', type: 'uuid', isNullable: false }],
    },
    // A view / non-synchronized entity → MUST be skipped.
    {
      tableName: 'some_view',
      synchronize: false,
      tableType: 'view',
      columns: [{ databaseName: 'x', type: 'int', isNullable: true }],
    },
  ];

  it('imports regular entities (read-only), skips views, audits a batch row', async () => {
    const harness = createCatalogHarness({ entityMetadatas: META });
    const result = await harness.service.seedFromEntities('user-id');
    expect(result.tablesInserted).toBe(2);
    expect(result.columnsInserted).toBe(3);
    expect(harness.tables.map((t) => t.tableName).sort()).toEqual([
      'project_groups',
      'tracking_status',
    ]);
    // Seeded rows carry is_seeded=true; column type rendered as plain text.
    expect(harness.tables.every((t) => t.isSeeded === true)).toBe(true);
    const titleCol = harness.columns.find((c) => c.columnName === 'title');
    expect(titleCol?.dataType).toBe('varchar(300)');
    expect(titleCol?.isNullable).toBe(false);
    // ONE batch audit row.
    expect(harness.auditRows).toHaveLength(1);
    expect(harness.auditRows[0].action).toBe('catalog_table_create');
    expect(
      (harness.auditRows[0].detail as Record<string, unknown>).seedBatch,
    ).toBe(true);
  });

  it('is idempotent — a second run inserts ZERO duplicates', async () => {
    const harness = createCatalogHarness({ entityMetadatas: META });
    await harness.service.seedFromEntities('user-id');
    const countAfterFirst = harness.tables.length;
    const second = await harness.service.seedFromEntities('user-id');
    expect(second.tablesInserted).toBe(0);
    expect(second.skippedTableNames.sort()).toEqual([
      'project_groups',
      'tracking_status',
    ]);
    expect(harness.tables).toHaveLength(countAfterFirst);
  });

  it('PRESERVES a hand-edited row across re-seed (skip by table_name)', async () => {
    const harness = createCatalogHarness({
      tables: [
        {
          id: 't1',
          tableName: 'project_groups',
          displayNameTh: 'ชื่อที่แก้เอง',
          isSeeded: false,
        },
      ],
      entityMetadatas: META,
    });
    const result = await harness.service.seedFromEntities('user-id');
    // project_groups skipped (admin edit preserved); only tracking_status added.
    expect(result.skippedTableNames).toContain('project_groups');
    expect(
      harness.tables.find((t) => t.id === 't1')?.displayNameTh,
    ).toBe('ชื่อที่แก้เอง');
  });
});
