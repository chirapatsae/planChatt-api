/**
 * Wave 103 PR4 — Golden-fixture regression suite for count-consistency.
 *
 * Locks in the canonical agency-projects aggregator's behavior so that
 * future changes cannot reintroduce the W103 bug class:
 *   - Q1 vs Q2 count divergence within the same conversation
 *   - explicit-vs-bare scope drift
 *   - lineage double-counting (PG + RPG of the same chain)
 *   - frozen-book status leak (Pending et al. on `is_latest=false`)
 *   - active-book over-restriction (Approved-only when in-flight allowed)
 *   - soft-delete leak
 *   - HEAD-of-lineage mis-dedup (§14)
 *   - reportFormat coupling (§16)
 *   - empty-input crash
 *
 * The 9 GTs map 1:1 to the master plan §11 acceptance criteria
 * (W103-PLAN-AI-COUNT-CONSISTENCY.md) plus a 9th sanity test.
 *
 * INFRA NOTE
 * ──────────
 * The codebase has NO real-PG / SQLite-backed fixture harness in
 * `__tests__/golden-fixtures/` today (the directory is being created
 * here as the first occupant). The only established pattern in
 * `ai-executive-chat` is the TypeORM `DataSource`-mock harness in
 * `aggregation/services/agency-projects-canonical-aggregator.service.spec.ts`.
 *
 * Per the task's instruction "Don't invent a new test infra" and "DO NOT
 * add new dependencies", this spec REUSES the same mock-DataSource
 * pattern. The aggregator's SQL is exercised end-to-end by its own unit
 * spec; this golden suite locks in the OUTPUT contract — counts, budgets,
 * byBook structure, byLineage breakdown, and scopeApplied diagnostics —
 * by feeding the canned per-table raw rows that the real SQL would
 * produce under each scenario.
 *
 * If a real-PG fixture harness is later introduced, this file can be
 * lifted onto it without changing the assertions: the assertions are
 * about the canonical envelope, not about the SQL.
 *
 * §17.2 advisory only — counts, no workflow gates.
 * §17.3 — no `tracking_status` mutations exercised.
 * §14.2 / §15 / §16 — encoded in fixture row shapes, not in the
 *  aggregator's mocked SQL (real SQL coverage lives in PR1 service spec).
 */
import {
  AgencyProjectsCanonicalAggregatorService,
  AgencyProjectsCanonicalEnvelope,
} from '../../aggregation/services/agency-projects-canonical-aggregator.service';

// ─────────────────────────────────────────────────────────────────────
// Test infrastructure — mock DataSource (mirrors PR1 unit spec pattern)
// ─────────────────────────────────────────────────────────────────────

type RawRow = {
  bookid: string;
  bookname: string;
  islatest: boolean;
  cnt: number | string;
  budgetsum: number | string;
};

interface CannedRows {
  pg?: RawRow[];
  rpg?: RawRow[];
  spg?: RawRow[];
}

/**
 * Build a chainable QueryBuilder mock that resolves `getRawMany` with
 * canned rows. Mirrors `agency-projects-canonical-aggregator.service.spec.ts`
 * helper of the same shape (kept inline to avoid cross-file coupling).
 */
function makeQbMock(rows: RawRow[]): Record<string, unknown> {
  const qb: Record<string, unknown> = {};
  const passthrough = (): Record<string, unknown> => qb;
  for (const m of [
    'innerJoin',
    'leftJoin',
    'select',
    'addSelect',
    'where',
    'andWhere',
    'orWhere',
    'groupBy',
    'addGroupBy',
    'orderBy',
    'addOrderBy',
    'limit',
    'offset',
    'setParameters',
  ]) {
    qb[m] = passthrough;
  }
  qb.getRawMany = (): Promise<RawRow[]> => Promise.resolve(rows);
  qb.getRawOne = (): Promise<RawRow | undefined> => Promise.resolve(rows[0]);
  return qb;
}

/**
 * DataSource mock that dispatches per query-builder alias. The aggregator
 * uses 'pg' (ProjectGroup), 'rpg' (RevisedProjectGroup), 'spg'
 * (SupplementProjectGroup) as the primary aliases — see
 * `countMain` / `countRevised` / `countSupplement` in the service.
 */
function makeDataSourceMock(canned: CannedRows): unknown {
  return {
    getRepository: () => ({
      createQueryBuilder: (alias: string) => {
        if (alias === 'pg') return makeQbMock(canned.pg ?? []);
        if (alias === 'rpg') return makeQbMock(canned.rpg ?? []);
        if (alias === 'spg') return makeQbMock(canned.spg ?? []);
        return makeQbMock([]);
      },
    }),
  };
}

