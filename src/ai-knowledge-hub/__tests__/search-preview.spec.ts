/**
 * Wave wave-ai-knowledge-hub — retrieval-test surface (BE).
 *
 * `AiKnowledgeHubService.searchPreview` — deterministic, zero-cost
 * admin "ทดสอบการค้นเจอ". It calls the SAME `KnowledgeSearchService.search`
 * ranking the AI tool uses, so a pass here guarantees the entry is in the
 * candidate set the LLM sees.
 *
 * Acceptance coverage (task SPEC):
 *   1. a PUBLISHED entry matching the query appears in `items` and
 *      `targetRank` is its 1-based rank.
 *   2. a DRAFT / ARCHIVED entry with the same text is NEVER in `items`
 *      and `targetRank` is null — published-only still holds on the
 *      preview path (the security-critical assertion).
 *   3. the AI tool path `search(params)` still caps at 5 even when >5
 *      rows match — the diagnostic override does NOT leak to the tool
 *      path.
 *   4. `aiVisibleLimit` reflects the requested / default top-k, NOT the
 *      diagnostic window of 20.
 *
 * The repository stub is the SAME honest mini-evaluator used by
 * `knowledge-search.spec.ts`: it applies ONLY the predicates the service
 * actually attached (status / soft-delete / ILIKE needle / LIMIT). So if
 * a future refactor drops the `status = 'published'` or `deletedAt IS
 * NULL` clause, case 2 fails loudly.
 */
import { AiKnowledgeHubService } from '../ai-knowledge-hub.service';
import {
  KNOWLEDGE_SEARCH_MAX_RESULTS,
  KNOWLEDGE_SEARCH_PREVIEW_MAX_RESULTS,
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

interface CapturedQuery {
  conditions: string[];
  params: Record<string, unknown>;
  limit?: number;
}

/** Honest mini-evaluator repo stub (mirrors knowledge-search.spec.ts). */
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
  const recordCondition = (
    clause: string,
    params?: Record<string, unknown>,
  ) => {
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
    if (
      captured.conditions.some((c) => c.includes('entry.deletedAt IS NULL'))
    ) {
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
  return { repo, captured };
}

const baseEntry = {
  tags: ['นโยบาย'],
  domainKey: 'policy-notes',
  origin: 'curated' as const,
  currentVersion: 1,
  sourceName: null,
};

/** N published rows that all match the same needle. */
function publishedRows(count: number): SeedEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    ...baseEntry,
    id: `pub-${String(i).padStart(2, '0')}`,
    title: `นโยบายการประสานแผน #${i}`,
    bodyMd: `เนื้อหานโยบายการประสานแผนฉบับที่ ${i}`,
    status: 'published' as const,
    deletedAt: null,
    // Newer rows sort first under the addOrderBy(updatedAt DESC) tiebreak
    // — but the mini-evaluator preserves seed order, which we use as the
    // deterministic rank order in these specs.
    updatedAt: new Date(`2026-06-12T00:00:0${i % 10}Z`),
  }));
}

/** Build the orchestration service with a NON-search dep set stubbed inert. */
function buildHubService(seed: SeedEntry[]) {
  const { repo } = createSearchRepoStub(seed);
  const searchService = new KnowledgeSearchService(repo as never);
  const inert = null as never;
  const service = new AiKnowledgeHubService(
    inert, // entryRepository — unused by searchPreview
    inert, // revisionRepository
    inert, // workHistoryRepository
    inert, // knowledgeAuditService
    searchService,
    null, // sourceRepository (@Optional)
  );
  return { service, searchService };
}

