/**
 * Wave 57 W57-BE-AGG-03 — Regex gate: no aggregator may roll up
 * project-amphoe / project-อปท. via the CREATOR's WorkHistory chain.
 *
 * The H3 hazard: a tool that joins through `creator.workHistory.amphoe`
 * (alias `wh_amp`) and then GROUPs / WHEREs on that alias mistakes the
 * REQUESTER's amphoe for the PROJECT's amphoe. Per Q4 + additional
 * clarifications:
 *   - `WHERE project.amphoe_id = X`             — correct.
 *   - `WHERE project.local_administrative_organization_id = Y` — correct.
 *   - `WHERE project.responsible_agency_id = Z`  — correct.
 *   - `WHERE wh_amp.id = X` for amphoe rollup — INCORRECT (the bug).
 *
 * `wh_amp.id` / `wh_lao.id` ARE legitimately referenced for the §1 + §5
 * `originType` filter — that path checks the CREATOR's classification,
 * not the project's location. The gate therefore EXEMPTS predicates
 * that bind the agency/lao sentinel param names
 * (`originAgencyAmphoeId`, `originAgencyLaoId`) — those are the
 * canonical originType param names introduced by Wave 55 W55-BE-07.
 *
 * The gate scans every aggregator + tool source file and fails if a
 * `groupBy(...)` / `addGroupBy(...)` / `where(...)` / `andWhere(...)`
 * clause references `wh_amp.id` or `wh_lao.id` outside the originType
 * exemption.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const AGG_DIR = join(__dirname, '..');
const TOOLS_DIR = join(__dirname, '..', '..', 'tools');

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    if (entry === '__tests__') continue; // skip the spec tree itself
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, acc);
    else if (p.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

// Tokenise the source file into lines and inspect each line. We
// flag a line if it contains a `groupBy(` / `addGroupBy(` / `where(` /
// `andWhere(` call AND mentions `wh_amp.id` or `wh_lao.id`, UNLESS the
// line is part of the §1+§5 originType filter (identified by the
// well-known param names below).
const ORIGIN_PARAM_TOKENS = [
  'originAgencyAmphoeId',
  'originAgencyLaoId',
];

const TARGET_ALIAS_RE = /(?:wh_amp|wh_lao)\.id/;
const QB_CLAUSE_RE =
  /(?:\.groupBy|\.addGroupBy|\.where|\.andWhere)\s*\(/;

function isOriginExempt(line: string): boolean {
  return ORIGIN_PARAM_TOKENS.some((t) => line.includes(t));
}

describe('W57-BE-AGG-03 / no-creator-amphoe-rollup gate', () => {
  const files = [...walk(AGG_DIR), ...walk(TOOLS_DIR)];

  it('sanity — scanner picks up files from BOTH trees', () => {
    expect(files.length).toBeGreaterThan(5);
    expect(
      files.some((p) => p.endsWith('unified-project-aggregator.service.ts')),
    ).toBe(true);
    expect(
      files.some((p) => p.endsWith('executive-tool-handlers.ts')),
    ).toBe(true);
  });

  it.each(files)(
    '%s — no project-amphoe / อปท. rollup via wh_amp / wh_lao alias',
    (file) => {
      const src = readFileSync(file, 'utf8');
      const lines = src.split('\n');

      // Multi-line QB chains: a `groupBy('wh_amp.id')` call may live on
      // a separate line from the call expression, AND the bind-param
      // object that hosts the exemption tokens may live AFTER the alias
      // line (the typical TypeORM `qb.andWhere('predicate', { params })`
      // shape spans 3-7 lines). We therefore inspect a small window
      // around each alias-bearing line — anchored on the nearest QB call
      // expression above — and mark the hit as exempt if ANY line in the
      // window mentions an originType bind-param token.
      const offences: Array<{ line: number; text: string }> = [];
      // Window radius: lookback up to 6 lines for the QB call; lookahead
      // up to 8 lines for the bind-param object.
      const LOOKBACK = 6;
      const LOOKAHEAD = 8;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!TARGET_ALIAS_RE.test(line)) continue;

        // Find the nearest QB call expression above (or on) this line.
        let qbAt = -1;
        for (let j = i; j >= Math.max(0, i - LOOKBACK); j--) {
          if (QB_CLAUSE_RE.test(lines[j])) {
            qbAt = j;
            break;
          }
        }
        if (qbAt < 0) continue; // alias mention not inside a QB clause

        // Window = [qbAt, i + LOOKAHEAD]. Exempt if any line in the
        // window mentions the originType bind-param tokens.
        const windowEnd = Math.min(lines.length - 1, i + LOOKAHEAD);
        let exempt = false;
        for (let k = qbAt; k <= windowEnd; k++) {
          if (isOriginExempt(lines[k])) {
            exempt = true;
            break;
          }
        }
        if (!exempt) {
          offences.push({ line: i + 1, text: line.trim() });
        }
      }

      expect({ file: file.split('/').pop(), offences }).toEqual({
        file: file.split('/').pop(),
        offences: [],
      });
    },
  );
});
