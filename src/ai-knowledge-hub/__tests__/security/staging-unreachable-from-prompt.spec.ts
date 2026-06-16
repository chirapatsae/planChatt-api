/**
 * Wave wave-ai-knowledge-hub — SEC-01 (2026-06-13).
 *
 * Red-team: prove that NON-published knowledge (draft / archived /
 * soft-deleted) and ALL external staging payloads
 * (`ai_knowledge_ingestions`) are UNREACHABLE from the executive-chat
 * prompt path.
 *
 * Two independent guarantees (CLAUDE.md §17.15.4 / §17.15.5; report
 * §6.3 "what NEVER enters prompts"):
 *
 *   (A) Exposure invariant — the SOLE consumption tool
 *       (`searchKnowledgeBase` → `KnowledgeSearchService.search`) bakes
 *       `status = 'published' AND deletedAt IS NULL` into the query
 *       itself. An honest mini-evaluator (it applies ONLY the predicates
 *       the service attached) proves draft / archived / soft-deleted
 *       rows can NEVER be selected — and that dropping either predicate
 *       would make them leak (so the test fails loudly on regression).
 *
 *   (B) Staging unreachability by construction — `KnowledgeSearchService`
 *       takes exactly ONE repository (`ai_knowledge_entries`). It has no
 *       handle on `ai_knowledge_ingestions` (the quarantine staging
 *       table), so no quarantined / rejected / purged external payload
 *       can ever be projected into a tool result, regardless of query.
 *       The handler degrades to an empty, schema-valid envelope when the
 *       service is absent — it never reaches around the service.
 */
import { EXECUTIVE_TOOL_HANDLERS } from 'src/ai-executive-chat/tools/handlers/executive-tool-handlers';

import { KnowledgeSearchService } from '../../services/knowledge-search.service';

interface SeedEntry {
  id: string;
  title: string;
  bodyMd: string;
  tags: string[];
  domainKey: string;
  origin: 'curated' | 'external';
  status: 'draft' | 'published' | 'archived';
  deletedAt: Date | null;
  currentVersion: number;
  updatedAt: Date;
  sourceName: string | null;
}

interface CapturedQuery {
  conditions: string[];
  params: Record<string, unknown>;
  limit?: number;
}

/**
 * Repository stub whose query builder is an HONEST mini-evaluator: it
 * applies ONLY the predicates the service actually attached. If a future
 * refactor drops the published or non-deleted clause, the leaked rows
 * surface here and the spec fails. Every mutating method throws — the
 * search path is ZERO-WRITE (§18.13).
 */
function createSearchRepoStub(seed: SeedEntry[]) {
  const captured: CapturedQuery = { conditions: [], params: {} };
  const qb: Record<string, jest.Mock> = {};
  for (const chainable of [
    'leftJoin',
    'select',
    'addSelect',
    'orderBy',
    'addOrderBy',
  ]) {
    qb[chainable] = jest.fn(() => qb);
  }
  const recordCondition = (clause: string, params?: Record<string, unknown>) => {
    captured.conditions.push(clause);
    Object.assign(captured.params, params ?? {});
    return qb;
  };
  qb.where = jest.fn(recordCondition);
  qb.andWhere = jest.fn(recordCondition);
  qb.setParameter = jest.fn((key: string, value: unknown) => {
    captured.params[key] = value;
    return qb;
  });
  qb.limit = jest.fn((n: number) => {
    captured.limit = n;
    return qb;
  });
  qb.getRawMany = jest.fn(async () => {
    let rows = [...seed];
    if (
      captured.conditions.some((c) => c.includes('entry.status = :published'))
    ) {
      rows = rows.filter((r) => r.status === captured.params.published);
    }
    if (captured.conditions.some((c) => c.includes('entry.deletedAt IS NULL'))) {
      rows = rows.filter((r) => r.deletedAt === null);
    }
    const pattern = String(captured.params.pattern ?? '%%');
    const needle = pattern
      .slice(1, -1)
      .replace(/\\([\\%_])/g, '$1')
      .toLowerCase();
    if (captured.conditions.some((c) => c.includes('ILIKE :pattern'))) {
      rows = rows.filter(
        (r) =>
          r.title.toLowerCase().includes(needle) ||
          r.bodyMd.toLowerCase().includes(needle) ||
          r.tags.some((t) => t.toLowerCase().includes(needle)),
      );
    }
    const limited =
      typeof captured.limit === 'number'
        ? rows.slice(0, captured.limit)
        : rows;
    return limited.map((r) => ({
      entryId: r.id,
      title: r.title,
      bodyMd: r.bodyMd,
      domainKey: r.domainKey,
      origin: r.origin,
      version: r.currentVersion,
      updatedAt: r.updatedAt,
      sourceName: r.sourceName,
    }));
  });

  const repo: Record<string, jest.Mock> = {
    createQueryBuilder: jest.fn(() => qb),
  };
  for (const method of [
    'save',
    'insert',
    'update',
    'delete',
    'softDelete',
    'remove',
    'query',
  ]) {
    repo[method] = jest.fn(() => {
      throw new Error(
        `ZERO-WRITE VIOLATION: repository.${method}() from the prompt path`,
      );
    });
  }
  return { repo, captured };
}

