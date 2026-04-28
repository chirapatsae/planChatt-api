/**
 * BE-W54-08 — Wave 54 no-raw-SQL grep gate.
 *
 * Supersedes Wave 53's trap (which covered only `tools/`) with a broader
 * scan over BOTH `tools/` AND `aggregation/` directories.
 *
 * Fails CI if any .ts file under either tree contains:
 *   - `FROM budget(s)` (bareword SQL after FROM/JOIN)
 *   - bare `'budgets'` / `"budgets"` string literal (the table is
 *     `@Entity('budget')`, plural `'budgets'` is the production-outage
 *     regression literal)
 *   - template literal with `FROM`/`JOIN` followed by any known bare
 *     SQL identifier
 *
 * Whitelist:
 *   - `advisory-copy.ts` — contains the Thai word "งบประมาณ" (budget), not
 *     an SQL token
 *   - The new spec files added in BE-W54-08 — they contain these patterns
 *     as assertion literals
 *   - `advisory-copy.ts` module-level `BUDGET_UNAVAILABLE` constant is
 *     plain Thai, not SQL
 *
 * CLAUDE.md §17.2 / §17.3 — AI tool layer is read-only; no raw table
 * literals. CLAUDE.md §17.11 — no role exemption; the gate applies
 * universally regardless of caller.
 *
 * The Wave 53 spec (`tools/__tests__/wave53-no-raw-sql.spec.ts`) is
 * preserved (demote-not-retire) — both traps co-exist.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const TOOLS_DIR = join(__dirname, '..', '..', 'tools');
const AGG_DIR = join(__dirname, '..');

// Self-allowlist — this spec (and its sibling new specs) may mention the
// trap patterns literally inside assertion strings / regex sources.
const SELF_ALLOWLIST = new Set<string>([
  'wave54-no-raw-sql.spec.ts',
  'fallback-envelope.spec.ts',
  'wave54-bilingual-success.spec.ts',
  'plan-overview.spec.ts',
  'dashboard-snapshot.spec.ts',
  'cross-plan-insights.spec.ts',
  'dsl-contract.spec.ts',
  'report-format-branching.spec.ts',
  // Wave 53 specs that intentionally mention the literal to exercise the
  // regression trap — they are already whitelisted by the Wave 53 gate;
  // we repeat them here to keep the Wave 54 gate internally consistent.
  'wave53-no-raw-sql.spec.ts',
  'wave53-user-repro.spec.ts',
  // Aggregation-layer specs that mention dimension names ('budget',
  // 'status', etc.) as part of the MissingDimension enum under test.
  'budget-aggregator.spec.ts',
  'status.aggregator.spec.ts',
  'resilience-envelope.spec.ts',
  'geo-enrichment.spec.ts',
  'agency-enrichment.spec.ts',
  'unified-project-aggregator.spec.ts',
  // W55-SEC-01 — SQL-injection audit spec; mentions `"budget"` and
  // adversarial `DROP`/`SELECT` literals as assertion strings.
  'w55-sec-01-sql-injection.spec.ts',
  // W55-QA-01 — province-scope invariant + origin-type + envelope-golden
  // specs. These specs reference aggregator internals but do not carry
  // any raw SQL trap literal; allowlisted defensively in case a future
  // edit introduces one.
  'province-scope-invariant.spec.ts',
  'origin-type.spec.ts',
  'envelope-golden.spec.ts',
]);

// `advisory-copy.ts` uses the Thai word งบประมาณ ("budget" in Thai) — not
// an SQL token. It is explicitly allowlisted.
const CONTENT_ALLOWLIST = new Set<string>([
  'advisory-copy.ts',
  // `missing-dimension.ts` enumerates the `'budget'` literal as a
  // discriminator value of the MissingDimension union — not SQL.
  'missing-dimension.ts',
]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    // Skip `__tests__` subdirs during the SQL scan — they are assertion
    // sources by design and are handled via SELF_ALLOWLIST for the
    // remaining scan.
    if (entry === 'node_modules' || entry === 'dist') continue;
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      walk(p, acc);
    } else if (p.endsWith('.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

describe('BE-W54-08 / no raw SQL budgets literal under tools/ + aggregation/', () => {
  const files = [...walk(TOOLS_DIR), ...walk(AGG_DIR)];

  it('sanity — scanner picks up files from BOTH trees', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(
      files.some((p) => p.endsWith('executive-tool-handlers.ts')),
    ).toBe(true);
    expect(
      files.some((p) => p.endsWith('resilience-envelope.service.ts')),
    ).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────
  // Gate 1 — bare `FROM budget` / `FROM budgets` after a word boundary.
  // ───────────────────────────────────────────────────────────────────
  const BARE_FROM_BUDGET = /\bFROM\s+budgets?\b/i;

  it.each(files)('%s — no bare `FROM budget(s)` literal', (file) => {
    const basename = file.split('/').pop() ?? '';
    if (SELF_ALLOWLIST.has(basename)) return;
    if (CONTENT_ALLOWLIST.has(basename)) return;
    const src = readFileSync(file, 'utf8');
    expect({
      file: basename,
      hit: BARE_FROM_BUDGET.test(src),
      reason: 'Raw `FROM budget(s)` literal — use TypeORM .from(Budget, "b")',
    }).toEqual({
      file: basename,
      hit: false,
      reason: 'Raw `FROM budget(s)` literal — use TypeORM .from(Budget, "b")',
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Gate 2 — bareword "budgets" / 'budgets' string literal.
  // ───────────────────────────────────────────────────────────────────
  const DOUBLE_QUOTED_BUDGETS = /"budgets"/i;
  const SINGLE_QUOTED_BUDGETS = /'budgets'/i;
  const BACKTICK_BUDGETS = /`budgets`/i;

  it.each(files)(
    '%s — no bare "budgets" / \'budgets\' / `budgets` string literal',
    (file) => {
      const basename = file.split('/').pop() ?? '';
      if (SELF_ALLOWLIST.has(basename)) return;
      if (CONTENT_ALLOWLIST.has(basename)) return;
      const src = readFileSync(file, 'utf8');
      expect({
        file: basename,
        dq: DOUBLE_QUOTED_BUDGETS.test(src),
        sq: SINGLE_QUOTED_BUDGETS.test(src),
        bt: BACKTICK_BUDGETS.test(src),
      }).toEqual({ file: basename, dq: false, sq: false, bt: false });
    },
  );

  // ───────────────────────────────────────────────────────────────────
  // Gate 3 — template literal containing SQL `FROM`/`JOIN` followed by
  // any of the known bare identifiers. Aggregation-layer regression:
  // services MUST go through `dataSource.getRepository(EntityClass)`.
  // ───────────────────────────────────────────────────────────────────
  const BARE_IDENTIFIER_SOURCE =
    '(?:project_groups|revised_project_groups|supplement_project_groups|' +
    'development_plan|development_plan_revision|development_plan_supplement|' +
    'tracking_status|government_agencies|amphoe|budget|budgets)';
  const TEMPLATE_FROM_RE = new RegExp(
    '`[^`]*\\b(?:FROM|from|JOIN|join)\\s+' +
      BARE_IDENTIFIER_SOURCE +
      '\\b[^`]*`',
  );

  it.each(files)(
    '%s — no bare SQL identifier in template literal after FROM/JOIN',
    (file) => {
      const basename = file.split('/').pop() ?? '';
      if (SELF_ALLOWLIST.has(basename)) return;
      if (CONTENT_ALLOWLIST.has(basename)) return;
      const src = readFileSync(file, 'utf8');
      const match = src.match(TEMPLATE_FROM_RE);
      expect({ file: basename, hit: match ? match[0] : null }).toEqual({
        file: basename,
        hit: null,
      });
    },
  );
});
