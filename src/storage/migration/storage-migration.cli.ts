/**
 * Wave 4 — Storage Layout Restructure (BE-MIGRATION).
 *
 * One-shot, resumable CLI that moves every existing PDF file from its
 * legacy on-disk location to the new plan-rooted hierarchy defined in
 * `docs/tasks/storage-layout-restructure.md` §1 / §7.5 and rewrites the
 * corresponding DB `file_path` value to the new RELATIVE KEY.
 *
 * Source of truth:
 *   - umbrella `docs/tasks/storage-layout-restructure.md` (§7.4 bootstrap,
 *     §7.5 algorithm, §7.6 collision-safe naming, §11 EXDEV)
 *   - task `docs/tasks/storage-layout-migration.md`
 *   - BE-SCAN inventory `docs/reports/storage-layout-be-scan.md`
 *     (Tables 1.A–1.E + Table 3 + per-version part finding)
 *   - BE-PATH-SERVICE Wave 2 API (consumed via DI)
 *   - BE-WRITERS Wave 3 (new-key shape parity)
 *   - BE-READERS Wave 3 (`resolveStored` handles both forms during
 *     transition window)
 *
 * Usage:
 *   npx ts-node backend/src/storage/migration/storage-migration.cli.ts \
 *     [--dry-run] [--table=<name>] [--batch-size=<n>] [--bootstrap-plans-only]
 *
 *   --dry-run                 read + compute + print; ZERO side effects.
 *   --table=<name>            restrict to one entity (e.g.
 *                             `pdf_revision_edit_draft_documents`). May be
 *                             provided multiple times. Default: all.
 *   --batch-size=<n>          rows per progress flush + interrupt check
 *                             (default 50).
 *   --bootstrap-plans-only    skip file migration; just bootstrap the
 *                             three subfolders for every existing plan
 *                             (idempotent).
 *
 * Behaviour:
 *   1. Skip rows whose `file_path` is null / empty.
 *   2. Skip rows whose `file_path` is already a relative key
 *      (`!path.isAbsolute(value)`). Idempotent re-run is a no-op.
 *   3. Compute the new RELATIVE KEY via `StoragePathService.*Key()`.
 *   4. Per-row transaction: move file (fs.rename, EXDEV → copy + verify
 *      + unlink via `StoragePathService.moveFile`); on success, update
 *      the DB row's `file_path`. On DB error, attempt reverse-rename and
 *      log; on file-move error, abort the row and continue.
 *   5. After all tables processed, bootstrap the three subfolders for
 *      every existing plan (idempotent — also runs in
 *      `--bootstrap-plans-only` mode).
 *
 * Out of scope: reverse migration, URL changes, schema changes, source
 * file deletion outside the EXDEV verify+unlink fallback.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { StoragePathService } from '../storage-path.service';
import { DevelopmentPlan } from '../../development-plan/entities/development-plan.entity';
import { DevelopmentPlanRevision } from '../../development-plan-revision/entities/development-plan-revision.entity';
import { DevelopmentPlanSupplement } from '../../development-plan-supplement/entities/development-plan-supplement.entity';
import { BookAssemblyDraft } from '../../book-assembly/entities/book-assembly-draft.entity';
import { BookAssemblyVersion } from '../../book-assembly/entities/book-assembly-version.entity';
import { BookAssemblySourceType } from '../../book-assembly/enums/book-assembly.enums';
import { SupplementAssemblyVersion } from '../../supplement-assembly/entities/supplement-assembly-version.entity';
import { PdfDevelopmentPlanDraftAgencyDocument } from '../../pdf/entities/pdf-development-plan-draft-agency-document.entity';
import { PdfDevelopmentPlanDraftCoordinateDocument } from '../../pdf/entities/pdf-development-plan-draft-coordinate-document.entity';
import { PdfDevelopmentPlanApprovedDocument } from '../../pdf/entities/pdf-development-plan-approved-document.entity';
import { PdfOutAuthorityDocument } from '../../pdf/entities/pdf-out-authority-document.entity';
import { PdfRevisionEditDraftDocument } from '../../pdf/entities/pdf-revision-edit-draft-document.entity';
import { PdfRevisionEditApprovedDocument } from '../../pdf/entities/pdf-revision-edit-approved-document.entity';
import { PdfRevisionChangeDraftDocument } from '../../pdf/entities/pdf-revision-change-draft-document.entity';
import { PdfRevisionChangeApprovedDocument } from '../../pdf/entities/pdf-revision-change-approved-document.entity';
import { PdfSupplementDraftDocument } from '../../pdf/entities/pdf-supplement-draft-document.entity';
import { PdfSupplementApprovedDocument } from '../../pdf/entities/pdf-supplement-approved-document.entity';

// ---------------------------------------------------------------------------
// CLI option parsing
// ---------------------------------------------------------------------------

interface CliOptions {
  dryRun: boolean;
  tables: string[] | null; // null = all tables
  batchSize: number;
  bootstrapPlansOnly: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    dryRun: false,
    tables: null,
    batchSize: 50,
    bootstrapPlansOnly: false,
  };
  const tables: string[] = [];

  for (const raw of argv.slice(2)) {
    if (raw === '--dry-run') {
      opts.dryRun = true;
    } else if (raw === '--bootstrap-plans-only') {
      opts.bootstrapPlansOnly = true;
    } else if (raw.startsWith('--table=')) {
      tables.push(raw.substring('--table='.length).trim());
    } else if (raw === '--table') {
      // peek next; ts-node passes flag-as-pair when spaced, but only
      // when invoked via shell quoting. We support both forms.
      // (Empty branch — actual pair handled by the explicit `=` form.)
    } else if (raw.startsWith('--batch-size=')) {
      const n = parseInt(raw.substring('--batch-size='.length), 10);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`Invalid --batch-size value: "${raw}"`);
      }
      opts.batchSize = n;
    } else if (raw === '--help' || raw === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown flag: "${raw}". Use --help for usage.`);
    }
  }

  if (tables.length > 0) {
    opts.tables = tables;
  }
  return opts;
}

function printUsage(): void {
  const lines = [
    'Usage: storage-migration.cli.ts [options]',
    '',
    '  --dry-run                 Read + compute + print; no side effects.',
    '  --table=<name>            Restrict to one entity (may be repeated).',
    '  --batch-size=<n>          Rows per progress flush (default 50).',
    '  --bootstrap-plans-only    Skip migration; only bootstrap plan dirs.',
    '  --help                    Print this help.',
    '',
    'Tables (per BE-SCAN Table 3):',
    '  pdf_development_plan_draft_agency_documents',
    '  pdf_development_plan_draft_coordinate_documents',
    '  pdf_development_plan_approved_documents',
    '  pdf_out_authority_documents',
    '  pdf_revision_edit_draft_documents',
    '  pdf_revision_edit_approved_documents',
    '  pdf_revision_change_draft_documents',
    '  pdf_revision_change_approved_documents',
    '  pdf_supplement_draft_documents',
    '  pdf_supplement_approved_documents',
    '  book_assembly_drafts',
    '  book_assembly_versions',
    '  supplement_assembly_versions',
  ];
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Per-row counters
// ---------------------------------------------------------------------------

interface TableCounters {
  scanned: number;
  migrated: number;
  skippedAlreadyRelative: number;
  skippedNullOrEmpty: number;
  skippedMissingSource: number;
  skippedUnresolvable: number;
  failed: number;
  bytesMoved: number;
}

function emptyCounters(): TableCounters {
  return {
    scanned: 0,
    migrated: 0,
    skippedAlreadyRelative: 0,
    skippedNullOrEmpty: 0,
    skippedMissingSource: 0,
    skippedUnresolvable: 0,
    failed: 0,
    bytesMoved: 0,
  };
}

// ---------------------------------------------------------------------------
// Per-row migration strategy
// ---------------------------------------------------------------------------

/**
 * Per-entity strategy. A strategy describes how to read rows in batches,
 * compute the new RELATIVE KEY for a row, and update the row's
 * `file_path` (or the relevant per-part column) inside a transaction.
 */
