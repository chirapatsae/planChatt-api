/**
 * Wave wave-ai-knowledge-hub — BE-04 (2026-06-12).
 *
 * `KnowledgeSearchService` — retrieval backend of the
 * `searchKnowledgeBase` executive tool.
 *
 * Acceptance coverage (task §7):
 *   1. PUBLISHED-ONLY (§17.15.4): the spec seeds entries in ALL
 *      lifecycle states (draft / published / archived / soft-deleted
 *      published) and asserts only live published rows can ever be
 *      returned. The fake query builder is an honest mini-evaluator —
 *      it applies ONLY the predicates the service actually attached, so
 *      dropping the `status = 'published'` or `deletedAt IS NULL`
 *      clause from the query makes draft/archived/deleted rows leak and
 *      the spec fail loudly. (Quarantined ingestions live in
 *      `ai_knowledge_ingestions`, a table this service never queries —
 *      asserted via the single-repository constructor surface.)
 *   2. Token cap: top-k clamped to ≤ 5 (default 3) and excerpt
 *      hard-capped at 800 chars.
 *   3. Envelope ⇄ registry contract: the service result validates
 *      against the registry `returnSchema` byte-for-byte (provenance
 *      keys incl. nullable `sourceName` always present).
 *   4. Zero-write (§18.13 discipline / §17.2): no mutating repository
 *      method is reachable from the search path.
 */
import { validateAgainstSchema } from '../../ai-executive-chat/tools/tool-schema-validator';
import { EXECUTIVE_TOOL_REGISTRY } from '../../ai-executive-chat/tools/tool-registry';
import {
  KNOWLEDGE_SEARCH_DEFAULT_LIMIT,
  KNOWLEDGE_SEARCH_EXCERPT_MAX_CHARS,
  KNOWLEDGE_SEARCH_MAX_RESULTS,
  KNOWLEDGE_SEARCH_QUERY_MAX_CHARS,
  KnowledgeSearchService,
} from '../services/knowledge-search.service';

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

interface CapturedQuery {
  conditions: string[];
  params: Record<string, unknown>;
  limit?: number;
  builderCalls: number;
}

/**
 * Repository stub whose query builder is an honest mini-evaluator: it
 * applies ONLY the predicates the service attached (status /
 * soft-delete / ILIKE needle / LIMIT) against the seeded rows. The
 * trgm `similarity()` recall arm is approximated by the ILIKE needle —
 * sufficient for the published-only leak detection this spec exists for.
 */
