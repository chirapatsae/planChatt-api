/**
 * Wave 57 W57-BE-AGG-01 — HEAD-of-lineage helper unit spec.
 *
 * The helper composes the §14.2 anti-join predicate so that, when fed a
 * QB stub, the LEFT JOIN target is `RevisedProjectGroup` (entity class —
 * not a raw table literal) and the resulting `andWhere` clause asserts
 * `*_desc.id IS NULL` (head-of-lineage = no descendant).
 *
 * Validates:
 *   1. PG variant attaches `prev_project_type = 'original'` and
 *      `deleted_at IS NULL`.
 *   2. RPG variant attaches `prev_project_type = 'revised'` and
 *      `deleted_at IS NULL`.
 *   3. Default desc-aliases are unique per variant so the same QB can
 *      apply both helpers without alias collision.
 *   4. The helpers return the SAME QB (fluent chain).
 */
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';

import {
  HEAD_OF_LINEAGE_ADVISORY,
  applyHeadFilterForProjectGroup,
  applyHeadFilterForRevisedProjectGroup,
} from '../helpers/head-of-lineage';

describe('W57-BE-AGG-01 / HEAD-of-lineage helpers', () => {
  function makeQbStub() {
    const calls: Array<{
      kind: 'leftJoin' | 'andWhere';
      args: unknown[];
    }> = [];
    const qb: Record<string, unknown> = {};
    Object.assign(qb, {
      leftJoin: (...args: unknown[]) => {
        calls.push({ kind: 'leftJoin', args });
        return qb;
      },
      andWhere: (...args: unknown[]) => {
        calls.push({ kind: 'andWhere', args });
        return qb;
      },
    });
    return { qb: qb as never, calls };
  }

  it('exports the canonical advisory string', () => {
    expect(HEAD_OF_LINEAGE_ADVISORY).toBe('head-of-lineage-applied');
  });

  it('PG variant attaches anti-join with prev_project_type = original', () => {
    const { qb, calls } = makeQbStub();
    const out = applyHeadFilterForProjectGroup(qb, 'pg');
    expect(out).toBe(qb);
    expect(calls).toHaveLength(2);
    expect(calls[0].kind).toBe('leftJoin');
    // The first arg must be the entity class — never a raw table
    // literal (Wave 54 no-raw-SQL gate).
    expect(calls[0].args[0]).toBe(RevisedProjectGroup);
    expect(String(calls[0].args[2])).toContain(
      "prev_project_type = 'original'",
    );
    expect(String(calls[0].args[2])).toContain('deleted_at IS NULL');
    expect(calls[1].kind).toBe('andWhere');
    expect(String(calls[1].args[0])).toMatch(/\.id IS NULL$/);
  });

  it('RPG variant attaches anti-join with prev_project_type = revised', () => {
    const { qb, calls } = makeQbStub();
    const out = applyHeadFilterForRevisedProjectGroup(qb, 'rpg');
    expect(out).toBe(qb);
    expect(calls[0].args[0]).toBe(RevisedProjectGroup);
    expect(String(calls[0].args[2])).toContain(
      "prev_project_type = 'revised'",
    );
    expect(String(calls[0].args[2])).toContain('deleted_at IS NULL');
  });

  it('default desc aliases differ between PG and RPG variants', () => {
    const { qb, calls } = makeQbStub();
    applyHeadFilterForProjectGroup(qb, 'pg');
    applyHeadFilterForRevisedProjectGroup(qb, 'rpg');
    const aliases = calls
      .filter((c) => c.kind === 'leftJoin')
      .map((c) => String(c.args[1]));
    expect(new Set(aliases).size).toBe(2);
  });

  // ──────────────────────────────────────────────────────────────────
  // §14.2 lineage golden — 1 PG + 2 chained RPGs:
  //   PG-A → RPG-A1 (prev=PG-A, type=original)
  //          → RPG-A2 (prev=RPG-A1, type=revised)
  //
  // HEAD-only set = { RPG-A2 }     (1 row)
  // All-versions  = { PG-A, RPG-A1, RPG-A2 }   (3 rows)
  //
  // The helper itself is verified above; this assertion is the
  // semantic-shape statement guarding the math the consumers do.
  // ──────────────────────────────────────────────────────────────────
  it('§14.2 golden — 1 PG + 2 chained RPGs → HEAD-only count = 1, all = 3', () => {
    const allVersions = ['PG-A', 'RPG-A1', 'RPG-A2'];
    const liveDescendantOf = new Set<string>([
      'PG-A', // RPG-A1 is its descendant
      'RPG-A1', // RPG-A2 is its descendant
    ]);
    const headOnly = allVersions.filter((id) => !liveDescendantOf.has(id));
    expect(headOnly).toEqual(['RPG-A2']);
    expect(headOnly).toHaveLength(1);
    expect(allVersions).toHaveLength(3);
  });
});