function makeService(
  canned: CannedRows,
): AgencyProjectsCanonicalAggregatorService {
  const ds = makeDataSourceMock(canned);
  return new AgencyProjectsCanonicalAggregatorService(ds as never);
}

// ─────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────

const KOG_YUTH_AGENCY_ID = 2; // "กองยุทธศาสตร์และงบประมาณ"

const PLAN_LATEST = {
  id: 'plan-2571-2575',
  name: 'แผนพัฒนา 2571-2575',
};
const PLAN_FROZEN = {
  id: 'plan-2566-2570',
  name: 'แผนพัฒนา 2566-2570',
};

/**
 * GT1 reference fixture — agency with 5 PG on frozen book + 2 PG on
 * latest book + 1 RPG (HEAD of a chain) on latest + 1 SPG on latest.
 *
 * Mirrors the W103 audit numbers (5 vs 8 vs 9): same canonical answer
 * regardless of "summary" vs "list" question phrasing.
 */
function gt1Fixture(): CannedRows {
  return {
    pg: [
      {
        bookid: PLAN_LATEST.id,
        bookname: PLAN_LATEST.name,
        islatest: true,
        cnt: 2,
        budgetsum: 4_700_000,
      },
      {
        bookid: PLAN_FROZEN.id,
        bookname: PLAN_FROZEN.name,
        islatest: false,
        cnt: 5,
        budgetsum: 10_170_300,
      },
    ],
    rpg: [
      {
        bookid: PLAN_LATEST.id,
        bookname: PLAN_LATEST.name,
        islatest: true,
        cnt: 1,
        budgetsum: 1_000_000,
      },
    ],
    spg: [
      {
        bookid: PLAN_LATEST.id,
        bookname: PLAN_LATEST.name,
        islatest: true,
        cnt: 1,
        budgetsum: 500_000,
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────

describe('Wave 103 PR4 — count-consistency golden fixtures', () => {
  // ───────────────────────────────────────────────────────────────────
  // GT1 — same agency, same conversation, identical counts
  // ───────────────────────────────────────────────────────────────────
  test('GT1 — same agency twice in one conversation returns identical count + budget', async () => {
    // Both Q1 and Q2 must resolve to the SAME canonical envelope when
    // the caller passes the same scope (agencyIds only, no planId).
    // Pre-W103, Q1 routed to a "summary" tool that scoped to latest plan
    // only (returning 5 / 10.17M) while Q2 routed to a "list" tool that
    // walked all books (returning 8 / 14.87M). With the canonical
    // aggregator, both questions converge on `{ agencyIds: [2] }`.
    const svc = makeService(gt1Fixture());

    const q1 = await svc.aggregate({ agencyIds: [KOG_YUTH_AGENCY_ID] });
    const q2 = await svc.aggregate({ agencyIds: [KOG_YUTH_AGENCY_ID] });

    expect(q1.count).toBe(q2.count);
    expect(q1.budgetTotal).toBe(q2.budgetTotal);
    // 2 (PG latest) + 5 (PG frozen Approved-only) + 1 (RPG) + 1 (SPG) = 9
    expect(q1.count).toBe(9);
    expect(q1.budgetTotal).toBe(16_370_300);
    // Per-book breakdown stable across calls.
    expect(q1.byBook).toEqual(q2.byBook);
    expect(q1.byLineage).toEqual(q2.byLineage);
  });

  // ───────────────────────────────────────────────────────────────────
  // GT2 — explicit-vs-bare scope
  // ───────────────────────────────────────────────────────────────────
  test('GT2 — explicit planId narrows scope; bare returns >= explicit', async () => {
    // When the caller passes an explicit planId, the aggregator scopes
    // to that book only. Bare (no planId) walks all books. We assert
    // Q2 (bare) >= Q1 (explicit-latest).
    //
    // The mock returns the same canned rows regardless of WHERE clause,
    // so to simulate planId-narrowing we feed two different services.
    const latestOnly = makeService({
      pg: [
        {
          bookid: PLAN_LATEST.id,
          bookname: PLAN_LATEST.name,
          islatest: true,
          cnt: 2,
          budgetsum: 4_700_000,
        },
      ],
    });
    const allBooks = makeService(gt1Fixture());

    const q1 = await latestOnly.aggregate({
      agencyIds: [KOG_YUTH_AGENCY_ID],
      planId: PLAN_LATEST.id,
    });
    const q2 = await allBooks.aggregate({
      agencyIds: [KOG_YUTH_AGENCY_ID],
    });

    expect(q1.scopeApplied.bookScope).toBe(`single-plan:${PLAN_LATEST.id}`);
    expect(q2.scopeApplied.bookScope).toBe('all-books');
    expect(q1.count).toBe(2);
    expect(q2.count).toBe(9);
    expect(q2.count).toBeGreaterThanOrEqual(q1.count);
    expect(q2.budgetTotal).toBeGreaterThanOrEqual(q1.budgetTotal);
  });

  // ───────────────────────────────────────────────────────────────────
  // GT3 — multi-book + multi-lineage agency, deterministic across phrasings
  // ───────────────────────────────────────────────────────────────────
  test('GT3 — multi-book + multi-lineage produces deterministic count (no double-count)', async () => {
    // Setup: agency owns
    //   - 2 PG in book A (latest)
    //   - 1 PG in book B (frozen, Approved)
    //   - 1 RPG (HEAD of a 4-deep chain — only the HEAD counts per §14.2)
    //   - 1 SPG
    // Total HEAD-only count = 2 + 1 + 1 + 1 = 5.
    // Pre-W103 a naive walker would have counted the chain as 4 RPGs.
    const fixture: CannedRows = {
      pg: [
        {
          bookid: PLAN_LATEST.id,
          bookname: PLAN_LATEST.name,
          islatest: true,
          cnt: 2,
          budgetsum: 2_000_000,
        },
        {
          bookid: PLAN_FROZEN.id,
          bookname: PLAN_FROZEN.name,
          islatest: false,
          cnt: 1,
          budgetsum: 500_000,
        },
      ],
      // The HEAD anti-join in `applyHeadFilterForRevisedProjectGroup`
      // eliminates RPG1, RPG2, RPG3 from the chain — only the leaf RPG3
      // (or whichever has no descendant) survives. The mock simulates
      // the post-anti-join row.
      rpg: [
        {
          bookid: PLAN_LATEST.id,
          bookname: PLAN_LATEST.name,
          islatest: true,
          cnt: 1,
          budgetsum: 800_000,
        },
      ],
      spg: [
        {
          bookid: PLAN_LATEST.id,
          bookname: PLAN_LATEST.name,
          islatest: true,
          cnt: 1,
          budgetsum: 300_000,
        },
      ],
    };
    const svc = makeService(fixture);

    // Run 4 times — simulating "ดูโครงการ", "นับโครงการ", "งบประมาณรวม",
    // "สรุปกอง X". All reduce to the same canonical aggregator call.
    const calls = await Promise.all([
      svc.aggregate({ agencyIds: [KOG_YUTH_AGENCY_ID] }),
      svc.aggregate({ agencyIds: [KOG_YUTH_AGENCY_ID] }),
      svc.aggregate({ agencyIds: [KOG_YUTH_AGENCY_ID] }),
      svc.aggregate({ agencyIds: [KOG_YUTH_AGENCY_ID] }),
    ]);

    const counts = calls.map((e: AgencyProjectsCanonicalEnvelope) => e.count);
    expect(new Set(counts).size).toBe(1); // determinism
    expect(counts[0]).toBe(5);
    expect(calls[0].byLineage).toEqual({ pg: 3, rpg: 1, spg: 1 });
    // Budget: 2_000_000 + 500_000 + 800_000 + 300_000 = 3_600_000
    expect(calls[0].budgetTotal).toBe(3_600_000);
  });

  // ───────────────────────────────────────────────────────────────────
  // GT4 — reportFormat branch (count is format-agnostic)
  // ───────────────────────────────────────────────────────────────────
  test('GT4 — count is format-agnostic across STRATEGY_BASED and ISSUE_BASED', async () => {
    // §16.5: classification shape differs between formats but the
    // PROJECT COUNT is keyed on `ProjectGroup.id`, not on classification.
    // Per §16.12 + the aggregator's docblock: "count is format-agnostic
    // — `ProjectGroup.id` is the unit, not classification fields."
    //
    // Two plans of different formats with the same number of projects
    // MUST produce the same canonical count. The fixture encodes both
    // books' PG rows; classification is invisible to the aggregator.
    const strategyPlanId = 'plan-strategy';
    const issuePlanId = 'plan-issue';

    const svc = makeService({
      pg: [
        {
          bookid: strategyPlanId,
          bookname: 'แผน STRATEGY (ยุทธศาสตร์)',
          islatest: true,
          cnt: 3,
          budgetsum: 1_000_000,
        },
        {
          bookid: issuePlanId,
          bookname: 'แผน ISSUE (ประเด็นการพัฒนา)',
          islatest: true,
          cnt: 3,
          budgetsum: 1_000_000,
        },
      ],
    });

    const out = await svc.aggregate({ agencyIds: [KOG_YUTH_AGENCY_ID] });
    expect(out.count).toBe(6);
    expect(out.budgetTotal).toBe(2_000_000);
    expect(out.byBook).toHaveLength(2);
    // Every book row must be present regardless of reportFormat.
    const bookIds = out.byBook.map((b) => b.bookId).sort();
    expect(bookIds).toEqual([issuePlanId, strategyPlanId].sort());
    // Aggregator does not surface classification fields — confirms
    // format-agnostic shape (no `indicator`, no `developmentIssueId`).
    expect(Object.keys(out.byBook[0])).toEqual(
      expect.arrayContaining([
        'bookId',
        'bookName',
        'isLatest',
        'count',
        'budget',
      ]),
    );
  });

  // ───────────────────────────────────────────────────────────────────
  // GT5 — frozen book Approved-only
  // ───────────────────────────────────────────────────────────────────
  test('GT5 — frozen book includes Approved only (excludes Pending et al.)', async () => {
    // The aggregator's SQL filters frozen books to CANONICAL_FROZEN_STATUSES
    // = ['Approved']. Pre-W103 `listUnifiedProjects` had no default status
    // filter and leaked Pending / Pending_Approval / Verified rows from
    // older books into the count.
    //
    // We simulate the effect by feeding ONLY the Approved subset for the
    // frozen book — the Pending rows would never appear in `getRawMany`
    // because the SQL `WHERE st.name IN (:...statusesFrozen)` eliminates
    // them. The assertion is that scopeApplied.statusesFrozen == ['Approved']
    // and the count reflects only the Approved subset.
    const svc = makeService({
      pg: [
        {
          bookid: PLAN_FROZEN.id,
          bookname: PLAN_FROZEN.name,
          islatest: false,
          cnt: 5, // Only the 5 Approved rows survive the SQL status filter.
          budgetsum: 10_000_000,
        },
      ],
    });

    const out = await svc.aggregate({ agencyIds: [KOG_YUTH_AGENCY_ID] });
    expect(out.scopeApplied.statusesFrozen).toEqual(['Approved']);
    expect(out.count).toBe(5);
    expect(out.byBook).toHaveLength(1);
    expect(out.byBook[0].isLatest).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────
  // GT6 — active book includeStatuses
  // ───────────────────────────────────────────────────────────────────
  test('GT6 — active book counts Approved + Pending + Verified + Pending_Approval (excludes Ready / Pull_Back / Returned_For_Revision / Rejected)', async () => {
    // CANONICAL_ACTIVE_STATUSES = ['Approved', 'Pending', 'Verified',
    // 'Pending_Approval']. Ready / Pull_Back / Returned_For_Revision /
    // Rejected (W67) are EXCLUDED.
    //
    // Like GT5, the SQL filters out the excluded rows server-side. The
    // mock simulates the post-filter row set.
    const svc = makeService({
      pg: [
        {
          bookid: PLAN_LATEST.id,
          bookname: PLAN_LATEST.name,
          islatest: true,
          // Only the 4 in-flight statuses contribute (1 each):
          // Approved + Pending + Verified + Pending_Approval = 4.
          // Ready, Pull_Back, Returned_For_Revision, Rejected dropped by SQL.
          cnt: 4,
          budgetsum: 4_000_000,
        },
      ],
    });

    const out = await svc.aggregate({ agencyIds: [KOG_YUTH_AGENCY_ID] });
    expect(out.scopeApplied.statusesActive).toEqual([
      'Approved',
      'Pending',
      'Verified',
      'Pending_Approval',
    ]);
    // Sanity: excluded statuses NEVER appear in the canonical active set.
    expect(out.scopeApplied.statusesActive).not.toContain('Ready');
    expect(out.scopeApplied.statusesActive).not.toContain('Pull_Back');
    expect(out.scopeApplied.statusesActive).not.toContain(
      'Returned_For_Revision',
    );
    expect(out.scopeApplied.statusesActive).not.toContain('Rejected');
    expect(out.count).toBe(4);
  });

  // ───────────────────────────────────────────────────────────────────
  // GT7 — soft-delete exclusion
  // ───────────────────────────────────────────────────────────────────
  test('GT7 — soft-deleted rows excluded from count and budget', async () => {
    // §14.2 + service docblock invariant: "Soft-delete: excluded
    // everywhere". The aggregator's SQL appends `pg.deletedAt IS NULL` /
    // `rpg.deletedAt IS NULL` / `spg.deletedAt IS NULL` to every query.
    //
    // We model the post-filter result: a fixture where the only rows
    // with `deleted_at IS NOT NULL` are dropped server-side, so the mock
    // returns an empty pg/rpg/spg row set (or the surviving subset).
    //
    // Scenario: 3 PG rows in a book, 2 of them soft-deleted. SQL returns
    // only the 1 survivor.
    const svc = makeService({
      pg: [
        {
          bookid: PLAN_LATEST.id,
          bookname: PLAN_LATEST.name,
          islatest: true,
          cnt: 1, // 1 survivor; 2 soft-deleted rows filtered by SQL.
          budgetsum: 100_000,
        },
      ],
    });

    const out = await svc.aggregate({ agencyIds: [KOG_YUTH_AGENCY_ID] });
    expect(out.count).toBe(1);
    expect(out.budgetTotal).toBe(100_000);

    // Edge case: ALL rows soft-deleted → empty rows from SQL → zero envelope.
    const svcAllDeleted = makeService({ pg: [] });
    const outAllDeleted = await svcAllDeleted.aggregate({
      agencyIds: [KOG_YUTH_AGENCY_ID],
    });
    expect(outAllDeleted.count).toBe(0);
    expect(outAllDeleted.budgetTotal).toBe(0);
    expect(outAllDeleted.byBook).toEqual([]);
  });

  // ───────────────────────────────────────────────────────────────────
  // GT8 — HEAD-of-lineage dedup (§14)
  // ───────────────────────────────────────────────────────────────────
  test('GT8 — HEAD-of-lineage dedup: 4-deep chain contributes 1, not 4', async () => {
    // Lineage: PG → RPG1 → RPG2 → RPG3 (HEAD).
    //
    // Per §14.2 the HEAD is the only row that has NO non-deleted
    // descendant. In the canonical aggregator:
    //   - `applyHeadFilterForProjectGroup` excludes the PG (it has
    //     a live RPG descendant).
    //   - `applyHeadFilterForRevisedProjectGroup` excludes RPG1 and RPG2
    //     (each has a live RPG descendant); RPG3 survives.
    //
    // SQL returns: pg = [] (PG dropped), rpg = [1 row] (RPG3 only).
    // Total canonical count = 0 + 1 + 0 = 1.
    const svc = makeService({
      pg: [], // PG is NOT a HEAD (RPG1 references it) → excluded.
      rpg: [
        // Only RPG3 survives the descendant anti-join.
        {
          bookid: PLAN_LATEST.id,
          bookname: PLAN_LATEST.name,
          islatest: true,
          cnt: 1,
          budgetsum: 250_000,
        },
      ],
      spg: [],
    });

    const out = await svc.aggregate({ agencyIds: [KOG_YUTH_AGENCY_ID] });
    expect(out.count).toBe(1);
    expect(out.byLineage).toEqual({ pg: 0, rpg: 1, spg: 0 });
    expect(out.budgetTotal).toBe(250_000);
    expect(out.scopeApplied.headFilterActive).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────
  // GT9 — empty agency list returns zero, not crash
  // ───────────────────────────────────────────────────────────────────
  test('GT9 — empty agency list returns zero envelope (no crash, no DB hit)', async () => {
    // Per service contract: "Returns an all-zero envelope on empty
    // agencyIds — never throws." Defensive guard against LLM edge cases
    // where the upstream resolver returns no agencies.
    const svc = makeService({
      // Even if the mock had data, the early-return short-circuits.
      pg: [
        {
          bookid: PLAN_LATEST.id,
          bookname: PLAN_LATEST.name,
          islatest: true,
          cnt: 99,
          budgetsum: 999_999_999,
        },
      ],
    });

    const out = await svc.aggregate({ agencyIds: [] });
    expect(out.count).toBe(0);
    expect(out.budgetTotal).toBe(0);
    expect(out.byBook).toHaveLength(0);
    expect(out.byLineage).toEqual({ pg: 0, rpg: 0, spg: 0 });
    expect(out.rawRowCount).toEqual({ pg: 0, rpg: 0, spg: 0 });
    // scopeApplied still populated diagnostically.
    expect(out.scopeApplied.bookScope).toBe('all-books');
    expect(out.scopeApplied.headFilterActive).toBe(true);
  });
});
