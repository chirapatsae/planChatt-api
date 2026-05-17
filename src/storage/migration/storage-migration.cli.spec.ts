/**
 * Wave 4 BE-MIGRATION — unit tests for CLI helpers.
 *
 * Scope: pure helpers that do NOT require a Nest container or DataSource
 * (filename prefixing, CLI option parsing, EXDEV-aware move primitive,
 * `rowHasAnyFilePathValue` semantics). The full per-table walk requires
 * a populated DB and is exercised in staging per the umbrella §10
 * acceptance criteria (dry-run + real run + re-run idempotency).
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  parseArgs,
  prefixedBasename,
  moveLegacyToNew,
  buildStrategies,
} from './storage-migration.cli';

describe('storage-migration.cli helpers', () => {
  describe('parseArgs', () => {
    it('defaults', () => {
      const opts = parseArgs(['node', 'cli']);
      expect(opts).toEqual({
        dryRun: false,
        tables: null,
        batchSize: 50,
        bootstrapPlansOnly: false,
      });
    });

    it('--dry-run + --batch-size', () => {
      const opts = parseArgs(['node', 'cli', '--dry-run', '--batch-size=10']);
      expect(opts.dryRun).toBe(true);
      expect(opts.batchSize).toBe(10);
    });

    it('multiple --table values', () => {
      const opts = parseArgs([
        'node',
        'cli',
        '--table=pdf_out_authority_documents',
        '--table=book_assembly_versions',
      ]);
      expect(opts.tables).toEqual([
        'pdf_out_authority_documents',
        'book_assembly_versions',
      ]);
    });

    it('--bootstrap-plans-only', () => {
      const opts = parseArgs(['node', 'cli', '--bootstrap-plans-only']);
      expect(opts.bootstrapPlansOnly).toBe(true);
    });

    it('rejects invalid batch size', () => {
      expect(() => parseArgs(['node', 'cli', '--batch-size=0'])).toThrow();
      expect(() => parseArgs(['node', 'cli', '--batch-size=abc'])).toThrow();
    });

    it('rejects unknown flag', () => {
      expect(() => parseArgs(['node', 'cli', '--what'])).toThrow(
        /Unknown flag/,
      );
    });
  });

  describe('prefixedBasename', () => {
    it('prepends the prefix', () => {
      expect(prefixedBasename('2026-04-18-15-22-v3.pdf', 'draft-agency')).toBe(
        'draft-agency-2026-04-18-15-22-v3.pdf',
      );
    });

    it('is idempotent if already prefixed', () => {
      expect(
        prefixedBasename('draft-agency-2026-04-18-15-22-v3.pdf', 'draft-agency'),
      ).toBe('draft-agency-2026-04-18-15-22-v3.pdf');
    });
  });

  describe('moveLegacyToNew', () => {
    let tmp: string;

    beforeEach(async () => {
      tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'storage-mig-'));
    });

    afterEach(async () => {
      await fsp.rm(tmp, { recursive: true, force: true });
    });

    it('renames within the same volume', async () => {
      const src = path.join(tmp, 'a', 'src.pdf');
      const dst = path.join(tmp, 'b', 'c', 'dst.pdf');
      await fsp.mkdir(path.dirname(src), { recursive: true });
      await fsp.writeFile(src, Buffer.from('payload'));
      await moveLegacyToNew(src, dst);
      expect(fs.existsSync(src)).toBe(false);
      expect(fs.existsSync(dst)).toBe(true);
      const round = await fsp.readFile(dst);
      expect(round.toString()).toBe('payload');
    });

    it('rejects empty src/dst', async () => {
      await expect(moveLegacyToNew('', '/x')).rejects.toThrow();
      await expect(moveLegacyToNew('/x', '')).rejects.toThrow();
    });
  });

  describe('buildStrategies', () => {
    it('registers every BE-SCAN Table 3 entity exactly once', () => {
      const strategies = buildStrategies();
      const names = strategies.map((s) => s.tableName).sort();
      expect(names).toEqual(
        [
          'book_assembly_drafts',
          'book_assembly_versions',
          'pdf_development_plan_approved_documents',
          'pdf_development_plan_draft_agency_documents',
          'pdf_development_plan_draft_coordinate_documents',
          'pdf_out_authority_documents',
          'pdf_revision_change_approved_documents',
          'pdf_revision_change_draft_documents',
          'pdf_revision_edit_approved_documents',
          'pdf_revision_edit_draft_documents',
          'pdf_supplement_approved_documents',
          'pdf_supplement_draft_documents',
          'supplement_assembly_versions',
        ].sort(),
      );
    });
  });
});