function createSearchRepoStub(seed: SeedEntry[]) {
  const captured: CapturedQuery = {
    conditions: [],
    params: {},
    builderCalls: 0,
  };
  const mutationSpies: jest.Mock[] = [];

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
    // Apply ONLY the predicates the service actually attached.
    if (captured.conditions.some((c) => c.includes('entry.status = :published'))) {
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

  const createQueryBuilder = jest.fn(() => {
    captured.builderCalls += 1;
    return qb;
  });
  const repo: Record<string, jest.Mock> = { createQueryBuilder };
  for (const method of MUTATION_METHODS) {
    const spy = jest.fn(() => {
      throw new Error(
        `ZERO-WRITE VIOLATION: repository.${method}() called from the knowledge search path (§17.15.4 / §18.13)`,
      );
    });
    repo[method] = spy;
    mutationSpies.push(spy);
  }
  return { repo, captured, mutationSpies, createQueryBuilder };
}

function seedAllStates(): SeedEntry[] {
  const base = {
    tags: ['นโยบาย'],
    domainKey: 'policy-notes',
    origin: 'curated' as const,
    currentVersion: 2,
    updatedAt: new Date('2026-06-12T03:00:00Z'),
    sourceName: null,
  };
  return [
    {
      ...base,
      id: '11111111-1111-1111-1111-111111111111',
      title: 'นโยบายการประสานแผน (published)',
      bodyMd: 'เนื้อหานโยบายการประสานแผนฉบับเผยแพร่',
      status: 'published',
      deletedAt: null,
    },
    {
      ...base,
      id: '22222222-2222-2222-2222-222222222222',
      title: 'นโยบายการประสานแผน (draft)',
      bodyMd: 'ฉบับร่าง ห้ามเข้า prompt',
      status: 'draft',
      deletedAt: null,
    },
    {
      ...base,
      id: '33333333-3333-3333-3333-333333333333',
      title: 'นโยบายการประสานแผน (archived)',
      bodyMd: 'ฉบับเก็บถาวร ห้ามเข้า prompt',
      status: 'archived',
      deletedAt: null,
    },
    {
      ...base,
      id: '44444444-4444-4444-4444-444444444444',
      title: 'นโยบายการประสานแผน (soft-deleted published)',
      bodyMd: 'ฉบับถูกลบ ห้ามเข้า prompt',
      status: 'published',
      deletedAt: new Date('2026-06-11T00:00:00Z'),
    },
    {
      ...base,
      id: '55555555-5555-5555-5555-555555555555',
      title: 'นโยบายจากแหล่งภายนอก (published external)',
      bodyMd: 'เนื้อหานโยบายที่ promote มาจาก ingestion',
      origin: 'external',
      sourceName: 'กรมส่งเสริมการปกครองท้องถิ่น',
      status: 'published',
      deletedAt: null,
    },
  ];
}

function buildService(seed: SeedEntry[]) {
  const stub = createSearchRepoStub(seed);
  const service = new KnowledgeSearchService(stub.repo as never);
  return { service, ...stub };
}

describe('KnowledgeSearchService — published-only exposure invariant (§17.15.4)', () => {
  it('seeds ALL lifecycle states and returns ONLY live published rows', async () => {
    const { service, mutationSpies } = buildService(seedAllStates());
    const result = await service.search({ query: 'นโยบาย', limit: 5 });

    const ids = result.items.map((i) => i.entryId).sort();
    expect(ids).toEqual([
      '11111111-1111-1111-1111-111111111111',
      '55555555-5555-5555-5555-555555555555',
    ]);
    // draft / archived / soft-deleted NEVER appear.
    expect(ids).not.toContain('22222222-2222-2222-2222-222222222222');
    expect(ids).not.toContain('33333333-3333-3333-3333-333333333333');
    expect(ids).not.toContain('44444444-4444-4444-4444-444444444444');

    for (const spy of mutationSpies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('bakes the published + non-deleted predicates into the query itself (not post-filtered)', async () => {
    const { service, captured } = buildService(seedAllStates());
    await service.search({ query: 'นโยบาย' });

    expect(
      captured.conditions.some((c) => c.includes('entry.status = :published')),
    ).toBe(true);
    expect(captured.params.published).toBe('published');
    expect(
      captured.conditions.some((c) => c.includes('entry.deletedAt IS NULL')),
    ).toBe(true);
  });

  it('queries a single repository (ai_knowledge_entries) — staging/quarantine tables are out of reach by construction', () => {
    // Constructor surface = exactly one repository. There is no second
    // repo through which `ai_knowledge_ingestions` rows could leak.
    expect(KnowledgeSearchService.length).toBe(1);
  });
});

describe('KnowledgeSearchService — token caps (top-k ≤ 5, excerpt ≤ 800)', () => {
  it('clamps limit to the hard max of 5 and defaults to 3', async () => {
    const { service, captured } = buildService(seedAllStates());
    await service.search({ query: 'นโยบาย', limit: 50 });
    expect(captured.limit).toBe(KNOWLEDGE_SEARCH_MAX_RESULTS);
    expect(KNOWLEDGE_SEARCH_MAX_RESULTS).toBe(5);

    const second = buildService(seedAllStates());
    await second.service.search({ query: 'นโยบาย' });
    expect(second.captured.limit).toBe(KNOWLEDGE_SEARCH_DEFAULT_LIMIT);
    expect(KNOWLEDGE_SEARCH_DEFAULT_LIMIT).toBe(3);
  });

  it('hard-caps the excerpt at 800 chars INCLUDING ellipsis, re-centered on the hit', async () => {
    const longBody =
      'x'.repeat(3000) + ' คำค้นเป้าหมายฝังลึก ' + 'y'.repeat(3000);
    const seed = seedAllStates().map((row, idx) =>
      idx === 0 ? { ...row, bodyMd: longBody } : row,
    );
    const { service } = buildService(seed);
    const result = await service.search({ query: 'คำค้นเป้าหมายฝังลึก' });

    const hit = result.items.find(
      (i) => i.entryId === '11111111-1111-1111-1111-111111111111',
    );
    expect(hit).toBeDefined();
    expect(hit!.excerpt.length).toBeLessThanOrEqual(
      KNOWLEDGE_SEARCH_EXCERPT_MAX_CHARS,
    );
    expect(KNOWLEDGE_SEARCH_EXCERPT_MAX_CHARS).toBe(800);
    // Window re-centered — the deep hit is visible inside the excerpt.
    expect(hit!.excerpt).toContain('คำค้นเป้าหมายฝังลึก');
  });

  it('truncates the query needle at 200 chars instead of rejecting', async () => {
    const { service, captured } = buildService(seedAllStates());
    await service.search({ query: 'น'.repeat(500) });
    expect(String(captured.params.query)).toHaveLength(
      KNOWLEDGE_SEARCH_QUERY_MAX_CHARS,
    );
  });

  it('empty / whitespace query short-circuits to zero items WITHOUT touching the database', async () => {
    const { service, createQueryBuilder } = buildService(seedAllStates());
    const result = await service.search({ query: '   ' });
    expect(result.items).toEqual([]);
    expect(typeof result.asOf).toBe('string');
    expect(createQueryBuilder).not.toHaveBeenCalled();
  });
});

describe('KnowledgeSearchService — ranking boosts + provenance projection', () => {
  it('passes a known domainKey as the rank-boost parameter (soft boost, not a hard filter)', async () => {
    const { service, captured } = buildService(seedAllStates());
    await service.search({ query: 'นโยบาย', domainKey: 'policy-notes' });
    expect(captured.params.boostDomainKey).toBe('policy-notes');
    // Boost-only: no WHERE arm filters on domain_key.
    expect(
      captured.conditions.some((c) => c.includes('domainKey')),
    ).toBe(false);
  });

  it('ignores an unknown domainKey (belt-and-braces under the schema enum gate)', async () => {
    const { service, captured } = buildService(seedAllStates());
    await service.search({ query: 'นโยบาย', domainKey: 'not-a-domain' });
    expect(captured.params.boostDomainKey).toBe('');
  });

  it('escapes LIKE metacharacters so user input is always a literal needle', async () => {
    const { service, captured } = buildService(seedAllStates());
    await service.search({ query: 'งบ 100% _แผน' });
    expect(captured.params.pattern).toBe('%งบ 100\\% \\_แผน%');
  });

  it('projects provenance verbatim — curated rows carry sourceName null; external rows carry the source name', async () => {
    const { service } = buildService(seedAllStates());
    const result = await service.search({ query: 'นโยบาย', limit: 5 });

    const curated = result.items.find((i) => i.origin === 'curated');
    const external = result.items.find((i) => i.origin === 'external');
    expect(curated?.sourceName).toBeNull();
    expect(external?.sourceName).toBe('กรมส่งเสริมการปกครองท้องถิ่น');
    expect(curated?.updatedAt).toBe('2026-06-12T03:00:00.000Z');
    expect(curated?.version).toBe(2);
  });

  it('result envelope validates against the registry returnSchema (item shape contract)', async () => {
    const { service } = buildService(seedAllStates());
    const result = await service.search({ query: 'นโยบาย', limit: 5 });

    const spec = EXECUTIVE_TOOL_REGISTRY.searchKnowledgeBase;
    const check = validateAgainstSchema(
      spec.returnSchema,
      result as unknown as Record<string, unknown>,
    );
    expect(check).toEqual({ ok: true });
    // Every item carries ALL eight provenance/content keys.
    for (const item of result.items) {
      expect(Object.keys(item).sort()).toEqual(
        [
          'domainKey',
          'entryId',
          'excerpt',
          'origin',
          'sourceName',
          'title',
          'updatedAt',
          'version',
        ].sort(),
      );
    }
  });
});