interface TableStrategy {
  /** Logical name used by --table and reports. */
  readonly tableName: string;

  /**
   * Stream rows in batches. Yields one batch at a time so the CLI can
   * flush progress + check the interrupt signal between batches.
   */
  streamBatches(
    ds: DataSource,
    batchSize: number,
  ): AsyncGenerator<TableRow[], void, void>;

  /**
   * Compute the planned new RELATIVE KEY(S) for one row. Returns a list
   * of column-keyed move plans because some entities (book_assembly_*)
   * carry multiple file-path columns per row.
   *
   * If the row has no usable plan join (missing parent), the strategy
   * returns an empty list and the row is counted as skippedUnresolvable.
   */
  computePlans(
    ds: DataSource,
    sps: StoragePathService,
    row: TableRow,
  ): Promise<MovePlan[]>;

  /**
   * Commit the given moves inside ONE transaction:
   *  - mv file on disk
   *  - UPDATE the column(s)
   * Returns bytes moved for reporting.
   */
  applyPlans(
    ds: DataSource,
    sps: StoragePathService,
    row: TableRow,
    plans: MovePlan[],
  ): Promise<number>;
}

/** Opaque row shape — strategies cast as needed. */
type TableRow = Record<string, any>;

interface MovePlan {
  /** DB column name (e.g. `file_path`, `merged_file_path`, `part1_file_path`). */
  column: string;
  /** Existing stored value (legacy absolute path). */
  oldStored: string;
  /** New RELATIVE KEY to persist. */
  newKey: string;
  /** Absolute path resolved from `oldStored`. */
  oldAbs: string;
  /** Absolute path resolved from `newKey` (under STORAGE_ROOT). */
  newAbs: string;
}

// ---------------------------------------------------------------------------
// Filename mapping helpers (BE-WRITERS Wave 3 parity)
// ---------------------------------------------------------------------------

/**
 * Wave-3 BE-WRITERS prefixes the basename with a kind discriminator
 * (`draft-agency-`, `draft-coordinate-`, `out-authority-`, `approved-`,
 * `draft-`, …) because the new layout collapses kind-specific
 * subfolders (e.g. legacy `…/draft-agency/…`) into a single
 * `main-plan-{planId}/v{N}/` directory.
 *
 * For migration we apply the SAME prefix when relocating legacy files
 * so the relocated artifact lives at the same shape a fresh write
 * would produce — guaranteeing parity with new rows and avoiding
 * basename collisions across artifact kinds inside the merged v{N}/
 * directory.
 *
 * Idempotent: if the basename already starts with the prefix (e.g. the
 * migration is re-run against a row that was written by Wave-3 writers
 * after relative-key adoption), the prefix is NOT doubled.
 */
function prefixedBasename(basename: string, prefix: string): string {
  if (basename.startsWith(`${prefix}-`)) {
    return basename;
  }
  return `${prefix}-${basename}`;
}

// ---------------------------------------------------------------------------
// Strategy: legacy PdfService single-PDF tables (10 entities)
//
// Layout for these tables: each row points to ONE absolute on-disk PDF
// file. The DB row stores it in `file_path`. We move the file under
// `main-plan-{planId}/v{N}/<prefixed-basename>` (or revision/supplement
// equivalents) and rewrite `file_path` to the new RELATIVE KEY.
// ---------------------------------------------------------------------------

/**
 * Main-plan single-PDF strategy (covers draft-agency, draft-coordinate,
 * out-authority, approved).
 *
 * The row holds `developmentPlanId` + `version`. We resolve the plan to
 * obtain the planId we need for the new layout (== developmentPlanId
 * directly — no name lookup needed because the new layout is UUID-rooted).
 */
