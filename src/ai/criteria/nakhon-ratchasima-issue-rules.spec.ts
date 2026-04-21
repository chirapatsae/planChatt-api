/**
 * Wave 39 N3 — Registry coverage tests for `exampleActivities`.
 *
 * Verifies that the Wave 39 N1 seeding of per-sub-type activity
 * templates remains complete and well-formed. These tests read the
 * REAL registry (no mocks) so any future drift is caught.
 *
 * Advisory / static system content per CLAUDE.md §17.2 + §17.9 — these
 * entries are injected into the ISSUE_BASED generate prompt via the
 * `[EXAMPLES]` block; they MUST NOT contain bracket markers that would
 * collide with the `briefing-sanitizer` BRACKETED_MARKER regex.
 */

import { NAKHON_RATCHASIMA_ISSUE_RULES } from './nakhon-ratchasima-issue-rules';

describe('NAKHON_RATCHASIMA_ISSUE_RULES — Wave 39 exampleActivities coverage', () => {
  const allSubTypes = NAKHON_RATCHASIMA_ISSUE_RULES.flatMap(
    (entry) => entry.subTypes,
  );

  it('has exactly 19 sub-types across 6 issue entries', () => {
    expect(NAKHON_RATCHASIMA_ISSUE_RULES.length).toBe(6);
    expect(allSubTypes.length).toBe(19);
  });

  it('every sub-type has exampleActivities populated (full coverage)', () => {
    const missing: string[] = [];
    for (const st of allSubTypes) {
      if (
        !st.exampleActivities ||
        !Array.isArray(st.exampleActivities) ||
        st.exampleActivities.length < 4 ||
        st.exampleActivities.length > 6
      ) {
        missing.push(
          `${st.code} (len=${st.exampleActivities?.length ?? 'undefined'})`,
        );
      }
    }
    expect(missing).toEqual([]);
    // Also assert every sub-type has a defined array (belt + braces).
    for (const st of allSubTypes) {
      expect(st.exampleActivities).toBeDefined();
      expect(Array.isArray(st.exampleActivities)).toBe(true);
      expect(st.exampleActivities!.length).toBeGreaterThanOrEqual(4);
      expect(st.exampleActivities!.length).toBeLessThanOrEqual(6);
    }
  });

  it('every example entry has >= 2 interpuncts (specificity proxy)', () => {
    const failures: string[] = [];
    for (const st of allSubTypes) {
      for (const example of st.exampleActivities ?? []) {
        const interpunctCount = (example.match(/·/g) ?? []).length;
        if (interpunctCount < 2) {
          failures.push(
            `${st.code} "${example.slice(0, 40)}..." has ${interpunctCount} interpunct(s)`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('no example entry exceeds 160 characters', () => {
    const failures: string[] = [];
    for (const st of allSubTypes) {
      for (const example of st.exampleActivities ?? []) {
        if (example.length > 160) {
          failures.push(`${st.code} has ${example.length} chars (> 160)`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('no example entry contains bracket markers [X] (sanitizer safety)', () => {
    const bracketRegex = /\[[A-Z][A-Z0-9_]*\]/;
    const failures: string[] = [];
    for (const st of allSubTypes) {
      for (const example of st.exampleActivities ?? []) {
        if (bracketRegex.test(example)) {
          failures.push(`${st.code}: "${example}"`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('every example entry has minimum length 30 chars (not a stub)', () => {
    const failures: string[] = [];
    for (const st of allSubTypes) {
      for (const example of st.exampleActivities ?? []) {
        if (example.length < 30) {
          failures.push(`${st.code} too short (${example.length}): "${example}"`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('total example entries across all sub-types equals 102 (avg ~5.37)', () => {
    const total = allSubTypes.reduce(
      (acc, st) => acc + (st.exampleActivities?.length ?? 0),
      0,
    );
    expect(total).toBe(102);
  });
});
