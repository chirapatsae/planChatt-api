/**
 * W55-SEC-01 — SQL-injection audit + PII projection audit for Wave 55.
 *
 * Covers two claims under audit:
 *
 *  (1) W55-BE-06 / W55-BE-07 `applyFilters` plumbing is parameterised.
 *      Every filter dimension (`status`, `amphoeIds`, `agencyIds`,
 *      `budgetRange`, `dateRange`, `originType`) MUST bind the user-
 *      derived values through TypeORM named parameters, never via
 *      string interpolation into a WHERE / JOIN clause.
 *
 *  (2) W55-BE-07 creator-chain JOIN (`pg/rpg/spg.createdBy → WorkHistory
 *      → Amphoe + LocalAdministrativeOrganization`) projects ONLY the
 *      two ID scalars `wh_amp.id` and `wh_lao.id`. The SELECT list
 *      MUST NOT include person-level PII (`first_name`, `last_name`,
 *      `citizen_id`, `citizen_id_hash`, `phone`, `email`).
 *
 * Test strategy:
 *   - Stub a DataSource whose `getRepository` returns a QueryBuilder
 *     stub that captures every `.where` / `.andWhere` literal and
 *     every `.select` / `.addSelect` call.
 *   - Feed adversarial strings into each filter dimension and assert
 *     the adversarial bytes appear in `getParameters()` (the bind
 *     map) and NOT in the generated WHERE clause strings.
 *   - Concatenate every captured select-expression into a virtual
 *     "SELECT list" and grep it (case-insensitive) for the forbidden
 *     PII column name set.
 *
 * CLAUDE.md references:
 *   - §17.9 — prompt-injection defense; no string interpolation of
 *     user-controlled values.
 *   - §17.11 — no role exemption.
 *   - §4 / §4.1 — ownership vs workflow authority; PII lives on User,
 *     which is explicitly NOT joined here.
 */

import { UnifiedProjectAggregator } from '../services/unified-project-aggregator.service';

// ─────────────────────────────────────────────────────────────────────
// Test harness
// ─────────────────────────────────────────────────────────────────────

interface Capture {
  repositoryName: string;
  whereClauses: string[]; // literal clause strings passed to where/andWhere
  params: Record<string, unknown>; // bind map
  selectExpressions: string[]; // every .select / .addSelect column expr
  innerJoinClauses: string[]; // on-conditions of INNER JOINs (for status)
}

function makeDataSource(rowsByRepo: Record<string, unknown[]> = {}) {
  const captures: Capture[] = [];

  function qbFactory(repositoryName: string) {
    const cap: Capture = {
      repositoryName,
      whereClauses: [],
      params: {},
      selectExpressions: [],
      innerJoinClauses: [],
    };
    const qb: Record<string, unknown> = {};
    const self = () => qb;
    Object.assign(qb, {
      innerJoin: (target: unknown, _alias?: string, cond?: string) => {
        if (typeof cond === 'string') cap.innerJoinClauses.push(cond);
        return qb;
      },
      leftJoin: self,
      select: (expr: string, _alias?: string) => {
        if (typeof expr === 'string') cap.selectExpressions.push(expr);
        return qb;
      },
      addSelect: (expr: string, _alias?: string) => {
        if (typeof expr === 'string') cap.selectExpressions.push(expr);
        return qb;
      },
      where: (clause: string, params?: Record<string, unknown>) => {
        cap.whereClauses.push(clause);
        if (params) Object.assign(cap.params, params);
        return qb;
      },
      andWhere: (clause: string, params?: Record<string, unknown>) => {
        cap.whereClauses.push(clause);
        if (params) Object.assign(cap.params, params);
        return qb;
      },
      orderBy: self,
      limit: self,
      getRawMany: async () => {
        captures.push(cap);
        return rowsByRepo[repositoryName] ?? [];
      },
    });
    return qb;
  }

  const dataSource = {
    getRepository: (target: unknown) => {
      const repoName =
        typeof target === 'function'
          ? ((target as { name?: string }).name ?? 'Unknown')
          : 'Unknown';
      return {
        createQueryBuilder: (_alias: string) => qbFactory(repoName),
      };
    },
    // Budget subquery resolves its table name via metadata — keep it
    // stubbed for any budgetRange case.
    getMetadata: () => ({ tableName: 'budget' }),
  };

  return { dataSource, captures };
}

