/**
 * BE-W53-04 — grep-gate meta-test against raw SQL table literals in the
 * executive chat tool layer.
 *
 * Background: Wave 53 P0 outage was caused by a single raw-SQL literal
 * `FROM budgets` inside `listProjectsInPlan`. The physical table is
 * `budget` (singular) — see `backend/src/budget/entities/budget.entity.ts`
 * `@Entity('budget')`. The latent bug escaped unit tests because the
 * QB mock intercepts the chain above the raw-SQL layer.
 *
 * This meta-test reads every `.ts` file under
 * `backend/src/ai-executive-chat/tools/` and fails if any contains a
 * raw table literal. It complements BE-W53-01's handler fix by making
 * sure the same class of bug cannot regress under a different tool
 * handler, and it is intentionally DESIGNED to fail if someone
 * reintroduces a raw `FROM budgets` snippet.
 *
 * CLAUDE.md §17.3 — AI tool layer is read-only; no raw table mutation.
 * CLAUDE.md §17.11 — no role exemption; the gate applies universally.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const TOOLS_DIR = join(__dirname, '..');

// Self (this spec) is allowed to mention raw literals inside quoted
// regex patterns so the gate message is explicit. We filter this file
// out of the scan to avoid self-matching.
const SELF_BASENAME = 'wave53-no-raw-sql.spec.ts';

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
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

describe('BE-W53-04 / no raw SQL table literals under tools/', () => {
  const files = walk(TOOLS_DIR).filter((p) => !p.endsWith(SELF_BASENAME));

  it('sanity — scanner picks up at least the known tool files', () => {
    // At minimum: tool-registry.ts, executive-tool-handlers.ts,
    // handler-types.ts, plus a handful of __tests__ files.
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(
      files.some((p) => p.endsWith('executive-tool-handlers.ts')),
    ).toBe(true);
  });

  // Allowlist of files that are explicit regression traps (this spec
  // file and the user-repro spec): they contain regex literals that
  // mention the word "budgets" by design to exercise the trap. We only
  // exempt test files from the quoted-literal check, NOT from the
  // `FROM <bare>` check.
  const QUOTED_CHECK_ALLOWLIST = new Set<string>([
    'wave53-user-repro.spec.ts',
    // future: additional meta-tests that exercise the trap by name
  ]);

  it.each(files)(
    '%s — does not contain a raw `FROM budgets` / `"budgets"` / `\'budgets\'` / `` `budgets` `` literal',
    (file) => {
      const src = readFileSync(file, 'utf8');
      const basename = file.split('/').pop() ?? '';

      if (QUOTED_CHECK_ALLOWLIST.has(basename)) {
        // Allow regression-trap specs to mention the literal inside
        // test-scoped regex patterns; still block the bare FROM match.
        const bareFrom = /\bFROM\s+budgets\b/i;
        expect({ file: basename, raw: bareFrom.test(src) }).toEqual({
          file: basename,
          raw: false,
        });
        return;
      }

      // FROM budgets (case-insensitive word-bounded).
      expect({
        file: basename,
        reason: 'FROM budgets literal found — use TypeORM .from(Budget, "b")',
        hit: /\bFROM\s+budgets\b/i.test(src),
      }).toEqual({
        file: basename,
        reason: 'FROM budgets literal found — use TypeORM .from(Budget, "b")',
        hit: false,
      });

      // Double-quoted "budgets".
      expect({
        file: basename,
        reason: 'Double-quoted "budgets" literal found',
        hit: /"budgets"/i.test(src),
      }).toEqual({
        file: basename,
        reason: 'Double-quoted "budgets" literal found',
        hit: false,
      });

      // Single-quoted 'budgets'.
      expect({
        file: basename,
        reason: "Single-quoted 'budgets' literal found",
        hit: /'budgets'/i.test(src),
      }).toEqual({
        file: basename,
        reason: "Single-quoted 'budgets' literal found",
        hit: false,
      });

      // Backtick-wrapped `budgets`.
      expect({
        file: basename,
        reason: 'Backtick `budgets` literal found',
        hit: /`budgets`/i.test(src),
      }).toEqual({
        file: basename,
        reason: 'Backtick `budgets` literal found',
        hit: false,
      });
    },
  );

  // ──────────────────────────────────────────────────────────────────
  // Broader identifier allowlist gate: any bare SQL identifier inside a
  // template literal preceded by `FROM ` or `JOIN ` is a red flag. The
  // tool layer SHOULD always go through TypeORM entity references.
  // ──────────────────────────────────────────────────────────────────
  const BARE_IDENTIFIER_SOURCE =
    '(?:project_groups|revised_project_groups|supplement_project_groups|' +
    'development_plan|development_plan_revision|development_plan_supplement|' +
    'tracking_status|government_agencies|amphoe|budget)';
  // Intentionally target template literals only — comments and string
  // literals that happen to include an entity name (e.g. in a Thai
  // sentence) do not compile into SQL.
  const TEMPLATE_FROM_RE = new RegExp(
    '`[^`]*\\b(?:FROM|from|JOIN|join)\\s+' + BARE_IDENTIFIER_SOURCE + '\\b[^`]*`',
  );

  it.each(files)(
    '%s — does not embed a bare SQL identifier in a template literal after FROM/JOIN',
    (file) => {
      const src = readFileSync(file, 'utf8');
      const basename = file.split('/').pop() ?? '';

      if (QUOTED_CHECK_ALLOWLIST.has(basename)) {
        // Regression-trap specs may embed such strings by design.
        return;
      }

      const match = src.match(TEMPLATE_FROM_RE);
      expect({
        file: basename,
        hint:
          'Bare SQL identifier after FROM/JOIN inside a template literal. ' +
          'Refactor to use the TypeORM repository pattern: ' +
          '`dataSource.getRepository(EntityClass).createQueryBuilder("alias")`. ' +
          'Raw table literals drift out of sync when entity table names ' +
          'change (e.g. @Entity("budget") vs "budgets").',
        hit: match ? match[0] : null,
      }).toEqual({
        file: basename,
        hint:
          'Bare SQL identifier after FROM/JOIN inside a template literal. ' +
          'Refactor to use the TypeORM repository pattern: ' +
          '`dataSource.getRepository(EntityClass).createQueryBuilder("alias")`. ' +
          'Raw table literals drift out of sync when entity table names ' +
          'change (e.g. @Entity("budget") vs "budgets").',
        hit: null,
      });
    },
  );
});
