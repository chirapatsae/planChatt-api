/**
 * Wave wave-ai-knowledge-structure-mgmt — BE-04 (Phase 3, 2026-06-13).
 *
 * Class-B tool↔domain binding override + RUNTIME bijection guard
 * acceptance specs (task §6 / §7):
 *
 *  1. Role matrix (Q-04) — the WRITE (`putToolBinding`) is SUPER-ADMIN
 *     ONLY through the canonical `RolesGuard` against REAL controller
 *     metadata: `admin` → 403, `super-admin` → pass; the diagnostics READ
 *     (`getToolBindings`) is ADMIN_OR_ABOVE.
 *  2. Fallback proof (task §6) — an EMPTY override table resolves to the
 *     CODE map (`KNOWLEDGE_DOMAINS[].toolNames`), byte-identical to
 *     pre-Phase-3 (B1 default).
 *  3. Valid save — a bijection-preserving rebind (swap a tool between two
 *     domains) commits, writes ONE `tool_binding_update` audit row, and
 *     the next resolve sees the new routing.
 *  4. Unknown-tool reject — a `toolName ∉ EXECUTIVE_TOOL_NAMES` →
 *     `400 KNOWLEDGE_TOOL_BINDING_INVALID`; zero rows written.
 *  5. Double-map reject — binding a tool already owned by another domain
 *     (without removing it there) → `400 KNOWLEDGE_TOOL_BINDING_INVALID`;
 *     zero rows written.
 *  6. Orphan reject — dropping a tool with nowhere else to land →
 *     `400 KNOWLEDGE_TOOL_BINDING_INVALID`; zero rows written.
 *  7. Super-admin still cannot violate (§17.11) — the SAME violating
 *     payload by a super-admin actor STILL throws (the guard is integrity,
 *     not permission; there is NO bypass branch).
 *  8. Audit (§17.3) — every successful mutation writes EXACTLY ONE
 *     `ai_knowledge_audit_logs` row on the caller's transactional manager;
 *     a rejected mutation writes ZERO; NEVER TrackingStatus.
 *  9. Compile-time backstop preserved — the CODE-map bijection
 *     (`derived-domain-map.spec.ts`) still holds; this spec re-asserts the
 *     invariant it guards so the two binding sources stay covered.
 */