function svc(ds: unknown): UnifiedProjectAggregator {
  return new UnifiedProjectAggregator(ds as never);
}

// ─────────────────────────────────────────────────────────────────────
// (1) SQL-injection audit
// ─────────────────────────────────────────────────────────────────────

describe('W55-SEC-01 / SQL-injection audit — applyFilters (§17.9)', () => {
  // Adversarial payloads used across tests. Each is a canonical SQLi
  // attempt — if ANY of these ended up concatenated into the WHERE
  // clause (as opposed to bound as a parameter), the database would
  // either error or, worse, execute the injected predicate.
  const SQLI_AMPHOE = "3001'; DROP TABLE amphoes;--";
  const SQLI_AGENCY = '1 OR 1=1';
  const SQLI_STATUS = "Pending' OR 1=1--";
  const SQLI_DATE_FROM = "'; SELECT * FROM users;--";
  const SQLI_DATE_TO = "'; UPDATE users SET role='admin';--";

  it('filters.amphoeIds: attacker string is bound in params, NOT in the WHERE clause', async () => {
    const { dataSource, captures } = makeDataSource({
      ProjectGroup: [],
    });
    await svc(dataSource).listUnifiedProjects({
      scope: ['main'],
      filters: { amphoeIds: [SQLI_AMPHOE] },
    });
    expect(captures).toHaveLength(1);
    const cap = captures[0];
    // The clause MUST use a named placeholder, not the raw string.
    const amphoeClause = cap.whereClauses.find((c) => c.includes('amphoe_id'));
    expect(amphoeClause).toBeDefined();
    expect(amphoeClause).toContain(':...amphoeIdsFilter');
    expect(amphoeClause).not.toContain(SQLI_AMPHOE);
    expect(amphoeClause).not.toContain('DROP');
    // The raw attacker bytes MUST live in the bind map UNCHANGED —
    // TypeORM/pg will send them as a parameter, safely escaped.
    expect(cap.params.amphoeIdsFilter).toEqual([SQLI_AMPHOE]);
  });

  it('filters.agencyIds: non-numeric attacker string is DROPPED (AC #2); all-invalid maps to WHERE 1=0', async () => {
    const { dataSource, captures } = makeDataSource({
      ProjectGroup: [],
    });
    await svc(dataSource).listUnifiedProjects({
      scope: ['main'],
      // Number("1 OR 1=1") === NaN, so the entry is dropped.
      filters: { agencyIds: [SQLI_AGENCY] },
    });
    const cap = captures[0];
    // No bound agencyIdsFilter — the array collapsed to empty.
    expect(cap.params.agencyIdsFilter).toBeUndefined();
    // And the service short-circuits to a no-match instead of silently
    // emitting an unbound IN () that Postgres would reject.
    expect(cap.whereClauses).toContain('1 = 0');
    // Attacker bytes appear NOWHERE in the WHERE chain.
    for (const clause of cap.whereClauses) {
      expect(clause).not.toContain(SQLI_AGENCY);
    }
  });

  it('filters.agencyIds: mixed valid + invalid keeps numeric, drops non-numeric', async () => {
    const { dataSource, captures } = makeDataSource({
      ProjectGroup: [],
    });
    await svc(dataSource).listUnifiedProjects({
      scope: ['main'],
      filters: { agencyIds: [SQLI_AGENCY, '42'] },
    });
    const cap = captures[0];
    expect(cap.params.agencyIdsFilter).toEqual([42]);
    // The clause still binds via placeholder — no interpolation.
    const agencyClause = cap.whereClauses.find((c) =>
      c.includes('responsible_agency_id'),
    );
    expect(agencyClause).toContain(':...agencyIdsFilter');
    expect(agencyClause).not.toContain(SQLI_AGENCY);
  });

  it('filters.status: attacker string is bound in params, NOT in the JOIN / WHERE clause', async () => {
    const { dataSource, captures } = makeDataSource({
      ProjectGroup: [],
    });
    await svc(dataSource).listUnifiedProjects({
      scope: ['main'],
      filters: { status: [SQLI_STATUS] },
    });
    const cap = captures[0];
    // Status name flows through a named param, never concatenated.
    const statusClause = cap.whereClauses.find((c) => c.includes('st_f.name'));
    expect(statusClause).toBeDefined();
    expect(statusClause).toContain(':...statusFilter');
    expect(statusClause).not.toContain(SQLI_STATUS);
    // INNER JOIN on_conditions reference only FIXED aliases + columns,
    // no user-derived substring.
    for (const on of cap.innerJoinClauses) {
      expect(on).not.toContain(SQLI_STATUS);
    }
    expect(cap.params.statusFilter).toEqual([SQLI_STATUS]);
  });

  it('filters.dateRange: attacker string is bound in params (from/to), never interpolated', async () => {
    const { dataSource, captures } = makeDataSource({
      ProjectGroup: [],
    });
    await svc(dataSource).listUnifiedProjects({
      scope: ['main'],
      filters: { dateRange: { from: SQLI_DATE_FROM, to: SQLI_DATE_TO } },
    });
    const cap = captures[0];
    const dateClause = cap.whereClauses.find((c) => c.includes('created_at'));
    expect(dateClause).toBeDefined();
    expect(dateClause).toContain(':dateFrom');
    expect(dateClause).toContain(':dateTo');
    expect(dateClause).not.toContain(SQLI_DATE_FROM);
    expect(dateClause).not.toContain(SQLI_DATE_TO);
    expect(cap.params.dateFrom).toBe(SQLI_DATE_FROM);
    expect(cap.params.dateTo).toBe(SQLI_DATE_TO);
  });

  it('filters.budgetRange: min/max bound via :budgetMin/:budgetMax, Budget table resolved via metadata', async () => {
    const { dataSource, captures } = makeDataSource({
      ProjectGroup: [],
    });
    // Even though min/max are declared `number` at the DSL, guard
    // against a future type drift by proving placeholders exist.
    await svc(dataSource).listUnifiedProjects({
      scope: ['main'],
      filters: { budgetRange: { min: 100, max: 500 } },
    });
    const cap = captures[0];
    const budgetClause = cap.whereClauses.find((c) =>
      c.includes('BETWEEN :budgetMin AND :budgetMax'),
    );
    expect(budgetClause).toBeDefined();
    // Table name is the metadata-resolved 'budget' — not a hardcoded
    // literal. Double-quoted so Postgres treats it as an identifier.
    expect(budgetClause).toContain('"budget"');
    expect(cap.params.budgetMin).toBe(100);
    expect(cap.params.budgetMax).toBe(500);
  });

  it('filters.originType: agency + lao predicates use fixed sentinel binds, not user substrings', async () => {
    const { dataSource, captures } = makeDataSource({
      ProjectGroup: [],
    });
    await svc(dataSource).listUnifiedProjects({
      scope: ['main'],
      filters: { originType: ['agency-normal'] },
    });
    const cap = captures[0];
    const originClause = cap.whereClauses.find((c) => c.includes('wh_amp.id'));
    expect(originClause).toBeDefined();
    expect(originClause).toContain(':originAgencyAmphoeId');
    expect(originClause).toContain(':originAgencyLaoId');
    // The sentinel values come from a private static on the service,
    // NOT from any user-controlled input. Verify they are the CLAUDE.md
    // §1 constants.
    expect(cap.params.originAgencyAmphoeId).toBe('3001');
    expect(cap.params.originAgencyLaoId).toBe('3001027');
  });

  it('filters.originType: unknown values drop out; all-unknown collapses to WHERE 1=0', async () => {
    const { dataSource, captures } = makeDataSource({
      ProjectGroup: [],
    });
    const SQLI_ORIGIN = "agency-normal' OR 1=1--";
    await svc(dataSource).listUnifiedProjects({
      scope: ['main'],
      // Cast as never — the DSL narrows to two strings, this asserts
      // the service defends against a malicious bypass at runtime.
      filters: { originType: [SQLI_ORIGIN as unknown as 'agency-normal'] },
    });
    const cap = captures[0];
    // Unknown origin → whitelist is empty → 1=0 short-circuit.
    expect(cap.whereClauses).toContain('1 = 0');
    for (const clause of cap.whereClauses) {
      expect(clause).not.toContain(SQLI_ORIGIN);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// (2) PII audit — W55-BE-07 creator-chain JOIN
// ─────────────────────────────────────────────────────────────────────

describe('W55-SEC-01 / PII audit — W55-BE-07 creator-chain JOIN', () => {
  // Column names that MUST NEVER appear in the SELECT list of any of
  // the three loaders. Case-insensitive. Drawn from User entity
  // (`users/entities/user.entity.ts`) + the broader PII class list.
  const FORBIDDEN_PII_COLUMNS = [
    'first_name',
    'last_name',
    'citizen_id',
    'citizen_id_hash',
    'phone',
    'email',
  ];

  async function runAndCollectSelectExpressions(
    scope: 'main' | 'revised' | 'supplement',
  ) {
    const { dataSource, captures } = makeDataSource({
      ProjectGroup: [],
      RevisedProjectGroup: [],
      SupplementProjectGroup: [],
    });
    await svc(dataSource).listUnifiedProjects({ scope: [scope] });
    expect(captures).toHaveLength(1);
    return captures[0].selectExpressions;
  }

  it('main loader SELECT list contains zero PII columns', async () => {
    const exprs = await runAndCollectSelectExpressions('main');
    const joined = exprs.join('\n').toLowerCase();
    for (const col of FORBIDDEN_PII_COLUMNS) {
      expect(joined).not.toContain(col);
    }
    // Positive assertion: the creator chain contributes only the two
    // ID scalars claimed by W55-BE-07 — wh_amp.id + wh_lao.id.
    expect(exprs).toContain('wh_amp.id');
    expect(exprs).toContain('wh_lao.id');
  });

  it('revised loader SELECT list contains zero PII columns', async () => {
    const exprs = await runAndCollectSelectExpressions('revised');
    const joined = exprs.join('\n').toLowerCase();
    for (const col of FORBIDDEN_PII_COLUMNS) {
      expect(joined).not.toContain(col);
    }
    expect(exprs).toContain('wh_amp.id');
    expect(exprs).toContain('wh_lao.id');
  });

  it('supplement loader SELECT list contains zero PII columns', async () => {
    const exprs = await runAndCollectSelectExpressions('supplement');
    const joined = exprs.join('\n').toLowerCase();
    for (const col of FORBIDDEN_PII_COLUMNS) {
      expect(joined).not.toContain(col);
    }
    expect(exprs).toContain('wh_amp.id');
    expect(exprs).toContain('wh_lao.id');
  });

  it('NO loader SELECTs any wh_cb.* field (WorkHistory row scalars)', async () => {
    // wh_cb is the alias for WorkHistory itself. The only columns
    // allowed out of the creator chain are wh_amp.id and wh_lao.id;
    // pulling anything off wh_cb directly would risk a column named
    // similarly to a user-facing identifier (e.g. wh_cb.position,
    // wh_cb.start_date) leaking into the advisory projection.
    for (const scope of ['main', 'revised', 'supplement'] as const) {
      const exprs = await runAndCollectSelectExpressions(scope);
      for (const expr of exprs) {
        expect(expr.startsWith('wh_cb.')).toBe(false);
      }
    }
  });

  it('SELECT list references only expected aliases (pg|rpg|spg|dp|wh_amp|wh_lao)', async () => {
    // Belt-and-braces: the allowed alias set. Anything outside this
    // set is a regression — a new JOIN was added without updating
    // this audit.
    const ALLOWED_ALIAS = /^(pg|rpg|spg|dp|wh_amp|wh_lao)\./;
    for (const scope of ['main', 'revised', 'supplement'] as const) {
      const exprs = await runAndCollectSelectExpressions(scope);
      for (const expr of exprs) {
        expect(expr).toMatch(ALLOWED_ALIAS);
      }
    }
  });
});
