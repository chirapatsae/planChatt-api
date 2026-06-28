import * as fs from 'fs';
import * as path from 'path';

/**
 * §17.3 isolation guard for the citizen-engagement module.
 *
 * A pure filesystem spec (it does NOT import the entities — so it never loads
 * encryption.util under jest, project memory: `project_encryption_util_test_env`).
 * It fails the build if any `citizen_*` entity ever gains a FK into a project /
 * users / work_history / tracking_status table — the central invariant of the
 * civic-community production plan (D and §17.2/§17.3).
 */
const ENTITIES_DIR = path.join(__dirname, 'entities');
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
// Auto-cover EVERY citizen migration (M0 init, C2 media, and any future one)
// so a later migration can't silently introduce a forbidden FK.
const CITIZEN_MIGRATIONS = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.ts') && /Citizen/.test(f));
const FORBIDDEN_TABLES = [
  'project_groups',
  'revised_project_groups',
  'supplement_project_groups',
  'equipment_project_groups',
  'tracking_status',
  'work_history',
];

describe('citizen-engagement isolation (§17.3)', () => {
  const entityFiles = fs.readdirSync(ENTITIES_DIR).filter((f) => f.endsWith('.entity.ts'));

  it('has at least the 7 M0 entities', () => {
    expect(entityFiles.length).toBeGreaterThanOrEqual(7);
  });

  describe.each(entityFiles)('%s', (file) => {
    const src = fs.readFileSync(path.join(ENTITIES_DIR, file), 'utf8');

    it('imports only typeorm + sibling citizen entities', () => {
      const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      const offenders = imports.filter((p) => p !== 'typeorm' && !p.startsWith('./citizen-'));
      expect(offenders).toEqual([]);
    });

    it('every @ManyToOne targets a Citizen* entity (no project/user FK)', () => {
      const targets = [...src.matchAll(/@ManyToOne\(\(\)\s*=>\s*(\w+)/g)].map((m) => m[1]);
      targets.forEach((t) => expect(t.startsWith('Citizen')).toBe(true));
    });
  });

  it('has at least the M0 + C2 citizen migrations covered', () => {
    expect(CITIZEN_MIGRATIONS.length).toBeGreaterThanOrEqual(2);
  });

  describe.each(CITIZEN_MIGRATIONS)('migration %s', (file) => {
    it('creates no FK (REFERENCES) into any forbidden table', () => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      expect(/\bREFERENCES\b/i.test(sql)).toBe(false);
      FORBIDDEN_TABLES.forEach((t) => {
        expect(sql.includes(`"${t}"`)).toBe(false);
      });
    });
  });
});