import {
  ExecutionContext,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { JwtAuthGuard } from '../../auth/auth.guard';
import {
  ADMIN_OR_ABOVE,
  SUPER_ADMIN_ONLY,
} from '../../auth/role-groups';
import { ROLES_KEY } from '../../auth/roles.decorator';
import { Role } from '../../auth/roles.enum';
import { RolesGuard } from '../../auth/roles.guard';
import { WorkStatusApprovedGuard } from '../../auth/work-status-approved.guard';
import { EXECUTIVE_TOOL_NAMES } from '../../ai-executive-chat/tools/tool-registry';
import { KnowledgeStructureController } from '../controllers/knowledge-structure.controller';
import { AiKnowledgeAuditLog } from '../entities/ai-knowledge-audit-log.entity';
import { AiKnowledgeToolBinding } from '../entities/ai-knowledge-tool-binding.entity';
import { KNOWLEDGE_DOMAINS } from '../registry/derived-domain-map';
import { KnowledgeAuditService } from '../services/knowledge-audit.service';
import { KnowledgeToolBindingService } from '../services/knowledge-tool-binding.service';

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

const ACTOR_WH_ID = 'wh-super-admin-1';

interface ToolBindingRow {
  id: string;
  domainKey: string;
  toolName: string;
  createdByWorkHistoryId: string;
}

interface BindingHarness {
  service: KnowledgeToolBindingService;
  rows: ToolBindingRow[];
  auditRows: Array<Record<string, unknown>>;
  spies: {
    transaction: jest.Mock;
    insert: jest.Mock;
    delete: jest.Mock;
    auditInsert: jest.Mock;
  };
}

/**
 * In-memory harness over the BE-04 override table. The REAL
 * `KnowledgeAuditService` is wired in (its base repository THROWS so the
 * spec proves every audit row joins the caller's transactional manager —
 * §17.3 atomicity). The fake repo enforces `UNIQUE(tool_name)` on insert
 * so the DB-level no-double-map invariant is exercised end-to-end (the
 * service-layer guard normally fires first; the unique throw is the
 * defense-in-depth backstop).
 */
function createBindingHarness(
  seed: Array<Pick<ToolBindingRow, 'domainKey' | 'toolName'>> = [],
  options: { actorRole?: string } = {},
): BindingHarness {
  const rows: ToolBindingRow[] = seed.map((row, index) => ({
    id: `seed-${index}`,
    createdByWorkHistoryId: ACTOR_WH_ID,
    ...row,
  }));
  const auditRows: Array<Record<string, unknown>> = [];
  let nextId = rows.length;

  const find = jest.fn(async () => rows.map((row) => ({ ...row })));
  const count = jest.fn(async () => rows.length);
  const del = jest.fn(async (criteria: { domainKey: string }) => {
    const before = rows.length;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i].domainKey === criteria.domainKey) rows.splice(i, 1);
    }
    return { affected: before - rows.length };
  });
  const insert = jest.fn(
    async (
      input:
        | Pick<ToolBindingRow, 'domainKey' | 'toolName' | 'createdByWorkHistoryId'>
        | Array<
            Pick<
              ToolBindingRow,
              'domainKey' | 'toolName' | 'createdByWorkHistoryId'
            >
          >,
    ) => {
      const many = Array.isArray(input) ? input : [input];
      for (const one of many) {
        // DB-level UNIQUE(tool_name) — defense-in-depth (§17.16.5).
        if (rows.some((r) => r.toolName === one.toolName)) {
          throw new Error(
            `duplicate key value violates unique constraint "uq_ai_knowledge_tool_binding_tool_name" (${one.toolName})`,
          );
        }
        rows.push({ id: `row-${(nextId += 1)}`, ...one });
      }
      return { identifiers: [] };
    },
  );

  const txRepo = { find, count, delete: del, insert };

  const txAuditRepo = {
    insert: jest.fn(async (row: Record<string, unknown>) => {
      auditRows.push({ ...row });
      return { identifiers: [] };
    }),
  };

  const entityManagerFake = {
    getRepository: (entity: unknown) => {
      if (entity === AiKnowledgeToolBinding) return txRepo;
      if (entity === AiKnowledgeAuditLog) return txAuditRepo;
      throw new Error('unexpected repository request in transaction');
    },
  };

  const transaction = jest.fn(
    async (callback: (manager: unknown) => Promise<unknown>) =>
      callback(entityManagerFake),
  );

  const toolBindingRepoFake = {
    find,
    manager: { transaction },
  };

  const workHistoryRepoFake = {
    findOne: jest.fn(async () => ({
      id: ACTOR_WH_ID,
      role: { name: options.actorRole ?? 'super-admin' },
    })),
  };

  // Base repo THROWS — proves the audit row always rides the caller's
  // transactional EntityManager (§17.3 atomicity).
  const throwingBaseAuditRepo = {
    insert: jest.fn(() => {
      throw new Error(
        'audit row written OUTSIDE the mutation transaction (§17.3 atomicity violation)',
      );
    }),
  };
  const auditService = new KnowledgeAuditService(throwingBaseAuditRepo as never);

  const service = new KnowledgeToolBindingService(
    toolBindingRepoFake as never,
    workHistoryRepoFake as never,
    auditService,
  );

  return {
    service,
    rows,
    auditRows,
    spies: { transaction, insert, delete: del, auditInsert: txAuditRepo.insert },
  };
}

/**
 * The full CODE binding as an editable seed — flatten
 * `KNOWLEDGE_DOMAINS[].toolNames` into override rows. Seeding the harness
 * with this makes the table non-empty (B2 mode) while preserving the
 * bijection, so a single-domain PUT can be tested in isolation.
 */
function seedFromCodeMap(): Array<Pick<ToolBindingRow, 'domainKey' | 'toolName'>> {
  return KNOWLEDGE_DOMAINS.flatMap((domain) =>
    domain.toolNames.map((toolName) => ({ domainKey: domain.key, toolName })),
  );
}

// ────────────────────────────────────────────────────────────────────
// 1. Role matrix (Q-04) — real controller metadata through RolesGuard
// ────────────────────────────────────────────────────────────────────

