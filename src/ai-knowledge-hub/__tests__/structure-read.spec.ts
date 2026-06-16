/**
 * Wave wave-ai-knowledge-structure-mgmt — BE-01 (2026-06-13).
 *
 * Acceptance specs for the BE-01 read changes:
 *
 *   1. `GET /map` overlay merge — overlay-not-replacement (report §4.2):
 *      a `label_th_override` row re-skins the node; description / order /
 *      colour / icon / hidden flow through; `is_hidden` omits the node.
 *   2. SAFE FALLBACK — with an EMPTY overlay table the map falls back to
 *      the code descriptor verbatim (label, layer, tool list), and the
 *      additive display fields take their code defaults (description =
 *      null, displayOrder = code order, colorToken / iconKey = null,
 *      isHidden = false). This is the "byte-identical day one" proof.
 *   3. `GET /structure` aggregator — merged domains (incl. hidden, with
 *      unmerged code labels + codeOrigin), merged gaps, nested catalog,
 *      full tool registry, and the `unmappedTools[]` orphan detector
 *      (EMPTY when the code bijection holds).
 *   4. ZERO-WRITE proof (§18.13 condition 2): neither `getKnowledgeMap`
 *      nor `getStructure` touches a mutating repository method — the
 *      mutation surface throws on touch.
 *   5. Role gate (2026-06-16 super-admin-only narrowing): `GET /structure`
 *      declares `@Roles(...SUPER_ADMIN_ONLY)` through the canonical
 *      `RolesGuard`; super-admin only → 200, everyone else (user / staff /
 *      admin / c-level) → 403.
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { EXECUTIVE_TOOL_NAMES } from '../../ai-executive-chat/tools/tool-registry';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { SUPER_ADMIN_ONLY } from '../../auth/role-groups';
import { ROLES_KEY } from '../../auth/roles.decorator';
import { Role } from '../../auth/roles.enum';
import { RolesGuard } from '../../auth/roles.guard';
import { WorkStatusApprovedGuard } from '../../auth/work-status-approved.guard';
import {
  AiKnowledgeHubService,
  KNOWLEDGE_MAP_CENTER_LABEL,
} from '../ai-knowledge-hub.service';
import { KnowledgeStructureController } from '../controllers/knowledge-structure.controller';
import { AiKnowledgeDomainMeta } from '../entities/ai-knowledge-domain-meta.entity';
import {
  COVERAGE_GAPS,
  CURATED_DOMAINS,
  KNOWLEDGE_DOMAINS,
} from '../registry/derived-domain-map';

// ────────────────────────────────────────────────────────────────────
// Read-only repository stubs — mutating surface throws (§18.13 tripwire)
// ────────────────────────────────────────────────────────────────────

const MUTATION_METHODS = [
  'save',
  'insert',
  'update',
  'upsert',
  'delete',
  'softDelete',
  'softRemove',
  'remove',
  'restore',
  'increment',
  'decrement',
  'clear',
  'query',
] as const;

interface ReadOnlyRepoStub {
  repo: Record<string, jest.Mock>;
  mutationSpies: jest.Mock[];
}

/**
 * A repository stub whose query builders resolve a queued result and
 * whose mutating surface throws on touch. `getRawMany` (grouped counts)
 * and `getMany` (overlay / catalog rows) both drain the SAME queue, in
 * call order — so a single stub can back a repo that the service reads
 * via either terminal. Every chainable used by the BE-01 read paths is
 * present (incl. `orderBy` / `addOrderBy`).
 */
function createReadOnlyRepoStub(resultQueue: unknown[][]): ReadOnlyRepoStub {
  const queue = [...resultQueue];
  const mutationSpies: jest.Mock[] = [];

  const createQueryBuilder = jest.fn(() => {
    const rows = queue.shift() ?? [];
    const qb: Record<string, jest.Mock> = {};
    for (const chainable of [
      'select',
      'addSelect',
      'where',
      'andWhere',
      'groupBy',
      'addGroupBy',
      'orderBy',
      'addOrderBy',
      'withDeleted',
    ]) {
      qb[chainable] = jest.fn(() => qb);
    }
    qb.getRawMany = jest.fn(async () => rows);
    qb.getMany = jest.fn(async () => rows);
    return qb;
  });

  const repo: Record<string, jest.Mock> = { createQueryBuilder };
  for (const method of MUTATION_METHODS) {
    const spy = jest.fn(() => {
      throw new Error(
        `ZERO-WRITE VIOLATION: repository.${method}() called from a BE-01 read path (§18.13)`,
      );
    });
    repo[method] = spy;
    mutationSpies.push(spy);
  }
  return { repo, mutationSpies };
}