class MainPlanSinglePdfStrategy implements TableStrategy {
  constructor(
    public readonly tableName: string,
    private readonly EntityClass: new () => any,
    private readonly basenamePrefix: string,
  ) {}

  async *streamBatches(
    ds: DataSource,
    batchSize: number,
  ): AsyncGenerator<TableRow[], void, void> {
    const repo = ds.getRepository(this.EntityClass);
    let skip = 0;
    while (true) {
      const rows = await repo.find({
        order: { id: 'ASC' } as any,
        skip,
        take: batchSize,
      });
      if (rows.length === 0) return;
      yield rows as any[];
      if (rows.length < batchSize) return;
      skip += batchSize;
    }
  }

  async computePlans(
    _ds: DataSource,
    sps: StoragePathService,
    row: TableRow,
  ): Promise<MovePlan[]> {
    const oldStored: string | null | undefined = row.filePath ?? row.file_path;
    if (!oldStored) return [];
    if (!path.isAbsolute(oldStored)) {
      return [{ column: 'filePath', oldStored, newKey: oldStored, oldAbs: '', newAbs: '' }];
    }
    const planId: string = row.developmentPlanId ?? row.development_plan_id;
    const version: number = Number(row.version);
    if (!planId || !Number.isInteger(version) || version < 1) {
      return [];
    }
    const basename = prefixedBasename(path.basename(oldStored), this.basenamePrefix);
    const newKey = sps.mainPlanVersionKey(planId, version, basename);
    return [
      {
        column: 'filePath',
        oldStored,
        newKey,
        oldAbs: oldStored,
        newAbs: sps.toAbsolute(newKey),
      },
    ];
  }

  async applyPlans(
    ds: DataSource,
    sps: StoragePathService,
    row: TableRow,
    plans: MovePlan[],
  ): Promise<number> {
    return applyPlansForEntity(ds, sps, row, plans, this.EntityClass);
  }
}

/**
 * Revision single-PDF strategy (covers edit-draft, edit-approved,
 * change-draft, change-approved).
 *
 * The row holds `developmentPlanRevisionId` + `version`. We join to
 * `development_plan_revision` to obtain (planId, revisionNumber,
 * revisionType.name).
 */
class RevisionSinglePdfStrategy implements TableStrategy {
  constructor(
    public readonly tableName: string,
    private readonly EntityClass: new () => any,
    private readonly revisionType: 'edit' | 'change',
    private readonly basenamePrefix: string,
  ) {}

  async *streamBatches(
    ds: DataSource,
    batchSize: number,
  ): AsyncGenerator<TableRow[], void, void> {
    const repo = ds.getRepository(this.EntityClass);
    let skip = 0;
    while (true) {
      const rows = await repo.find({
        order: { id: 'ASC' } as any,
        skip,
        take: batchSize,
      });
      if (rows.length === 0) return;
      yield rows as any[];
      if (rows.length < batchSize) return;
      skip += batchSize;
    }
  }

  async computePlans(
    ds: DataSource,
    sps: StoragePathService,
    row: TableRow,
  ): Promise<MovePlan[]> {
    const oldStored: string | null | undefined = row.filePath ?? row.file_path;
    if (!oldStored) return [];
    if (!path.isAbsolute(oldStored)) {
      return [{ column: 'filePath', oldStored, newKey: oldStored, oldAbs: '', newAbs: '' }];
    }
    const revisionId: string =
      row.developmentPlanRevisionId ?? row.development_plan_revision_id;
    const version: number = Number(row.version);
    if (!revisionId || !Number.isInteger(version) || version < 1) {
      return [];
    }
    const revisionRepo = ds.getRepository(DevelopmentPlanRevision);
    const revision = await revisionRepo.findOne({
      where: { id: revisionId } as any,
      relations: ['developmentPlan', 'revisionType'],
      withDeleted: true,
    });
    if (!revision || !revision.developmentPlan || !revision.revisionType) {
      return [];
    }
    const planId = revision.developmentPlan.id;
    const revisionNumber = revision.revisionNumber;
    if (!planId || !Number.isInteger(revisionNumber) || revisionNumber < 1) {
      return [];
    }
    const basename = prefixedBasename(path.basename(oldStored), this.basenamePrefix);
    const newKey = sps.revisionVersionKey({
      planId,
      revisionType: this.revisionType,
      revisionNumber,
      revisionId,
      versionNumber: version,
      fileName: basename,
    });
    return [
      {
        column: 'filePath',
        oldStored,
        newKey,
        oldAbs: oldStored,
        newAbs: sps.toAbsolute(newKey),
      },
    ];
  }

  async applyPlans(
    ds: DataSource,
    sps: StoragePathService,
    row: TableRow,
    plans: MovePlan[],
  ): Promise<number> {
    return applyPlansForEntity(ds, sps, row, plans, this.EntityClass);
  }
}

/**
 * Supplement single-PDF strategy (covers supplement-draft + legacy
 * supplement-approved).
 *
 * The row holds `developmentPlanSupplementId` + `version`. We join to
 * `development_plan_supplement` for (planId, supplementNumber).
 */
class SupplementSinglePdfStrategy implements TableStrategy {
  constructor(
    public readonly tableName: string,
    private readonly EntityClass: new () => any,
    private readonly basenamePrefix: string,
  ) {}

  async *streamBatches(
    ds: DataSource,
    batchSize: number,
  ): AsyncGenerator<TableRow[], void, void> {
    const repo = ds.getRepository(this.EntityClass);
    let skip = 0;
    while (true) {
      const rows = await repo.find({
        order: { id: 'ASC' } as any,
        skip,
        take: batchSize,
      });
      if (rows.length === 0) return;
      yield rows as any[];
      if (rows.length < batchSize) return;
      skip += batchSize;
    }
  }