/**
 * Seed one row per non-published lifecycle state, all carrying the SAME
 * keyword the attacker would search for. If ANY of them appears in the
 * tool envelope, the exposure invariant is broken.
 */
function seedNonPublished(): SeedEntry[] {
  const base = {
    tags: ['ความลับ'],
    domainKey: 'policy-notes',
    origin: 'curated' as const,
    currentVersion: 1,
    updatedAt: new Date('2026-06-13T00:00:00Z'),
    sourceName: null,
  };
  return [
    {
      ...base,
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      title: 'ความลับ (draft — ห้ามเข้า prompt)',
      bodyMd: 'ความลับฉบับร่าง',
      status: 'draft',
      deletedAt: null,
    },
    {
      ...base,
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      title: 'ความลับ (archived — ห้ามเข้า prompt)',
      bodyMd: 'ความลับฉบับเก็บถาวร',
      status: 'archived',
      deletedAt: null,
    },
    {
      ...base,
      id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      title: 'ความลับ (soft-deleted published — ห้ามเข้า prompt)',
      bodyMd: 'ความลับที่ถูกลบ',
      status: 'published',
      deletedAt: new Date('2026-06-12T00:00:00Z'),
    },
  ];
}

const APPROVED_CTX = {
  userId: 'user-1',
  workHistoryId: 'wh-1',
  roleName: 'admin',
  workStatusName: 'approved',
};

describe('SEC-01 / (A) draft + archived + soft-deleted unreachable via the prompt tool (§17.15.4)', () => {
  it('returns ZERO items when the only matching rows are non-published — through the REAL handler', async () => {
    const { repo } = createSearchRepoStub(seedNonPublished());
    const service = new KnowledgeSearchService(repo as never);

    const handler = EXECUTIVE_TOOL_HANDLERS.searchKnowledgeBase;
    const result = await handler({ query: 'ความลับ' }, APPROVED_CTX, {
      knowledgeSearch: service,
    } as never);

    expect(result.items).toEqual([]);
  });

  it('the published + non-deleted predicates are baked into the SQL (not post-filtered in JS)', async () => {
    const { repo, captured } = createSearchRepoStub(seedNonPublished());
    const service = new KnowledgeSearchService(repo as never);
    await service.search({ query: 'ความลับ' });

    expect(
      captured.conditions.some((c) => c.includes('entry.status = :published')),
    ).toBe(true);
    expect(captured.params.published).toBe('published');
    expect(
      captured.conditions.some((c) => c.includes('entry.deletedAt IS NULL')),
    ).toBe(true);
  });
});

describe('SEC-01 / (B) staging (ai_knowledge_ingestions) unreachable by construction (§17.15.5)', () => {
  it('the retrieval service has exactly ONE repository dependency — no staging handle', () => {
    // Constructor arity = 1 (the entries repository). There is no second
    // repo through which a quarantined / rejected / purged external
    // payload could leak into a prompt.
    expect(KnowledgeSearchService.length).toBe(1);
  });

  it('handler degrades to an empty, schema-valid envelope when the service is absent (no reach-around)', async () => {
    const handler = EXECUTIVE_TOOL_HANDLERS.searchKnowledgeBase;
    const result = await handler(
      { query: 'ความลับ' },
      APPROVED_CTX,
      { knowledgeSearch: undefined } as never,
    );
    expect(result.items).toEqual([]);
    expect(typeof result.asOf).toBe('string');
  });

  it('the handler re-asserts §17.11 — a non-exec / unapproved caller is rejected even with a live service', async () => {
    const { repo } = createSearchRepoStub([]);
    const service = new KnowledgeSearchService(repo as never);
    const handler = EXECUTIVE_TOOL_HANDLERS.searchKnowledgeBase;

    // `user` role is NOT in the exec whitelist → EXECUTIVE_ROLE_REQUIRED.
    await expect(
      handler(
        { query: 'ความลับ' },
        { ...APPROVED_CTX, roleName: 'user' },
        { knowledgeSearch: service } as never,
      ),
    ).rejects.toThrow('EXECUTIVE_ROLE_REQUIRED');

    // Approved exec role but suspended workStatus → still rejected.
    await expect(
      handler(
        { query: 'ความลับ' },
        { ...APPROVED_CTX, workStatusName: 'suspended' },
        { knowledgeSearch: service } as never,
      ),
    ).rejects.toThrow('EXECUTIVE_ROLE_REQUIRED');
  });
});