describe('AiKnowledgeHubService.searchPreview — retrieval test', () => {
  it('(1) a published entry matching the query appears in items and targetRank is its 1-based rank', async () => {
    const seed = publishedRows(4);
    const { service } = buildHubService(seed);

    const target = seed[2];
    const result = await service.searchPreview({
      query: 'นโยบายการประสานแผน',
      limit: 5,
      expectEntryId: target.id,
    });

    expect(result.items.map((i) => i.entryId)).toContain(target.id);
    // Seed order is the deterministic rank order in the mini-evaluator —
    // the third seeded row is rank 3.
    expect(result.targetRank).toBe(3);
    expect(typeof result.asOf).toBe('string');
  });

  it('(1b) targetRank can exceed aiVisibleLimit when the entry is retrievable but below the LLM top-k cutoff', async () => {
    // 8 matching published rows; ask for top-3 → the 6th-ranked entry is
    // retrievable (rank 6 in the <=20 candidate set) but NOT in the
    // 3-item LLM-visible slice.
    const seed = publishedRows(8);
    const { service } = buildHubService(seed);

    const deepTarget = seed[5];
    const result = await service.searchPreview({
      query: 'นโยบายการประสานแผน',
      limit: 3,
      expectEntryId: deepTarget.id,
    });

    expect(result.aiVisibleLimit).toBe(3);
    expect(result.items).toHaveLength(3);
    expect(result.items.map((i) => i.entryId)).not.toContain(deepTarget.id);
    // Still ranked (rank 6) across the full candidate set — admin learns
    // it IS found but would not reach the LLM at top-3.
    expect(result.targetRank).toBe(6);
  });

  it('(2) a DRAFT or ARCHIVED entry with matching text is NEVER in items and targetRank is null', async () => {
    const draftId = 'draft-secret';
    const archivedId = 'archived-secret';
    const seed: SeedEntry[] = [
      ...publishedRows(1),
      {
        ...baseEntry,
        id: draftId,
        title: 'นโยบายการประสานแผน (draft)',
        bodyMd: 'ฉบับร่าง ห้ามเข้า prompt',
        status: 'draft',
        deletedAt: null,
        updatedAt: new Date('2026-06-12T05:00:00Z'),
      },
      {
        ...baseEntry,
        id: archivedId,
        title: 'นโยบายการประสานแผน (archived)',
        bodyMd: 'ฉบับเก็บถาวร ห้ามเข้า prompt',
        status: 'archived',
        deletedAt: null,
        updatedAt: new Date('2026-06-12T06:00:00Z'),
      },
    ];

    const { service } = buildHubService(seed);

    const draftResult = await service.searchPreview({
      query: 'นโยบายการประสานแผน',
      limit: 5,
      expectEntryId: draftId,
    });
    expect(draftResult.items.map((i) => i.entryId)).not.toContain(draftId);
    expect(draftResult.targetRank).toBeNull();

    const archivedResult = await service.searchPreview({
      query: 'นโยบายการประสานแผน',
      limit: 5,
      expectEntryId: archivedId,
    });
    expect(archivedResult.items.map((i) => i.entryId)).not.toContain(
      archivedId,
    );
    expect(archivedResult.targetRank).toBeNull();
  });

  it('(2b) soft-deleted published entry is invisible to the preview path too', async () => {
    const deletedId = 'deleted-pub';
    const seed: SeedEntry[] = [
      ...publishedRows(1),
      {
        ...baseEntry,
        id: deletedId,
        title: 'นโยบายการประสานแผน (soft-deleted)',
        bodyMd: 'ฉบับถูกลบ ห้ามเข้า prompt',
        status: 'published',
        deletedAt: new Date('2026-06-11T00:00:00Z'),
        updatedAt: new Date('2026-06-12T07:00:00Z'),
      },
    ];
    const { service } = buildHubService(seed);

    const result = await service.searchPreview({
      query: 'นโยบายการประสานแผน',
      limit: 5,
      expectEntryId: deletedId,
    });
    expect(result.items.map((i) => i.entryId)).not.toContain(deletedId);
    expect(result.targetRank).toBeNull();
  });

  it('(4) aiVisibleLimit reflects the requested / default top-k, NOT the diagnostic 20', async () => {
    const seed = publishedRows(20);

    const requested = buildHubService(seed);
    const withLimit = await requested.service.searchPreview({
      query: 'นโยบายการประสานแผน',
      limit: 5,
    });
    expect(withLimit.aiVisibleLimit).toBe(5);
    expect(withLimit.items).toHaveLength(5);
    expect(withLimit.aiVisibleLimit).not.toBe(
      KNOWLEDGE_SEARCH_PREVIEW_MAX_RESULTS,
    );

    const defaulted = buildHubService(seed);
    const noLimit = await defaulted.service.searchPreview({
      query: 'นโยบายการประสานแผน',
    });
    // Default top-k = 3.
    expect(noLimit.aiVisibleLimit).toBe(3);
    expect(noLimit.items).toHaveLength(3);
  });

  it('the diagnostic window surfaces more than 5 candidates so a deep targetRank is computable', async () => {
    const seed = publishedRows(20);
    const { service } = buildHubService(seed);

    const deep = seed[12];
    const result = await service.searchPreview({
      query: 'นโยบายการประสานแผน',
      limit: 3,
      expectEntryId: deep.id,
    });
    // rank 13 — only computable because the preview widens the window to
    // KNOWLEDGE_SEARCH_PREVIEW_MAX_RESULTS (20), well past the tool's 5.
    expect(result.targetRank).toBe(13);
    expect(KNOWLEDGE_SEARCH_PREVIEW_MAX_RESULTS).toBeGreaterThanOrEqual(13);
  });
});