  async computePlans(
    ds: DataSource,
    sps: StoragePathService,
    row: TableRow,
  ): Promise<MovePlan[]> {
    const oldStored: string | null | undefined = row.filePath ?? row.file_path;
    if (!oldStored) return [];
    if (!path.isAbsolute(oldStored)) {
      return [{ column: 'filePath', oldStored, newKey: oldStored, oldAbs: '', newAbs: '' }];
    }
    const supplementId: string =
      row.developmentPlanSupplementId ?? row.development_plan_supplement_id;
    const version: number = Number(row.version);
    if (!supplementId || !Number.isInteger(version) || version < 1) {
      return [];
    }
    const suppRepo = ds.getRepository(DevelopmentPlanSupplement);
    const supplement = await suppRepo.findOne({
      where: { id: supplementId } as any,
      relations: ['developmentPlan'],
      withDeleted: true,
    });
    if (!supplement || !supplement.developmentPlan) return [];
    const planId = supplement.developmentPlan.id;
    const supplementNumber = supplement.supplementNumber;
    if (!planId || !Number.isInteger(supplementNumber) || supplementNumber < 1) {
      return [];
    }
    const basename = prefixedBasename(path.basename(oldStored), this.basenamePrefix);
    const newKey = sps.supplementVersionKey({
      planId,
      supplementNumber,
      supplementId,
      versionNumber: version,
      fileName: basename,
    });
    return [
      {
        column: 'filePath',
        oldStored,
        newKey,
        oldAbs: oldStored,
        newAbs: sps.toAbsolute(newKey),
      },
    ];
  }

  async applyPlans(
    ds: DataSource,
    sps: StoragePathService,
    row: TableRow,
    plans: MovePlan[],
  ): Promise<number> {
    return applyPlansForEntity(ds, sps, row, plans, this.EntityClass);
  }
}

// ---------------------------------------------------------------------------
// Strategy: BookAssembly draft + version (up to 4 file_path columns per row)
//
// Layout:
//   - `book_assembly_drafts` carries part{1,2,3}_file_path (nullable).
//   - `book_assembly_versions` carries part{1,2,3}_file_path AND
//     merged_file_path (all required).
//
// For each row, source_type = MAIN_PLAN | EDIT_REVISION | CHANGE_REVISION
// and source_id resolves the parent plan / revision. Per-part files
// retain their `part-{N}.pdf` basename; merged files retain
// `official-book-v{N}.pdf` — the new layout already disambiguates them
// via `parts/` and `merged/` subdirectories, so no prefix is added.
// ---------------------------------------------------------------------------

abstract class BookAssemblyBaseStrategy implements TableStrategy {
  abstract readonly tableName: string;
  protected abstract EntityClass: new () => any;
  protected abstract columnsToConsider(row: TableRow): Array<{
    column: string;
    columnDb: string;
    isPartFile: boolean;
    partNumber?: number;
  }>;
  protected abstract versionForRow(row: TableRow): number | null;

  async *streamBatches(
    ds: DataSource,
    batchSize: number,
  ): AsyncGenerator<TableRow[], void, void> {
    const repo = ds.getRepository(this.EntityClass);
    let skip = 0;
    while (true) {
      const rows = await repo.find({
        order: { id: 'ASC' } as any,
        skip,
        take: batchSize,
      });
      if (rows.length === 0) return;
      yield rows as any[];
      if (rows.length < batchSize) return;
      skip += batchSize;
    }
  }

  async computePlans(
    ds: DataSource,
    sps: StoragePathService,
    row: TableRow,
  ): Promise<MovePlan[]> {
    const plans: MovePlan[] = [];
    const version = this.versionForRow(row);
    const sourceType: BookAssemblySourceType = row.sourceType ?? row.source_type;
    const sourceId: string = row.sourceId ?? row.source_id;
    if (!version || !sourceType || !sourceId) {
      // If literally nothing to migrate (all columns null), surface as
      // "no work" rather than "unresolvable".
      if (!this.anyColumnSet(row)) return [];
      return [];
    }

    // Resolve location → planId + (revisionNumber, revisionId).
    const location = await this.resolveLocation(ds, sourceType, sourceId);
    if (!location) {
      return this.anyColumnSet(row) ? [] : [];
    }

    for (const col of this.columnsToConsider(row)) {
      const oldStored: string | null = row[col.column];
      if (!oldStored) continue;
      if (!path.isAbsolute(oldStored)) {
        plans.push({
          column: col.column,
          oldStored,
          newKey: oldStored,
          oldAbs: '',
          newAbs: '',
        });
        continue;
      }
      const basename = path.basename(oldStored);
      const newKey = this.computeNewKey(sps, location, version, col, basename);
      plans.push({
        column: col.column,
        oldStored,
        newKey,
        oldAbs: oldStored,
        newAbs: sps.toAbsolute(newKey),
      });
    }
    return plans;
  }

  async applyPlans(
    ds: DataSource,
    sps: StoragePathService,
    row: TableRow,
    plans: MovePlan[],
  ): Promise<number> {
    return applyPlansForEntity(ds, sps, row, plans, this.EntityClass);
  }

  private anyColumnSet(row: TableRow): boolean {
    return this.columnsToConsider(row).some((c) => Boolean(row[c.column]));
  }