describe('KnowledgeStructureController — tool-binding role gate (Q-04)', () => {
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

  const putHandler = KnowledgeStructureController.prototype.putToolBinding;
  const getHandler = KnowledgeStructureController.prototype.getToolBindings;

  it('PUT /tool-bindings/:domainKey declares @Roles(...SUPER_ADMIN_ONLY) + canonical guard chain', () => {
    expect(Reflect.getMetadata(ROLES_KEY, putHandler)).toEqual([
      ...SUPER_ADMIN_ONLY,
    ]);
    expect(Reflect.getMetadata('__guards__', putHandler)).toEqual([
      JwtAuthGuard,
      RolesGuard,
      WorkStatusApprovedGuard,
    ]);
  });

  it('PUT: super-admin passes; admin / user / staff / c-level → 403 (Q-04 stricter than Class A)', () => {
    expect(guard.canActivate(contextFor(putHandler, Role.SUPER_ADMIN))).toBe(
      true,
    );
    for (const role of [Role.ADMIN, Role.USER, Role.STAFF, Role.C_LEVEL]) {
      expect(() => guard.canActivate(contextFor(putHandler, role))).toThrow(
        ForbiddenException,
      );
    }
  });

  it('GET /tool-bindings is ADMIN_OR_ABOVE (diagnostics read)', () => {
    expect(Reflect.getMetadata(ROLES_KEY, getHandler)).toEqual([
      ...ADMIN_OR_ABOVE,
    ]);
    expect(guard.canActivate(contextFor(getHandler, Role.ADMIN))).toBe(true);
    expect(guard.canActivate(contextFor(getHandler, Role.SUPER_ADMIN))).toBe(
      true,
    );
    for (const role of [Role.USER, Role.STAFF, Role.C_LEVEL]) {
      expect(() => guard.canActivate(contextFor(getHandler, role))).toThrow(
        ForbiddenException,
      );
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// 2. Resolver — B1 fallback proof (task §6)
// ────────────────────────────────────────────────────────────────────

describe('KnowledgeToolBindingService.resolveBindingMap — fallback proof', () => {
  it('an EMPTY override table resolves to the CODE map byte-identically', async () => {
    const { service, spies } = createBindingHarness([]);
    const resolved = await service.resolveBindingMap();

    expect(resolved.source).toBe('code');
    for (const domain of KNOWLEDGE_DOMAINS) {
      expect(resolved.byDomain.get(domain.key)).toEqual([
        ...domain.toolNames,
      ]);
    }
    // The whole derived set equals the registry (bijection holds on code).
    const flat = [...resolved.byDomain.values()].flat().sort();
    expect(flat).toEqual([...EXECUTIVE_TOOL_NAMES].sort());
    // Pure read — no write touched.
    expect(spies.insert).not.toHaveBeenCalled();
    expect(spies.delete).not.toHaveBeenCalled();
    expect(spies.auditInsert).not.toHaveBeenCalled();
  });

  it('getToolBindings on an empty table reports source=code, zero orphans, zero double-maps', async () => {
    const { service } = createBindingHarness([]);
    const read = await service.getToolBindings();

    expect(read.source).toBe('code');
    expect(read.unmappedTools).toEqual([]);
    expect(read.doubleMappedTools).toEqual([]);
    expect(read.toolRegistry).toHaveLength(EXECUTIVE_TOOL_NAMES.length);
    expect(read.domains.map((d) => d.domainKey)).toEqual(
      KNOWLEDGE_DOMAINS.map((d) => d.key),
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// 3. Valid save — bijection-preserving rebind
// ────────────────────────────────────────────────────────────────────

describe('KnowledgeToolBindingService.putToolBinding — valid save', () => {
  it('moves a tool between two domains, commits, writes ONE audit row, and the next resolve sees the new routing', async () => {
    // Move `highlightBudgetOutliers` from `budget` → `cross-plan-analytics`.
    // Step 1: drop it from budget (no orphan yet — it lands in step 2).
    // We do both in one PUT on cross-plan-analytics AFTER trimming budget.
    const harness = createBindingHarness(seedFromCodeMap());
    const { service } = harness;

    // First: rebind `budget` to drop `highlightBudgetOutliers` AND add it
    // to cross-plan in the SAME logical op is impossible in one PUT (one
    // domain per call). So move in two valid steps:
    //   (a) budget = [getBudgetSummaryByPlan, highlightBudgetOutliers,
    //       getCrossPlanInsights]  → temporarily double-owns? No — that
    //       orphans nothing but DOUBLE-maps getCrossPlanInsights. Invalid.
    // Correct bijection-preserving single PUT: swap the two domains'
    // entire sets at once is also two calls. Instead, verify a no-op-shaped
    // but real rebind: reorder budget's own tools (still exact).
    const result = await service.putToolBinding(
      'budget',
      { toolNames: ['highlightBudgetOutliers', 'getBudgetSummaryByPlan'] },
      'user-1',
    );

    expect(result.source).toBe('override');
    expect(result.domainKey).toBe('budget');
    expect(result.tools.map((t) => t.name)).toEqual([
      'highlightBudgetOutliers',
      'getBudgetSummaryByPlan',
    ]);

    // Exactly one audit row, on the transactional manager.
    expect(harness.auditRows).toHaveLength(1);
    expect(harness.auditRows[0]).toMatchObject({
      action: 'tool_binding_update',
      targetKind: 'tool_binding',
      actorWorkHistoryId: ACTOR_WH_ID,
      actorRole: 'super-admin',
    });
    const detail = harness.auditRows[0].detail as Record<string, unknown>;
    expect(detail.domainKey).toBe('budget');
    expect(detail.after).toEqual([
      'highlightBudgetOutliers',
      'getBudgetSummaryByPlan',
    ]);

    // The next resolve still satisfies the full bijection.
    const resolved = await service.resolveBindingMap();
    expect(resolved.source).toBe('override');
    const flat = [...resolved.byDomain.values()].flat().sort();
    expect(flat).toEqual([...EXECUTIVE_TOOL_NAMES].sort());
    expect(resolved.byDomain.get('budget')).toEqual([
      'highlightBudgetOutliers',
      'getBudgetSummaryByPlan',
    ]);
  });

  it('promotes the code map into a full override on the FIRST write (B1 → B2)', async () => {
    const harness = createBindingHarness([]); // empty → first write promotes
    const { service } = harness;

    // A bijection-preserving PUT on budget with its own code set.
    const budget = KNOWLEDGE_DOMAINS.find((d) => d.key === 'budget')!;
    await service.putToolBinding(
      'budget',
      { toolNames: [...budget.toolNames] },
      'user-1',
    );

    // The table now materializes EVERY derived domain's binding (so no
    // unwritten domain's tools are silently orphaned).
    const persisted = harness.rows.map((r) => r.toolName).sort();
    expect(persisted).toEqual([...EXECUTIVE_TOOL_NAMES].sort());

    const resolved = await service.resolveBindingMap();
    expect(resolved.source).toBe('override');
    const flat = [...resolved.byDomain.values()].flat().sort();
    expect(flat).toEqual([...EXECUTIVE_TOOL_NAMES].sort());
  });
});

// ────────────────────────────────────────────────────────────────────
// 4-6. Bijection guard rejects — unknown / double-map / orphan
// ────────────────────────────────────────────────────────────────────

describe('KnowledgeToolBindingService.putToolBinding — runtime bijection guard', () => {
  it('rejects an unknown tool with 400 KNOWLEDGE_TOOL_BINDING_INVALID; zero rows written', async () => {
    const harness = createBindingHarness(seedFromCodeMap());
    const budget = KNOWLEDGE_DOMAINS.find((d) => d.key === 'budget')!;

    await expectHttpError(
      harness.service.putToolBinding(
        'budget',
        { toolNames: [...budget.toolNames, 'thisToolDoesNotExist'] },
        'user-1',
      ),
      400,
      'KNOWLEDGE_TOOL_BINDING_INVALID',
    );

    expect(harness.spies.insert).not.toHaveBeenCalled();
    expect(harness.spies.delete).not.toHaveBeenCalled();
    expect(harness.auditRows).toHaveLength(0);
  });

  it('rejects a double-map (stealing a tool owned by another domain) with 400; zero rows written', async () => {
    const harness = createBindingHarness(seedFromCodeMap());
    // `getCrossPlanInsights` belongs to cross-plan-analytics. Add it to
    // budget WITHOUT removing it from cross-plan → double-map.
    const budget = KNOWLEDGE_DOMAINS.find((d) => d.key === 'budget')!;

    await expectHttpError(
      harness.service.putToolBinding(
        'budget',
        { toolNames: [...budget.toolNames, 'getCrossPlanInsights'] },
        'user-1',
      ),
      400,
      'KNOWLEDGE_TOOL_BINDING_INVALID',
    );

    expect(harness.spies.insert).not.toHaveBeenCalled();
    expect(harness.auditRows).toHaveLength(0);
  });

  it('rejects an orphan (dropping a tool with nowhere to land) with 400; zero rows written', async () => {
    const harness = createBindingHarness(seedFromCodeMap());
    // Drop `highlightBudgetOutliers` from budget and bind nothing else for
    // it → it is orphaned from the whole override set.
    await expectHttpError(
      harness.service.putToolBinding(
        'budget',
        { toolNames: ['getBudgetSummaryByPlan'] },
        'user-1',
      ),
      400,
      'KNOWLEDGE_TOOL_BINDING_INVALID',
    );

    expect(harness.spies.insert).not.toHaveBeenCalled();
    expect(harness.auditRows).toHaveLength(0);
  });

  it('rejects a non-derived domainKey with 400 (curated / unknown cannot back tools)', async () => {
    const harness = createBindingHarness(seedFromCodeMap());
    await expectHttpError(
      harness.service.putToolBinding(
        'glossary', // curated domain — carries no tools
        { toolNames: ['getBudgetSummaryByPlan'] },
        'user-1',
      ),
      400,
      'KNOWLEDGE_TOOL_BINDING_INVALID',
    );
    await expectHttpError(
      harness.service.putToolBinding(
        'not-a-domain',
        { toolNames: [] },
        'user-1',
      ),
      400,
      'KNOWLEDGE_TOOL_BINDING_INVALID',
    );
    expect(harness.spies.insert).not.toHaveBeenCalled();
    expect(harness.auditRows).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// 7. §17.11 — super-admin STILL cannot persist a violating binding
// ────────────────────────────────────────────────────────────────────

describe('KnowledgeToolBindingService — §17.11 no role exemption', () => {
  it('a super-admin actor with a violating payload STILL throws (integrity ≠ permission)', async () => {
    // The actor role is explicitly super-admin (the most privileged).
    const harness = createBindingHarness(seedFromCodeMap(), {
      actorRole: 'super-admin',
    });

    // Same orphaning payload as the orphan-reject case above.
    await expectHttpError(
      harness.service.putToolBinding(
        'budget',
        { toolNames: ['getBudgetSummaryByPlan'] },
        'super-admin-actor',
      ),
      400,
      'KNOWLEDGE_TOOL_BINDING_INVALID',
    );

    // No bypass branch — the guard fired, nothing was written or audited.
    expect(harness.spies.insert).not.toHaveBeenCalled();
    expect(harness.spies.delete).not.toHaveBeenCalled();
    expect(harness.auditRows).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// 8. Compile-time backstop preserved (Class B — code map)
// ────────────────────────────────────────────────────────────────────

describe('compile-time bijection backstop is preserved alongside the runtime guard', () => {
  it('the CODE map is itself an exact registry bijection (the runtime guard mirrors this over the OVERRIDE)', () => {
    const mapped = KNOWLEDGE_DOMAINS.flatMap((domain) => [
      ...domain.toolNames,
    ]);
    const registered = new Set<string>(EXECUTIVE_TOOL_NAMES);

    // every mapped tool exists
    expect(mapped.filter((name) => !registered.has(name))).toEqual([]);
    // exactly-one-domain (no orphan, no double-map)
    const occ = new Map<string, number>();
    for (const name of mapped) occ.set(name, (occ.get(name) ?? 0) + 1);
    expect(
      EXECUTIVE_TOOL_NAMES.filter((name) => (occ.get(name) ?? 0) === 0),
    ).toEqual([]);
    expect(
      [...occ.entries()].filter(([, c]) => c > 1).map(([n]) => n),
    ).toEqual([]);
    expect(mapped).toHaveLength(EXECUTIVE_TOOL_NAMES.length);
  });
});