describe('KnowledgeSearchService.search — tool path stays capped at 5 (override does not leak)', () => {
  it('(3) caps at KNOWLEDGE_SEARCH_MAX_RESULTS even when >5 rows match and limit is large', async () => {
    const seed = publishedRows(12);
    const { repo, captured } = createSearchRepoStub(seed);
    const searchService = new KnowledgeSearchService(repo as never);

    const result = await searchService.search({
      query: 'นโยบายการประสานแผน',
      limit: 50,
    });

    expect(captured.limit).toBe(KNOWLEDGE_SEARCH_MAX_RESULTS);
    expect(KNOWLEDGE_SEARCH_MAX_RESULTS).toBe(5);
    expect(result.items).toHaveLength(5);
  });

  it('(3b) the override is honored ONLY when explicitly passed — the tool call signature never sets it', async () => {
    const seed = publishedRows(12);

    // No opts → tool ceiling.
    const toolStub = createSearchRepoStub(seed);
    const toolSearch = new KnowledgeSearchService(toolStub.repo as never);
    await toolSearch.search({ query: 'นโยบายการประสานแผน', limit: 50 });
    expect(toolStub.captured.limit).toBe(KNOWLEDGE_SEARCH_MAX_RESULTS);

    // Explicit override → widened ceiling (preview path).
    const previewStub = createSearchRepoStub(seed);
    const previewSearch = new KnowledgeSearchService(
      previewStub.repo as never,
    );
    await previewSearch.search(
      { query: 'นโยบายการประสานแผน' },
      { maxResultsOverride: KNOWLEDGE_SEARCH_PREVIEW_MAX_RESULTS },
    );
    // default 3 still applies as the requested limit; the override only
    // raises the CEILING, not the requested top-k — so a 12-row corpus
    // with no explicit limit returns the default 3.
    expect(previewStub.captured.limit).toBe(3);

    // With an explicit large limit + override, the widened ceiling holds.
    const wideStub = createSearchRepoStub(seed);
    const wideSearch = new KnowledgeSearchService(wideStub.repo as never);
    await wideSearch.search(
      { query: 'นโยบายการประสานแผน', limit: 50 },
      { maxResultsOverride: KNOWLEDGE_SEARCH_PREVIEW_MAX_RESULTS },
    );
    expect(wideStub.captured.limit).toBe(KNOWLEDGE_SEARCH_PREVIEW_MAX_RESULTS);
  });

  it('a garbage override falls back to the tool ceiling — never an unbounded LIMIT', async () => {
    const seed = publishedRows(12);
    const { repo, captured } = createSearchRepoStub(seed);
    const searchService = new KnowledgeSearchService(repo as never);

    await searchService.search(
      { query: 'นโยบายการประสานแผน', limit: 50 },
      { maxResultsOverride: Number.NaN },
    );
    expect(captured.limit).toBe(KNOWLEDGE_SEARCH_MAX_RESULTS);
  });
});