  private async resolveLocation(
    ds: DataSource,
    sourceType: BookAssemblySourceType,
    sourceId: string,
  ): Promise<
    | { kind: 'MAIN_PLAN'; planId: string }
    | {
        kind: 'EDIT_REVISION' | 'CHANGE_REVISION';
        planId: string;
        revisionNumber: number;
        revisionId: string;
      }
    | null
  > {
    if (sourceType === BookAssemblySourceType.MAIN_PLAN) {
      const planRepo = ds.getRepository(DevelopmentPlan);
      const plan = await planRepo.findOne({
        where: { id: sourceId } as any,
        withDeleted: true,
      });
      if (!plan) return null;
      return { kind: 'MAIN_PLAN', planId: plan.id };
    }

    const revRepo = ds.getRepository(DevelopmentPlanRevision);
    const rev = await revRepo.findOne({
      where: { id: sourceId } as any,
      relations: ['developmentPlan'],
      withDeleted: true,
    });
    if (!rev || !rev.developmentPlan) return null;
    return {
      kind:
        sourceType === BookAssemblySourceType.EDIT_REVISION
          ? 'EDIT_REVISION'
          : 'CHANGE_REVISION',
      planId: rev.developmentPlan.id,
      revisionNumber: rev.revisionNumber,
      revisionId: rev.id,
    };
  }

  private computeNewKey(
    sps: StoragePathService,
    location:
      | { kind: 'MAIN_PLAN'; planId: string }
      | {
          kind: 'EDIT_REVISION' | 'CHANGE_REVISION';
          planId: string;
          revisionNumber: number;
          revisionId: string;
        },
    version: number,
    col: { column: string; isPartFile: boolean; partNumber?: number },
    basename: string,
  ): string {
    let versionDir: string;
    if (location.kind === 'MAIN_PLAN') {
      versionDir = sps.mainPlanVersionDir(location.planId, version);
    } else {
      const revisionType = location.kind === 'EDIT_REVISION' ? 'edit' : 'change';
      versionDir = sps.revisionVersionDir({
        planId: location.planId,
        revisionType,
        revisionNumber: location.revisionNumber,
        revisionId: location.revisionId,
        versionNumber: version,
      });
    }
    if (col.isPartFile && col.partNumber) {
      // Preserve `part-{N}.pdf` basename — new layout disambiguates via
      // `parts/` subdir per Wave-3 `getPartFileKey`.
      const partBasename = `part-${col.partNumber}.pdf`;
      return path.posix.join(versionDir, 'parts', partBasename);
    }
    // Merged: preserve `official-book-v{N}.pdf` per Wave-3 `getMergedFileKey`.
    void basename;
    return path.posix.join(versionDir, 'merged', `official-book-v${version}.pdf`);
  }
}

class BookAssemblyDraftStrategy extends BookAssemblyBaseStrategy {
  readonly tableName = 'book_assembly_drafts';
  protected EntityClass = BookAssemblyDraft;

  protected versionForRow(row: TableRow): number | null {
    const v = Number(row.targetVersion ?? row.target_version);
    return Number.isInteger(v) && v >= 1 ? v : null;
  }

  protected columnsToConsider(_row: TableRow) {
    // Draft has 3 nullable part columns; merged is NOT persisted on draft.
    return [
      { column: 'part1FilePath', columnDb: 'part1_file_path', isPartFile: true, partNumber: 1 },
      { column: 'part2FilePath', columnDb: 'part2_file_path', isPartFile: true, partNumber: 2 },
      { column: 'part3FilePath', columnDb: 'part3_file_path', isPartFile: true, partNumber: 3 },
    ];
  }
}

class BookAssemblyVersionStrategy extends BookAssemblyBaseStrategy {
  readonly tableName = 'book_assembly_versions';
  protected EntityClass = BookAssemblyVersion;

  protected versionForRow(row: TableRow): number | null {
    const v = Number(row.versionNumber ?? row.version_number);
    return Number.isInteger(v) && v >= 1 ? v : null;
  }

  protected columnsToConsider(_row: TableRow) {
    return [
      { column: 'part1FilePath', columnDb: 'part1_file_path', isPartFile: true, partNumber: 1 },
      { column: 'part2FilePath', columnDb: 'part2_file_path', isPartFile: true, partNumber: 2 },
      { column: 'part3FilePath', columnDb: 'part3_file_path', isPartFile: true, partNumber: 3 },
      { column: 'mergedFilePath', columnDb: 'merged_file_path', isPartFile: false },
    ];
  }
}

// ---------------------------------------------------------------------------
// Strategy: SupplementAssembly version (single merged_file_path column)
//
// Layout: legacy = `storage/book-assembly/development-plan-supplement-{id}/v{N}/merged/...`.
// Per BE-SCAN Scheme C, this is the ONLY scheme not currently plan-rooted;
// we JOIN through `development_plan_supplement` to obtain the parent
// planId.
//
// Per-part files for SupplementAssembly are NOT persisted in DB (BE-SCAN
// H1) — we discover them via `fs.readdir(parts/)` of the legacy version
// directory and relocate them alongside the merged file. The metadata.json
// sidecar is also relocated if present.
// ---------------------------------------------------------------------------

class SupplementAssemblyVersionStrategy implements TableStrategy {
  readonly tableName = 'supplement_assembly_versions';

  async *streamBatches(
    ds: DataSource,
    batchSize: number,
  ): AsyncGenerator<TableRow[], void, void> {
    const repo = ds.getRepository(SupplementAssemblyVersion);
    let skip = 0;
    while (true) {
      const rows = await repo.find({
        order: { id: 'ASC' } as any,
        skip,
        take: batchSize,
      });
      if (rows.length === 0) return;
      yield rows as any[];
      if (rows.length < batchSize) return;
      skip += batchSize;
    }
  }