/** Inert BE-02 CRUD deps (revision / work-history / audit) — unused by reads. */
function createInertCrudDeps() {
  return {
    revisionRepo: createReadOnlyRepoStub([]).repo,
    workHistoryRepo: { findOne: jest.fn() },
    auditService: {
      record: jest.fn(() => {
        throw new Error(
          'ZERO-WRITE VIOLATION: audit write from a BE-01 read path (§18.13)',
        );
      }),
    },
  };
}

/** Minimal overlay row factory — only the fields the merge reads. */
function overlayRow(
  partial: Partial<AiKnowledgeDomainMeta> &
    Pick<AiKnowledgeDomainMeta, 'domainKey' | 'nodeKind'>,
): AiKnowledgeDomainMeta {
  return {
    id: `id-${partial.domainKey}`,
    labelThOverride: null,
    labelEnOverride: null,
    descriptionTh: null,
    displayOrder: 0,
    colorToken: null,
    iconKey: null,
    isHidden: false,
    gapReasonTh: null,
    createdByWorkHistoryId: '00000000-0000-0000-0000-000000000000',
    updatedByWorkHistoryId: '00000000-0000-0000-0000-000000000000',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...partial,
  } as AiKnowledgeDomainMeta;
}

/**
 * Build a service with the FULL positional constructor. `overlayRows` /
 * catalog rows back the BE-01 repos; counts / freshness / sources are
 * empty unless overridden. The trailing repos are the BE-01 additions.
 */
function buildService(opts: {
  overlay?: unknown[];
  catalogTables?: unknown[];
  catalogColumns?: unknown[];
  catalogRelations?: unknown[];
  entryQueue?: unknown[][];
  sourceQueue?: unknown[][];
}) {
  const entryStub = createReadOnlyRepoStub(opts.entryQueue ?? [[], []]);
  const sourceStub = createReadOnlyRepoStub(opts.sourceQueue ?? [[]]);
  const overlayStub = createReadOnlyRepoStub([opts.overlay ?? []]);
  const tableStub = createReadOnlyRepoStub([opts.catalogTables ?? []]);
  const columnStub = createReadOnlyRepoStub([opts.catalogColumns ?? []]);
  const relationStub = createReadOnlyRepoStub([opts.catalogRelations ?? []]);
  const crudDeps = createInertCrudDeps();

  const service = new AiKnowledgeHubService(
    entryStub.repo as never,
    crudDeps.revisionRepo as never,
    crudDeps.workHistoryRepo as never,
    crudDeps.auditService as never,
    null as never,
    sourceStub.repo as never,
    overlayStub.repo as never,
    tableStub.repo as never,
    columnStub.repo as never,
    relationStub.repo as never,
  );

  return {
    service,
    mutationSpies: [
      ...entryStub.mutationSpies,
      ...sourceStub.mutationSpies,
      ...overlayStub.mutationSpies,
      ...tableStub.mutationSpies,
      ...columnStub.mutationSpies,
      ...relationStub.mutationSpies,
    ],
    crudAudit: crudDeps.auditService.record,
  };
}

// ────────────────────────────────────────────────────────────────────
// 1. GET /map — overlay merge (overlay-not-replacement)
// ────────────────────────────────────────────────────────────────────

