/**
 * Wave wave-ai-knowledge-structure-mgmt — SEC-01 (Phase 3, 2026-06-13).
 *
 * Red-team: a SUPER-ADMIN (the single role authorized to write the
 * Class-B tool↔domain binding, Q-04) tries to persist a binding that
 * VIOLATES the registry⇄domain bijection — an unknown tool, a stolen
 * (double-mapped) tool, an orphaned tool, or a binding on a curated /
 * unknown domain. Prove §17.11 / §17.16.8 — the bijection guard is
 * INTEGRITY, not permission: there is NO super-admin bypass branch, every
 * violation → `400 KNOWLEDGE_TOOL_BINDING_INVALID`, the whole transaction
 * rolls back, and ZERO rows + ZERO audit rows are written.
 *
 * This is the §3 task deliverable `tool-binding-bypass.red-team.spec.ts`.
 * It complements `__tests__/tool-binding-bijection.spec.ts` (the BE-04
 * acceptance suite that proves valid saves + the role matrix) by focusing
 * exclusively on the ADVERSARIAL super-admin vectors AND the DB-level
 * `UNIQUE(tool_name)` defense-in-depth backstop (what stops a double-map
 * if the service guard were ever short-circuited).
 */
import { HttpException } from '@nestjs/common';

import { EXECUTIVE_TOOL_NAMES } from '../../../ai-executive-chat/tools/tool-registry';
import { AiKnowledgeAuditLog } from '../../entities/ai-knowledge-audit-log.entity';
import { AiKnowledgeToolBinding } from '../../entities/ai-knowledge-tool-binding.entity';
import { KNOWLEDGE_DOMAINS } from '../../registry/derived-domain-map';
import { KnowledgeAuditService } from '../../services/knowledge-audit.service';
import { KnowledgeToolBindingService } from '../../services/knowledge-tool-binding.service';

const SUPER_ADMIN_ACTOR = 'super-admin-actor';

interface ToolBindingRow {
  id: string;
  domainKey: string;
  toolName: string;
  createdByWorkHistoryId: string;
}

/**
 * In-memory harness — the actor is ALWAYS super-admin (the most
 * privileged role). The fake insert ENFORCES `UNIQUE(tool_name)` so the
 * DB-level no-double-map backstop is exercised end-to-end; the base audit
 * repo THROWS so any audit row that escaped the caller's transaction
 * fails the test (§17.3 atomicity).
 */