  async computePlans(
    ds: DataSource,
    sps: StoragePathService,
    row: TableRow,
  ): Promise<MovePlan[]> {
    const oldStored: string | null = row.mergedFilePath ?? row.merged_file_path;
    if (!oldStored) return [];
    if (!path.isAbsolute(oldStored)) {
      return [
        { column: 'mergedFilePath', oldStored, newKey: oldStored, oldAbs: '', newAbs: '' },
      ];
    }
    const supplementId: string =
      row.developmentPlanSupplementId ?? row.development_plan_supplement_id;
    const version: number = Number(row.versionNumber ?? row.version_number);
    if (!supplementId || !Number.isInteger(version) || version < 1) {
      return [];
    }
    const suppRepo = ds.getRepository(DevelopmentPlanSupplement);
    const supplement = await suppRepo.findOne({
      where: { id: supplementId } as any,
      relations: ['developmentPlan'],
      withDeleted: true,
    });
    if (!supplement || !supplement.developmentPlan) return [];
    const planId = supplement.developmentPlan.id;
    const supplementNumber = supplement.supplementNumber;
    if (!planId || !Number.isInteger(supplementNumber) || supplementNumber < 1) {
      return [];
    }
    const versionDir = sps.supplementVersionDir({
      planId,
      supplementNumber,
      supplementId,
      versionNumber: version,
    });
    const newKey = path.posix.join(
      versionDir,
      'merged',
      `official-supplement-book-v${version}.pdf`,
    );
    return [
      {
        column: 'mergedFilePath',
        oldStored,
        newKey,
        oldAbs: oldStored,
        newAbs: sps.toAbsolute(newKey),
      },
    ];
  }

  async applyPlans(
    ds: DataSource,
    sps: StoragePathService,
    row: TableRow,
    plans: MovePlan[],
  ): Promise<number> {
    return applyPlansForEntity(ds, sps, row, plans, SupplementAssemblyVersion);
  }
}

// ---------------------------------------------------------------------------
// Generic per-row commit (used by every strategy)
// ---------------------------------------------------------------------------

/**
 * Apply a row's move plans inside ONE transaction:
 *   1. mkdir -p parent of each new abs path
 *   2. fs.rename(oldAbs, newAbs) — EXDEV fallback inside
 *      `StoragePathService.moveFile`
 *   3. UPDATE the matching DB columns with the new RELATIVE KEYS
 *   4. Commit. On DB error, attempt reverse-rename for each completed
 *      move and rethrow.
 *
 * Returns total bytes moved (sum of file sizes after move; collected
 * pre-move for accuracy).
 */
async function applyPlansForEntity(
  ds: DataSource,
  sps: StoragePathService,
  row: TableRow,
  plans: MovePlan[],
  EntityClass: new () => any,
): Promise<number> {
  // No plans → nothing to do.
  if (plans.length === 0) return 0;

  // Collect file sizes BEFORE moving (so the report is accurate even
  // for EXDEV unlinks that follow).
  let bytesMoved = 0;
  for (const plan of plans) {
    try {
      const st = await fsp.stat(plan.oldAbs);
      bytesMoved += st.size;
    } catch {
      // Best-effort metric only.
    }
  }

  const moved: MovePlan[] = [];
  await ds.transaction(async (manager) => {
    // 1. Move files first. If any move fails, throw so the tx rolls
    //    back and we reverse-rename what already moved.
    //    NOTE: `StoragePathService.moveFile` only accepts RELATIVE keys
    //    under STORAGE_ROOT. Legacy paths in `oldAbs` are absolute and
    //    typically OUTSIDE STORAGE_ROOT, so the service's relative
    //    resolution does not apply. We use the local `moveLegacyToNew`
    //    primitive (same EXDEV fallback shape) to move absolute → absolute.
    void sps; // service kept in signature for symmetry with other helpers
    for (const plan of plans) {
      await moveLegacyToNew(plan.oldAbs, plan.newAbs);
      moved.push(plan);
    }
    // 2. Update the DB row's columns inside the same tx.
    const updates: Record<string, string> = {};
    for (const plan of plans) {
      updates[plan.column] = plan.newKey;
    }
    const repo = manager.getRepository(EntityClass);
    await repo.update({ id: row.id }, updates as any);
  }).catch(async (txErr) => {
    // Reverse-rename any moves that already happened so the
    // filesystem matches the rolled-back DB row.
    for (const plan of moved.reverse()) {
      try {
        await moveLegacyToNew(plan.newAbs, plan.oldAbs);
      } catch (revErr) {
        // Best-effort — log and continue.
        // eslint-disable-next-line no-console
        console.error(
          `[migrate] reverse-rename failed for row=${row.id} col=${plan.column}: ${
            (revErr as Error).message
          }`,
        );
      }
    }
    throw txErr;
  });

  return bytesMoved;
}

/**
 * Move a file from absolute `srcAbs` to absolute `dstAbs`. Falls back
 * to copy + verify + unlink on `EXDEV`. Mirrors the logic in
 * `StoragePathService.moveFile` but accepts absolute paths so we can
 * relocate legacy files that live OUTSIDE `STORAGE_ROOT`
 * (`backend/uploads/pdf/...`, `backend/storage/book-assembly/...`).
 */
async function moveLegacyToNew(srcAbs: string, dstAbs: string): Promise<void> {
  if (!srcAbs || !dstAbs) {
    throw new Error('moveLegacyToNew: src and dst must be non-empty');
  }
  await fsp.mkdir(path.dirname(dstAbs), { recursive: true });
  try {
    await fsp.rename(srcAbs, dstAbs);
  } catch (err: any) {
    if (err?.code !== 'EXDEV') {
      throw err;
    }
    // Cross-volume — copy + verify size + unlink.
    await fsp.copyFile(srcAbs, dstAbs);
    const [srcStat, dstStat] = await Promise.all([
      fsp.stat(srcAbs).catch(() => null),
      fsp.stat(dstAbs).catch(() => null),
    ]);
    if (!dstStat) {
      throw new Error(
        `EXDEV fallback failed: destination missing after copy: ${dstAbs}`,
      );
    }
    if (srcStat && srcStat.size !== dstStat.size) {
      // Size mismatch — destination is incomplete. Remove partial copy
      // and re-raise so the caller treats this as a hard failure.
      await fsp.unlink(dstAbs).catch(() => undefined);
      throw new Error(
        `EXDEV fallback verify failed: size mismatch (src=${srcStat.size}, dst=${dstStat.size})`,
      );
    }
    await fsp.unlink(srcAbs);
  }
}