describe('getKnowledgeMap — overlay merge', () => {
  it('applies label / description / colour / icon / order overrides', async () => {
    const { service } = buildService({
      overlay: [
        overlayRow({
          domainKey: 'budget',
          nodeKind: 'domain',
          labelThOverride: 'งบประมาณ (แก้แล้ว)',
          labelEnOverride: 'Budget (edited)',
          descriptionTh: 'หมวดงบประมาณ',
          displayOrder: 0,
          colorToken: 'violet',
          iconKey: 'banknote',
        }),
      ],
    });

    const map = await service.getKnowledgeMap();
    const budget = map.domains.find((d) => d.key === 'budget');

    expect(budget?.labelTh).toBe('งบประมาณ (แก้แล้ว)');
    expect(budget?.labelEn).toBe('Budget (edited)');
    expect(budget?.description).toBe('หมวดงบประมาณ');
    expect(budget?.colorToken).toBe('violet');
    expect(budget?.iconKey).toBe('banknote');
    expect(budget?.isHidden).toBe(false);
    // Tool binding still comes from CODE (overlay is display-only).
    expect(budget?.tools.map((t) => t.name)).toEqual([
      'getBudgetSummaryByPlan',
      'highlightBudgetOutliers',
    ]);
  });

  it('omits a hidden domain from the map render', async () => {
    const { service } = buildService({
      overlay: [
        overlayRow({
          domainKey: 'budget',
          nodeKind: 'domain',
          isHidden: true,
        }),
      ],
    });

    const map = await service.getKnowledgeMap();
    expect(map.domains.find((d) => d.key === 'budget')).toBeUndefined();
    // Other domains still render.
    expect(map.domains.find((d) => d.key === 'projects')).toBeDefined();
  });

  it('re-orders the ring by overlay displayOrder', async () => {
    // Force `budget` (a late code domain) to the very front.
    const { service } = buildService({
      overlay: [
        overlayRow({
          domainKey: 'budget',
          nodeKind: 'domain',
          displayOrder: -1,
        }),
      ],
    });

    const map = await service.getKnowledgeMap();
    expect(map.domains[0]?.key).toBe('budget');
  });

  it('merges + re-labels a code coverage gap via a gap overlay row', async () => {
    const { service } = buildService({
      overlay: [
        overlayRow({
          domainKey: 'equipment',
          nodeKind: 'gap',
          labelThOverride: 'ครุภัณฑ์ (แก้)',
          gapReasonTh: 'ยังไม่มีเครื่องมือ',
          displayOrder: 0,
        }),
      ],
    });

    const map = await service.getKnowledgeMap();
    const equipment = map.coverageGaps.find((g) => g.key === 'equipment');
    expect(equipment?.labelTh).toBe('ครุภัณฑ์ (แก้)');
    expect(equipment?.reason).toBe('ยังไม่มีเครื่องมือ');
    // No duplicate — code gap + overlay de-duped by key.
    expect(map.coverageGaps.filter((g) => g.key === 'equipment')).toHaveLength(
      1,
    );
  });

  it('adds a UI-only gap node not present in code', async () => {
    const { service } = buildService({
      overlay: [
        overlayRow({
          domainKey: 'attachments',
          nodeKind: 'gap',
          labelThOverride: 'เอกสารแนบ',
          gapReasonTh: 'ยังไม่ทำดัชนี',
          displayOrder: 5,
        }),
      ],
    });

    const map = await service.getKnowledgeMap();
    const added = map.coverageGaps.find((g) => g.key === 'attachments');
    expect(added?.labelTh).toBe('เอกสารแนบ');
    expect(added?.reason).toBe('ยังไม่ทำดัชนี');
  });

  it('ignores a stale overlay row whose domainKey is gone from code', async () => {
    const { service } = buildService({
      overlay: [
        overlayRow({ domainKey: 'ghost-domain', nodeKind: 'domain' }),
      ],
    });

    const map = await service.getKnowledgeMap();
    // The stale key does NOT become a phantom node (code is the
    // existence source of truth).
    expect(map.domains.find((d) => d.key === 'ghost-domain')).toBeUndefined();
    expect(map.domains).toHaveLength(
      KNOWLEDGE_DOMAINS.length + CURATED_DOMAINS.length,
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// 2. GET /map — SAFE FALLBACK (empty overlay → code verbatim)
// ────────────────────────────────────────────────────────────────────

describe('getKnowledgeMap — safe fallback (empty overlay)', () => {
  it('renders code descriptors verbatim with default display fields', async () => {
    const { service } = buildService({ overlay: [] });
    const map = await service.getKnowledgeMap();

    expect(map.centerLabel).toBe(KNOWLEDGE_MAP_CENTER_LABEL);
    expect(map.domains).toHaveLength(
      KNOWLEDGE_DOMAINS.length + CURATED_DOMAINS.length,
    );

    // Code order is preserved (stable sort over equal/code-index order).
    expect(map.domains.map((d) => d.key)).toEqual([
      ...KNOWLEDGE_DOMAINS.map((d) => d.key),
      ...CURATED_DOMAINS.map((d) => d.key),
    ]);

    // Every domain: code label + safe display-field defaults.
    map.domains.forEach((domain, index) => {
      const code = [...KNOWLEDGE_DOMAINS, ...CURATED_DOMAINS][index];
      expect(domain.labelTh).toBe(code.labelTh);
      expect(domain.labelEn).toBe(code.labelEn);
      expect(domain.layer).toBe(code.layer);
      expect(domain.description).toBeNull();
      expect(domain.colorToken).toBeNull();
      expect(domain.iconKey).toBeNull();
      expect(domain.isHidden).toBe(false);
      expect(domain.displayOrder).toBe(index);
      expect(domain.editableBy).toEqual(['admin', 'super-admin']);
    });

    // Coverage gaps fall back to code values + code order.
    expect(map.coverageGaps.map((g) => g.key)).toEqual(
      COVERAGE_GAPS.map((g) => g.key),
    );
    map.coverageGaps.forEach((gap, index) => {
      expect(gap.labelTh).toBe(COVERAGE_GAPS[index].labelTh);
      expect(gap.reason).toBe(COVERAGE_GAPS[index].reason);
      expect(gap.isHidden).toBe(false);
      expect(gap.displayOrder).toBe(index);
    });
  });

  it('degrades to code fallback when the overlay repository is absent', async () => {
    // Reproduce the positional-spec safety: trailing repos undefined.
    const entryStub = createReadOnlyRepoStub([[], []]);
    const sourceStub = createReadOnlyRepoStub([[]]);
    const crudDeps = createInertCrudDeps();
    const service = new AiKnowledgeHubService(
      entryStub.repo as never,
      crudDeps.revisionRepo as never,
      crudDeps.workHistoryRepo as never,
      crudDeps.auditService as never,
      null as never,
      sourceStub.repo as never,
      // domainMeta + catalog repos default to null
    );

    const map = await service.getKnowledgeMap();
    expect(map.domains).toHaveLength(
      KNOWLEDGE_DOMAINS.length + CURATED_DOMAINS.length,
    );
    expect(map.domains.every((d) => !d.isHidden)).toBe(true);
    expect(map.domains.map((d) => d.key)).toEqual([
      ...KNOWLEDGE_DOMAINS.map((d) => d.key),
      ...CURATED_DOMAINS.map((d) => d.key),
    ]);
  });
});

// ────────────────────────────────────────────────────────────────────
// 3. GET /structure — aggregator shape
// ────────────────────────────────────────────────────────────────────

describe('getStructure — editor aggregator', () => {
  it('returns merged domains (incl. hidden) with unmerged code labels + codeOrigin', async () => {
    const { service } = buildService({
      overlay: [
        overlayRow({
          domainKey: 'budget',
          nodeKind: 'domain',
          labelThOverride: 'งบประมาณ (แก้)',
          isHidden: true,
          displayOrder: 3,
        }),
      ],
    });

    const structure = await service.getStructure();
    expect(structure.centerLabel).toBe(KNOWLEDGE_MAP_CENTER_LABEL);

    // Editor view includes hidden domains.
    const budget = structure.domains.find((d) => d.key === 'budget');
    expect(budget).toBeDefined();
    expect(budget?.isHidden).toBe(true);
    expect(budget?.labelTh).toBe('งบประมาณ (แก้)');
    // Code label preserved for "คืนค่าจากระบบ".
    expect(budget?.codeLabelTh).toBe('งบประมาณ');
    expect(budget?.codeOrigin).toBe(true);
    expect(budget?.hasOverlay).toBe(true);

    // A domain with no overlay row → hasOverlay false, code labels.
    const projects = structure.domains.find((d) => d.key === 'projects');
    expect(projects?.hasOverlay).toBe(false);
    expect(projects?.labelTh).toBe(projects?.codeLabelTh);
  });

  it('exposes the full tool registry and an EMPTY unmappedTools (bijection holds)', async () => {
    const { service } = buildService({ overlay: [] });
    const structure = await service.getStructure();

    expect(structure.toolRegistry.map((t) => t.name).sort()).toEqual(
      [...EXECUTIVE_TOOL_NAMES].sort(),
    );
    // Code map is complete → no orphans.
    expect(structure.unmappedTools).toEqual([]);
    expect(structure.staleOverlayKeys).toEqual([]);
  });

  it('surfaces stale overlay keys for admin cleanup', async () => {
    const { service } = buildService({
      overlay: [
        overlayRow({ domainKey: 'ghost-domain', nodeKind: 'domain' }),
      ],
    });
    const structure = await service.getStructure();
    expect(structure.staleOverlayKeys).toEqual(['ghost-domain']);
    // …but the ghost never becomes a node.
    expect(
      structure.domains.find((d) => d.key === 'ghost-domain'),
    ).toBeUndefined();
  });

  it('nests catalog columns under their parent table and maps relations', async () => {
    const { service } = buildService({
      catalogTables: [
        {
          id: 't1',
          tableName: 'ai_knowledge_entries',
          displayNameTh: 'องค์ความรู้',
          descriptionTh: 'ตารางองค์ความรู้',
          domainKey: 'glossary',
          isSeeded: true,
          displayOrder: 0,
        },
      ],
      catalogColumns: [
        {
          id: 'c1',
          tableId: 't1',
          columnName: 'id',
          dataType: 'uuid',
          isNullable: false,
          descriptionTh: null,
          isPii: false,
          displayOrder: 0,
        },
        // orphan column whose parent table is absent → dropped
        {
          id: 'c2',
          tableId: 'missing',
          columnName: 'x',
          dataType: null,
          isNullable: true,
          descriptionTh: null,
          isPii: false,
          displayOrder: 0,
        },
      ],
      catalogRelations: [
        {
          id: 'r1',
          fromTableId: 't1',
          toTableId: 't1',
          relationType: 'one_to_many',
          labelTh: 'มีหลายรุ่น',
          onDeleteNote: 'CASCADE',
          displayOrder: 0,
        },
      ],
    });

    const structure = await service.getStructure();
    expect(structure.catalog.tables).toHaveLength(1);
    const table = structure.catalog.tables[0];
    expect(table.tableName).toBe('ai_knowledge_entries');
    expect(table.columns.map((c) => c.id)).toEqual(['c1']); // orphan dropped
    expect(structure.catalog.relations).toHaveLength(1);
    expect(structure.catalog.relations[0].relationType).toBe('one_to_many');
    expect(structure.catalog.relations[0].onDeleteNote).toBe('CASCADE');
  });

  it('returns an empty catalog when no rows / repos exist', async () => {
    const { service } = buildService({ overlay: [] });
    const structure = await service.getStructure();
    expect(structure.catalog).toEqual({ tables: [], relations: [] });
  });
});

// ────────────────────────────────────────────────────────────────────
// 4. ZERO-WRITE proof (§18.13 condition 2)
// ────────────────────────────────────────────────────────────────────

describe('BE-01 reads are zero-write (§18.13)', () => {
  it('getKnowledgeMap touches no mutating repository method', async () => {
    const { service, mutationSpies, crudAudit } = buildService({
      overlay: [overlayRow({ domainKey: 'budget', nodeKind: 'domain' })],
    });
    await service.getKnowledgeMap();
    for (const spy of mutationSpies) expect(spy).not.toHaveBeenCalled();
    expect(crudAudit).not.toHaveBeenCalled();
  });

  it('getStructure touches no mutating repository method', async () => {
    const { service, mutationSpies, crudAudit } = buildService({
      overlay: [overlayRow({ domainKey: 'budget', nodeKind: 'domain' })],
      catalogTables: [
        {
          id: 't1',
          tableName: 'x',
          displayNameTh: 'x',
          descriptionTh: null,
          domainKey: null,
          isSeeded: false,
          displayOrder: 0,
        },
      ],
    });
    await service.getStructure();
    for (const spy of mutationSpies) expect(spy).not.toHaveBeenCalled();
    expect(crudAudit).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────
// 5. Role gate — real controller metadata through the canonical guard
// ────────────────────────────────────────────────────────────────────

describe('GET /v1/ai-knowledge-hub/structure — role gate (2026-06-16 super-admin-only narrowing)', () => {
  const handler = KnowledgeStructureController.prototype.getStructure;
  const guard = new RolesGuard(new Reflector());

  const contextForRole = (role: string): ExecutionContext =>
    ({
      getHandler: () => handler,
      getClass: () => KnowledgeStructureController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    }) as unknown as ExecutionContext;

  it('declares @Roles(...SUPER_ADMIN_ONLY) on the structure handler', () => {
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([
      ...SUPER_ADMIN_ONLY,
    ]);
  });

  it('mirrors the map-controller guard chain (Jwt → Roles → WorkStatus)', () => {
    expect(Reflect.getMetadata('__guards__', handler)).toEqual([
      JwtAuthGuard,
      RolesGuard,
      WorkStatusApprovedGuard,
    ]);
  });

  it('super-admin passes the role gate (→ 200 path)', () => {
    expect(guard.canActivate(contextForRole(Role.SUPER_ADMIN))).toBe(true);
  });

  it.each([Role.USER, Role.STAFF, Role.ADMIN, Role.C_LEVEL])(
    'role "%s" is rejected with 403 FORBIDDEN_ROLE',
    (role) => {
      expect(() => guard.canActivate(contextForRole(role))).toThrow(
        ForbiddenException,
      );
    },
  );
});