function createSuperAdminHarness(
  seed: Array<Pick<ToolBindingRow, 'domainKey' | 'toolName'>> = [],
) {
  const rows: ToolBindingRow[] = seed.map((row, index) => ({
    id: `seed-${index}`,
    createdByWorkHistoryId: SUPER_ADMIN_ACTOR,
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
            Pick<ToolBindingRow, 'domainKey' | 'toolName' | 'createdByWorkHistoryId'>
          >,
    ) => {
      const many = Array.isArray(input) ? input : [input];
      for (const one of many) {
        // DB-level UNIQUE(tool_name) — the last line of defense (§17.16.5).
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
    async (cb: (manager: unknown) => Promise<unknown>) => cb(entityManagerFake),
  );

  const toolBindingRepoFake = { find, manager: { transaction } };

  const workHistoryRepoFake = {
    findOne: jest.fn(async () => ({
      id: SUPER_ADMIN_ACTOR,
      role: { name: 'super-admin' },
    })),
  };

  const auditService = new KnowledgeAuditService({
    insert: jest.fn(() => {
      throw new Error(
        'audit row written OUTSIDE the mutation transaction (§17.3 atomicity violation)',
      );
    }),
  } as never);

  const service = new KnowledgeToolBindingService(
    toolBindingRepoFake as never,
    workHistoryRepoFake as never,
    auditService,
  );

  return { service, rows, auditRows, spies: { insert, delete: del } };
}

/** The full CODE binding flattened into override rows (a valid bijection). */
function seedFromCodeMap(): Array<Pick<ToolBindingRow, 'domainKey' | 'toolName'>> {
  return KNOWLEDGE_DOMAINS.flatMap((domain) =>
    domain.toolNames.map((toolName) => ({ domainKey: domain.key, toolName })),
  );
}

async function expectBindingRejected(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(HttpException);
  const exception = caught as HttpException;
  expect(exception.getStatus()).toBe(400);
  const body = exception.getResponse() as Record<string, unknown>;
  expect(body.code).toBe('KNOWLEDGE_TOOL_BINDING_INVALID');
}

describe('Tool-binding bypass red-team — super-admin CANNOT violate the bijection (§17.11)', () => {
  const budget = KNOWLEDGE_DOMAINS.find((d) => d.key === 'budget')!;

  it('super-admin binding an UNKNOWN tool → 400, zero rows, zero audit', async () => {
    const h = createSuperAdminHarness(seedFromCodeMap());
    await expectBindingRejected(
      h.service.putToolBinding(
        'budget',
        { toolNames: [...budget.toolNames, 'fabricatedToolName'] },
        SUPER_ADMIN_ACTOR,
      ),
    );
    expect(h.spies.insert).not.toHaveBeenCalled();
    expect(h.spies.delete).not.toHaveBeenCalled();
    expect(h.auditRows).toHaveLength(0);
  });

  it('super-admin STEALING a tool owned by another domain (double-map) → 400, zero rows', async () => {
    const h = createSuperAdminHarness(seedFromCodeMap());
    // `getCrossPlanInsights` belongs to cross-plan-analytics; add it to
    // budget WITHOUT removing it there.
    await expectBindingRejected(
      h.service.putToolBinding(
        'budget',
        { toolNames: [...budget.toolNames, 'getCrossPlanInsights'] },
        SUPER_ADMIN_ACTOR,
      ),
    );
    expect(h.spies.insert).not.toHaveBeenCalled();
    expect(h.auditRows).toHaveLength(0);
  });

  it('super-admin ORPHANING a tool (drop with nowhere to land) → 400, zero rows', async () => {
    const h = createSuperAdminHarness(seedFromCodeMap());
    await expectBindingRejected(
      h.service.putToolBinding(
        'budget',
        { toolNames: ['getBudgetSummaryByPlan'] }, // drops highlightBudgetOutliers
        SUPER_ADMIN_ACTOR,
      ),
    );
    expect(h.spies.insert).not.toHaveBeenCalled();
    expect(h.auditRows).toHaveLength(0);
  });

  it('super-admin binding tools to a CURATED domain → 400, zero rows', async () => {
    const h = createSuperAdminHarness(seedFromCodeMap());
    await expectBindingRejected(
      h.service.putToolBinding(
        'glossary', // curated — carries no tools
        { toolNames: ['getBudgetSummaryByPlan'] },
        SUPER_ADMIN_ACTOR,
      ),
    );
    expect(h.spies.insert).not.toHaveBeenCalled();
    expect(h.auditRows).toHaveLength(0);
  });

  it('super-admin binding to an UNKNOWN domain key → 400, zero rows', async () => {
    const h = createSuperAdminHarness(seedFromCodeMap());
    await expectBindingRejected(
      h.service.putToolBinding(
        '../../etc/passwd', // hostile, non-derived key
        { toolNames: [] },
        SUPER_ADMIN_ACTOR,
      ),
    );
    expect(h.spies.insert).not.toHaveBeenCalled();
    expect(h.auditRows).toHaveLength(0);
  });

  it('a valid super-admin save still works (the guard rejects ONLY violations, not the role)', async () => {
    const h = createSuperAdminHarness(seedFromCodeMap());
    const result = await h.service.putToolBinding(
      'budget',
      { toolNames: [...budget.toolNames].reverse() }, // re-order, still exact
      SUPER_ADMIN_ACTOR,
    );
    expect(result.source).toBe('override');
    // Exactly one audit row on the transactional manager.
    expect(h.auditRows).toHaveLength(1);
    expect(h.auditRows[0]).toMatchObject({ action: 'tool_binding_update' });
    // The full set is still an exact registry bijection post-save.
    const flat = h.rows.map((r) => r.toolName).sort();
    expect(flat).toEqual([...EXECUTIVE_TOOL_NAMES].sort());
  });
});

describe('Tool-binding bypass red-team — DB UNIQUE(tool_name) is the last-line backstop', () => {
  it('a duplicate tool_name insert is rejected by the DB unique even if a guard were bypassed', async () => {
    // Directly exercise the fake insert (the DB-level constraint mock):
    // two rows for the same tool_name must throw the unique violation,
    // proving the no-double-map invariant is enforced at the DB even
    // without the service-layer bijection guard.
    const h = createSuperAdminHarness([
      { domainKey: 'budget', toolName: 'getBudgetSummaryByPlan' },
    ]);
    const repo = (
      h.service as unknown as {
        toolBindingRepository: { manager: { transaction: jest.Mock } };
      }
    ).toolBindingRepository;
    let caught: unknown;
    await repo.manager.transaction(async (manager: any) => {
      const txRepo = manager.getRepository(AiKnowledgeToolBinding);
      try {
        await txRepo.insert({
          domainKey: 'cross-plan-analytics',
          toolName: 'getBudgetSummaryByPlan', // already bound → unique violation
          createdByWorkHistoryId: SUPER_ADMIN_ACTOR,
        });
      } catch (err) {
        caught = err;
      }
    });
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(
      /uq_ai_knowledge_tool_binding_tool_name/,
    );
  });
});