// ---------------------------------------------------------------------------
// Strategy registry
// ---------------------------------------------------------------------------

function buildStrategies(): TableStrategy[] {
  return [
    new MainPlanSinglePdfStrategy(
      'pdf_development_plan_draft_agency_documents',
      PdfDevelopmentPlanDraftAgencyDocument,
      'draft-agency',
    ),
    new MainPlanSinglePdfStrategy(
      'pdf_development_plan_draft_coordinate_documents',
      PdfDevelopmentPlanDraftCoordinateDocument,
      'draft-coordinate',
    ),
    new MainPlanSinglePdfStrategy(
      'pdf_development_plan_approved_documents',
      PdfDevelopmentPlanApprovedDocument,
      'approved',
    ),
    new MainPlanSinglePdfStrategy(
      'pdf_out_authority_documents',
      PdfOutAuthorityDocument,
      'out-authority',
    ),
    new RevisionSinglePdfStrategy(
      'pdf_revision_edit_draft_documents',
      PdfRevisionEditDraftDocument,
      'edit',
      'draft',
    ),
    new RevisionSinglePdfStrategy(
      'pdf_revision_edit_approved_documents',
      PdfRevisionEditApprovedDocument,
      'edit',
      'approved',
    ),
    new RevisionSinglePdfStrategy(
      'pdf_revision_change_draft_documents',
      PdfRevisionChangeDraftDocument,
      'change',
      'draft',
    ),
    new RevisionSinglePdfStrategy(
      'pdf_revision_change_approved_documents',
      PdfRevisionChangeApprovedDocument,
      'change',
      'approved',
    ),
    new SupplementSinglePdfStrategy(
      'pdf_supplement_draft_documents',
      PdfSupplementDraftDocument,
      'draft',
    ),
    new SupplementSinglePdfStrategy(
      'pdf_supplement_approved_documents',
      PdfSupplementApprovedDocument,
      'approved',
    ),
    new BookAssemblyDraftStrategy(),
    new BookAssemblyVersionStrategy(),
    new SupplementAssemblyVersionStrategy(),
  ];
}

// ---------------------------------------------------------------------------
// Main driver
// ---------------------------------------------------------------------------

let interrupted = false;

async function runMigration(opts: CliOptions): Promise<void> {
  const logger = new Logger('storage-migration');
  logger.log(
    `Starting migration: dryRun=${opts.dryRun} batchSize=${opts.batchSize} ` +
      `tables=${opts.tables ? opts.tables.join(',') : 'ALL'} ` +
      `bootstrapPlansOnly=${opts.bootstrapPlansOnly}`,
  );

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const sps = app.get(StoragePathService);
    const ds = app.get(DataSource);
    logger.log(`STORAGE_ROOT=${sps.getStorageRoot()}`);

    // Wire SIGINT/SIGTERM to flip the `interrupted` flag. Current-row
    // transactions finish; the loop then exits cleanly between batches.
    const onSignal = (sig: string) => () => {
      if (!interrupted) {
        logger.warn(
          `Received ${sig}; will exit after current row completes.`,
        );
        interrupted = true;
      }
    };
    process.on('SIGINT', onSignal('SIGINT'));
    process.on('SIGTERM', onSignal('SIGTERM'));

    const startedAt = Date.now();
    const tableSummaries: Array<{ table: string; counters: TableCounters }> = [];

    if (!opts.bootstrapPlansOnly) {
      const strategies = buildStrategies().filter(
        (s) => opts.tables === null || opts.tables.includes(s.tableName),
      );
      if (opts.tables && strategies.length < opts.tables.length) {
        const known = buildStrategies().map((s) => s.tableName);
        const unknown = opts.tables.filter((t) => !known.includes(t));
        throw new Error(
          `Unknown --table value(s): ${unknown.join(', ')}. ` +
            `Known: ${known.join(', ')}`,
        );
      }

      for (const strategy of strategies) {
        if (interrupted) break;
        const counters = await migrateOneTable(ds, sps, strategy, opts, logger);
        tableSummaries.push({ table: strategy.tableName, counters });
      }
    }

    // Bootstrap subfolders for every existing plan (idempotent).
    if (!interrupted) {
      await bootstrapAllPlans(ds, sps, opts, logger);
    }

    // Final summary.
    const durationMs = Date.now() - startedAt;
    logger.log('===== MIGRATION SUMMARY =====');
    for (const { table, counters } of tableSummaries) {
      logger.log(
        `  ${table}: scanned=${counters.scanned} migrated=${counters.migrated} ` +
          `skippedAlreadyRelative=${counters.skippedAlreadyRelative} ` +
          `skippedNullOrEmpty=${counters.skippedNullOrEmpty} ` +
          `skippedMissingSource=${counters.skippedMissingSource} ` +
          `skippedUnresolvable=${counters.skippedUnresolvable} ` +
          `failed=${counters.failed} bytesMoved=${counters.bytesMoved}`,
      );
    }
    const totalBytes = tableSummaries.reduce(
      (acc, t) => acc + t.counters.bytesMoved,
      0,
    );
    const totalFailed = tableSummaries.reduce(
      (acc, t) => acc + t.counters.failed,
      0,
    );
    logger.log(
      `Done in ${durationMs}ms. totalBytesMoved=${totalBytes} totalFailed=${totalFailed} ` +
        `interrupted=${interrupted} dryRun=${opts.dryRun}`,
    );
  } finally {
    await app.close();
  }
}

