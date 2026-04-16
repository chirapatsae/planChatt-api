import * as fs from 'fs';
import * as path from 'path';

import { STATUS_NAMES, isStatusName, type StatusName } from './status-names';

describe('STATUS_NAMES (backend canonical status-name constants)', () => {
  describe('shape', () => {
    it('is frozen at runtime', () => {
      expect(Object.isFrozen(STATUS_NAMES)).toBe(true);
    });

    it('exposes exactly 7 keys — the canonical Core Status Machine names', () => {
      expect(Object.keys(STATUS_NAMES).sort()).toEqual(
        [
          'APPROVED',
          'PENDING',
          'PENDING_APPROVAL',
          'PULL_BACK',
          'READY',
          'RETURNED_FOR_REVISION',
          'VERIFIED',
        ].sort(),
      );
      expect(Object.keys(STATUS_NAMES)).toHaveLength(7);
    });
  });

  describe('literal values match CLAUDE.md Core Status Machine exactly', () => {
    // Case-sensitive, underscores preserved. These string values MUST match
    // the DB-seeded `status.name` rows exactly — drift here means broken
    // transitions in production.
    it.each([
      ['READY', 'Ready'],
      ['PENDING', 'Pending'],
      ['VERIFIED', 'Verified'],
      ['PENDING_APPROVAL', 'Pending_Approval'],
      ['APPROVED', 'Approved'],
      ['PULL_BACK', 'Pull_Back'],
      ['RETURNED_FOR_REVISION', 'Returned_For_Revision'],
    ] as const)('STATUS_NAMES.%s === %j', (key, expected) => {
      expect(STATUS_NAMES[key as keyof typeof STATUS_NAMES]).toBe(expected);
    });

    it('does NOT contain the RESERVED literal "Revision"', () => {
      // CLAUDE.md Status Naming Constraint: "Revision" collides with the
      // DevelopmentPlanRevision entity name and MUST NOT be used as a
      // status value. Its approved replacement is "Returned_For_Revision".
      expect(Object.values(STATUS_NAMES)).not.toContain('Revision');
    });

    it('uses the exact casing "Returned_For_Revision" (not lowercased variants)', () => {
      expect(STATUS_NAMES.RETURNED_FOR_REVISION).toBe('Returned_For_Revision');
      expect(STATUS_NAMES.RETURNED_FOR_REVISION).not.toBe(
        'returned_for_revision',
      );
      expect(STATUS_NAMES.RETURNED_FOR_REVISION).not.toBe(
        'Returned For Revision',
      );
    });
  });

  describe('isStatusName type-guard', () => {
    it('returns true for every canonical name', () => {
      for (const name of Object.values(STATUS_NAMES)) {
        expect(isStatusName(name)).toBe(true);
      }
    });

    it('returns false for non-canonical strings including the RESERVED "Revision"', () => {
      expect(isStatusName('Revision')).toBe(false);
      expect(isStatusName('')).toBe(false);
      expect(isStatusName('pending')).toBe(false); // wrong case
      expect(isStatusName('Rejected')).toBe(false); // not in canonical set
    });

    it('narrows the string type to StatusName on success', () => {
      const raw: string = 'Pending';
      expect(isStatusName(raw)).toBe(true);
      if (isStatusName(raw)) {
        // compile-time check — `raw` is `StatusName` in this branch
        const narrowed: StatusName = raw;
        expect(narrowed).toBe('Pending');
      }
    });
  });

  describe('migration cross-reference (snapshot against seeded DB rows)', () => {
    // Pin against the canonical status-seed migration(s). If any migration
    // ever inserts a `status.name` value that isn't in STATUS_NAMES, this
    // test fails and surfaces the drift in CI.
    const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

    /**
     * Returns the set of single-quoted ASCII-only literals found in any
     * migration file whose source contains an `INSERT INTO "status"` SQL
     * fragment. The VALUES tuple may contain SQL function calls with their
     * own parens (`gen_random_uuid()`, `NOW()`), so we deliberately skip
     * balanced-paren parsing and instead rely on the fact that status
     * names are the ASCII-only single-quoted literals in these migrations
     * (Thai translations and SQL fragments are filtered out).
     */
    function extractSeededStatusNames(): string[] {
      const seeded: string[] = [];
      const files = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.ts'))
        .map((f) => path.join(MIGRATIONS_DIR, f));

      for (const filePath of files) {
        const src = fs.readFileSync(filePath, 'utf8');
        if (!/INSERT\s+INTO\s+["']?status["']?/i.test(src)) continue;

        // Scan the whole file for single-quoted literals. Filter down to
        // those that look like canonical status names (ASCII, no spaces,
        // capitalized). False-positive ASCII literals (e.g., other SQL
        // strings) are re-checked against the canonical set in the
        // assertion below.
        const literals = Array.from(src.matchAll(/'([^']*)'/g)).map(
          (m) => m[1],
        );
        for (const lit of literals) {
          if (!lit) continue;
          // Skip Thai / non-ASCII translations
          if (/[^\x00-\x7F]/.test(lit)) continue;
          // Skip literals containing whitespace (likely not a status name)
          if (/\s/.test(lit)) continue;
          seeded.push(lit);
        }
      }
      return seeded;
    }

    it('scans the migrations directory and finds at least the known seed', () => {
      const seeded = extractSeededStatusNames();
      expect(seeded).toContain('Returned_For_Revision');
    });

    it('every seeded status name appears in STATUS_NAMES (no drift)', () => {
      const seeded = extractSeededStatusNames();
      const canonical = new Set<string>(Object.values(STATUS_NAMES));

      // Filter to candidates that look like status-name literals. The
      // permissive scan above may grab non-name tokens if future migrations
      // change column order — this test is the contract: whatever we grab,
      // if it walks like a status name (Capitalized_With_Underscores), it
      // MUST be in the canonical set.
      const statusNameShape = /^[A-Z][A-Za-z_]*$/;
      const suspected = seeded.filter((v) => statusNameShape.test(v));

      for (const name of suspected) {
        expect(canonical.has(name)).toBe(true);
      }
    });

    it('no migration seeds the RESERVED literal "Revision"', () => {
      const seeded = extractSeededStatusNames();
      expect(seeded).not.toContain('Revision');
    });
  });
});