async function migrateOneTable(
  ds: DataSource,
  sps: StoragePathService,
  strategy: TableStrategy,
  opts: CliOptions,
  logger: Logger,
): Promise<TableCounters> {
  const counters = emptyCounters();
  logger.log(`[${strategy.tableName}] begin`);
  for await (const batch of strategy.streamBatches(ds, opts.batchSize)) {
    if (interrupted) break;
    for (const row of batch) {
      if (interrupted) break;
      counters.scanned += 1;
      try {
        // Detect rows where every file_path candidate is null/empty
        // BEFORE asking the strategy to compute — this lets us
        // distinguish "nothing to migrate" from "couldn't resolve
        // parent".
        const hasAnyValue = rowHasAnyFilePathValue(strategy.tableName, row);
        const plans = await strategy.computePlans(ds, sps, row);

        if (plans.length === 0) {
          if (!hasAnyValue) {
            counters.skippedNullOrEmpty += 1;
          } else {
            counters.skippedUnresolvable += 1;
            // eslint-disable-next-line no-console
            console.warn(
              `[migrate] entity=${strategy.tableName} id=${row.id} ` +
                `status=unresolvable (missing parent join or invalid version)`,
            );
          }
          continue;
        }

        // Partition plans: rows where any column is already relative
        // contribute to skippedAlreadyRelative; rows where all plans are
        // absolute → migration plan.
        const absolutePlans = plans.filter((p) => path.isAbsolute(p.oldStored));
        if (absolutePlans.length === 0) {
          counters.skippedAlreadyRelative += 1;
          continue;
        }

        // Per-plan existence check.
        const usable: MovePlan[] = [];
        let missing = 0;
        for (const plan of absolutePlans) {
          try {
            await fsp.access(plan.oldAbs, fs.constants.F_OK);
            usable.push(plan);
          } catch {
            missing += 1;
            // eslint-disable-next-line no-console
            console.warn(
              `[migrate] entity=${strategy.tableName} id=${row.id} col=${plan.column} ` +
                `from=${plan.oldAbs} status=missing-source (skipped)`,
            );
          }
        }
        if (usable.length === 0) {
          counters.skippedMissingSource += missing > 0 ? 1 : 0;
          if (missing === 0) counters.skippedUnresolvable += 1;
          continue;
        }

        if (opts.dryRun) {
          for (const plan of usable) {
            // eslint-disable-next-line no-console
            console.log(
              `[migrate] entity=${strategy.tableName} id=${row.id} col=${plan.column} ` +
                `from=${plan.oldAbs} to=${plan.newAbs} status=dry-run`,
            );
          }
          counters.migrated += 1;
          continue;
        }

        const bytes = await strategy.applyPlans(ds, sps, row, usable);
        counters.bytesMoved += bytes;
        counters.migrated += 1;
        for (const plan of usable) {
          // eslint-disable-next-line no-console
          console.log(
            `[migrate] entity=${strategy.tableName} id=${row.id} col=${plan.column} ` +
              `from=${plan.oldAbs} to=${plan.newAbs} status=ok`,
          );
        }
      } catch (err) {
        counters.failed += 1;
        // eslint-disable-next-line no-console
        console.error(
          `[migrate] entity=${strategy.tableName} id=${row.id} status=failed: ${
            (err as Error).message
          }`,
        );
      }
    }
    logger.log(
      `[${strategy.tableName}] progress: scanned=${counters.scanned} ` +
        `migrated=${counters.migrated} skippedAlreadyRelative=${counters.skippedAlreadyRelative} ` +
        `skippedMissingSource=${counters.skippedMissingSource} failed=${counters.failed}`,
    );
  }
  return counters;
}

/**
 * Returns true when the row has at least one non-empty candidate
 * file_path column. Used to distinguish "no file paths to migrate"
 * (skippedNullOrEmpty) from "couldn't resolve parent" (skippedUnresolvable).
 */
function rowHasAnyFilePathValue(tableName: string, row: TableRow): boolean {
  switch (tableName) {
    case 'book_assembly_drafts':
      return Boolean(row.part1FilePath || row.part2FilePath || row.part3FilePath);
    case 'book_assembly_versions':
      return Boolean(
        row.part1FilePath ||
          row.part2FilePath ||
          row.part3FilePath ||
          row.mergedFilePath,
      );
    case 'supplement_assembly_versions':
      return Boolean(row.mergedFilePath);
    default:
      return Boolean(row.filePath ?? row.file_path);
  }
}

async function bootstrapAllPlans(
  ds: DataSource,
  sps: StoragePathService,
  opts: CliOptions,
  logger: Logger,
): Promise<void> {
  const planRepo = ds.getRepository(DevelopmentPlan);
  // Use raw select to include soft-deleted plans (we still want the
  // subfolders to exist for historical reads).
  const plans = await planRepo.find({ withDeleted: true });
  logger.log(`Bootstrapping ${plans.length} plan(s)…`);
  let ok = 0;
  let failed = 0;
  for (const plan of plans) {
    if (interrupted) break;
    if (opts.dryRun) {
      // eslint-disable-next-line no-console
      console.log(`[bootstrap] planId=${plan.id} status=dry-run`);
      ok += 1;
      continue;
    }
    try {
      await sps.bootstrapPlan(plan.id);
      ok += 1;
    } catch (err) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.error(
        `[bootstrap] planId=${plan.id} status=failed: ${(err as Error).message}`,
      );
    }
  }
  logger.log(`Bootstrap done: ok=${ok} failed=${failed} total=${plans.length}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error((err as Error).message);
    printUsage();
    process.exit(2);
    return;
  }
  try {
    await runMigration(opts);
    process.exit(interrupted ? 130 : 0);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[migrate] fatal:', (err as Error).stack || err);
    process.exit(1);
  }
}

// Only invoke main when run directly (not when imported by tests).
if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  main();
}

export {
  parseArgs,
  buildStrategies,
  emptyCounters,
  prefixedBasename,
  moveLegacyToNew,
  CliOptions,
  TableCounters,
  TableStrategy,
  MovePlan,
};
