/**
 * W-CLEANUP-STORAGE-FILES — Tier C NUCLEAR cleanup CLI.
 *
 * Destructive, FK-safe, single-transaction wipe of every DB table that
 * holds file-referencing rows or workflow data spawned by the now-deleted
 * `storage/` + `upload/` directories.
 *
 * Source of truth (frozen by BE-SCOPE):
 *   - docs/tasks/W-CLEANUP-STORAGE-FILES.md (§3 Tier C, §7 CLI surface, §13)
 *   - docs/reports/W-CLEANUP-STORAGE-FILES-SCOPE.md (40-row FK delete order)
 *   - CLAUDE.md §12 (audit override), §14/§15 (lineage; respected by FK order),
 *     §17.3 (AI tables — no FK; explicit delete required)
 *
 * Pattern source: `backend/src/storage/migration/storage-migration.cli.ts`
 *
 * Usage:
 *   npx ts-node backend/src/storage/migration/storage-files-cleanup.cli.ts \
 *     --tier=C [--dry-run] [--confirm-audit-override] [--allow-prod] \
 *     [--skip-quotas] [--skip-plan-phases] [--skip-notification-logs]
 *
 *   --tier=<A|B|C>                  REQUIRED. Tier C = nuclear (all 40 tables).
 *                                   Only Tier C is implemented in this wave.
 *   --dry-run                       Read-only inventory; no mutation.
 *   --confirm-audit-override        REQUIRED for Tier C (deletes tracking_status; §12).
 *   --allow-prod                    REQUIRED when NODE_ENV=production.
 *   --skip-quotas                   (default true)  Keep ai_usage_quotas (per-user budget).
 *   --skip-plan-phases              (default false) Default false — plan_phase auto-CASCADEs
 *                                   when development_plan is deleted.
 *   --skip-notification-logs        (default true)  notification_logs is project-decoupled.
 *
 * Behaviour:
 *   1. Pre-flight: print env, dry-run flag, tier; refuse on production without
 *      --allow-prod; refuse Tier C without --confirm-audit-override.
 *   2. Print the frozen 40-row delete order for operator visual confirmation.
 *   3. 5-second countdown (skipped in dry-run) before destructive run.
 *   4. Inventory phase: SELECT count(*) per in-scope table; print formatted
 *      table and grand total.
 *   5. Dry-run mode: exit 0 after inventory.
 *   6. Destructive mode: single `dataSource.transaction` → DELETE FROM each
 *      table in order → post-flight zero-check → COMMIT (or ROLLBACK on
 *      any anomaly).
 *   7. Print reference-data row counts (users, work_history, etc.) so the
 *      operator can confirm they survived.
 *
 * Idempotency: re-running after success finds zero rows everywhere and
 * commits a no-op transaction; exit 0.
 */

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';

// ---------------------------------------------------------------------------
// Tier C delete-order — FROZEN from BE-SCOPE report
// ---------------------------------------------------------------------------

/**
 * Marker for tables whose physical existence in the live DB is not guaranteed
 * (e.g. `book_assembly_version_projects` was flagged TABLE NOT FOUND in
 * BE-SCOPE because no `@Entity` is registered for it). The DELETE is wrapped
 * in try/catch to swallow PostgreSQL "undefined_table" (`42P01`).
 */
interface TableEntry {
  index: number;
  table: string;
  /** When true, missing-table errors are tolerated (best-effort delete). */
  optional?: boolean;
  /** Operator-controlled skip flag — corresponds to a CLI argument. */
  controlledBy?: 'skipNotificationLogs' | 'skipQuotas' | 'skipPlanPhases';
}

const DELETE_ORDER: TableEntry[] = [
  // ── Tier A: PDF documents ─────────────────────────────────────────────
  { index: 1, table: 'pdf_development_plan_draft_agency_documents' },
  { index: 2, table: 'pdf_development_plan_draft_coordinate_documents' },
  { index: 3, table: 'pdf_development_plan_approved_documents' },
  { index: 4, table: 'pdf_out_authority_documents' },
  { index: 5, table: 'pdf_revision_edit_draft_documents' },
  { index: 6, table: 'pdf_revision_edit_approved_documents' },
  { index: 7, table: 'pdf_revision_change_draft_documents' },
  { index: 8, table: 'pdf_revision_change_approved_documents' },
  { index: 9, table: 'pdf_supplement_draft_documents' },
  { index: 10, table: 'pdf_supplement_approved_documents' },

  // ── Tier A: assembly artifacts ────────────────────────────────────────
  { index: 11, table: 'book_assembly_version_projects', optional: true },
  { index: 12, table: 'book_project_lineage' },
  { index: 13, table: 'deprecation_audit_logs' },
  { index: 14, table: 'book_assembly_drafts' },
  { index: 15, table: 'book_assembly_versions' },
  { index: 16, table: 'supplement_assembly_version_projects' },
  { index: 17, table: 'supplement_assembly_versions' },
  { index: 18, table: 'supplement_assembly_drafts' },

  // ── Tier B: attachments ───────────────────────────────────────────────
  { index: 19, table: 'attachment_project_groups' },
  { index: 20, table: 'attachment_revised_project_groups' },
  { index: 21, table: 'attachment_supplement_project_groups' },

  // ── Tier C: AI result tables (§17.3 no-FK; explicit) ──────────────────
  { index: 22, table: 'ai_pre_submit_snapshots' },
  { index: 23, table: 'ai_staff_review_runs' },
  { index: 24, table: 'ai_executive_messages' },
  { index: 25, table: 'ai_executive_conversations' },
  { index: 26, table: 'ai_usage_logs' },

  // ── Tier C: workflow audit ────────────────────────────────────────────
  { index: 27, table: 'comment' },
  { index: 28, table: 'tracking_status' },

  // ── Tier C: notifications (bare-uuid project linkage) ─────────────────
  { index: 29, table: 'notification_email_logs' },
  { index: 30, table: 'notification_line_logs' },
  { index: 31, table: 'notification_logs', controlledBy: 'skipNotificationLogs' },

  // ── Tier C: per-project sub-tables ────────────────────────────────────
  { index: 32, table: 'budget' },
  { index: 33, table: 'favorites' },

  // ── Tier C: project rows ──────────────────────────────────────────────
  { index: 34, table: 'supplement_project_groups' },
  { index: 35, table: 'revised_project_groups' },
  { index: 36, table: 'project_groups' },

  // ── Tier C: plan / issue containers ───────────────────────────────────
  { index: 37, table: 'development_issues' },
  { index: 38, table: 'development_plan_supplement' },
  { index: 39, table: 'development_plan_revision' },
  { index: 40, table: 'development_plan' },
];

/**
 * Tables that MUST survive the nuke. Listed for the post-run survivor
 * report so the operator can confirm reference data is intact.
 */
const SURVIVOR_TABLES: string[] = [
  'users',
  'work_history',
  'government_agencies',
  'amphoes',
  'local_administrative_organizations',
  'status',
  'roles',
  'work_status',
  'revision_type',
  'strategy',
  'tactic',
  'plan',
  'project_types',
  'positions',
];

/**
 * Optional skip tables — handled via CLI flag, not in default delete set.
 * `ai_usage_quotas` and `plan_phase` are listed here for the dry-run inventory.
 */
const OPTIONAL_SKIP_TABLES: Array<{ table: string; controlledBy: TableEntry['controlledBy'] }> = [
  { table: 'ai_usage_quotas', controlledBy: 'skipQuotas' },
  { table: 'plan_phase', controlledBy: 'skipPlanPhases' },
];

// ---------------------------------------------------------------------------
// CLI option parsing
// ---------------------------------------------------------------------------

interface CliOptions {
  tier: 'A' | 'B' | 'C' | null;
  dryRun: boolean;
  confirmAuditOverride: boolean;
  allowProd: boolean;
  skipQuotas: boolean;
  skipPlanPhases: boolean;
  skipNotificationLogs: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    tier: null,
    dryRun: false,
    confirmAuditOverride: false,
    allowProd: false,
    skipQuotas: true,
    skipPlanPhases: false,
    skipNotificationLogs: true,
  };

  for (const raw of argv.slice(2)) {
    if (raw === '--dry-run') {
      opts.dryRun = true;
    } else if (raw === '--confirm-audit-override') {
      opts.confirmAuditOverride = true;
    } else if (raw === '--allow-prod') {
      opts.allowProd = true;
    } else if (raw === '--skip-quotas') {
      opts.skipQuotas = true;
    } else if (raw === '--no-skip-quotas') {
      opts.skipQuotas = false;
    } else if (raw === '--skip-plan-phases') {
      opts.skipPlanPhases = true;
    } else if (raw === '--no-skip-plan-phases') {
      opts.skipPlanPhases = false;
    } else if (raw === '--skip-notification-logs') {
      opts.skipNotificationLogs = true;
    } else if (raw === '--no-skip-notification-logs') {
      opts.skipNotificationLogs = false;
    } else if (raw.startsWith('--tier=')) {
      const v = raw.substring('--tier='.length).toUpperCase().trim();
      if (v !== 'A' && v !== 'B' && v !== 'C') {
        throw new Error(`Invalid --tier value: "${raw}" (must be A|B|C)`);
      }
      opts.tier = v;
    } else if (raw === '--help' || raw === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown flag: "${raw}". Use --help for usage.`);
    }
  }

  return opts;
}

function printUsage(): void {
  const lines = [
    'Usage: storage-files-cleanup.cli.ts [options]',
    '',
    '  --tier=<A|B|C>             REQUIRED. Tier C = nuclear (all 40 tables).',
    '                             A and B are reserved for future waves.',
    '  --dry-run                  Read-only inventory; no mutation.',
    '  --confirm-audit-override   REQUIRED for Tier C (deletes tracking_status; §12).',
    '  --allow-prod               REQUIRED when NODE_ENV=production.',
    '  --skip-quotas              (default ON)  Keep ai_usage_quotas.',
    '  --no-skip-quotas           Also nuke ai_usage_quotas (per-user budget reset).',
    '  --skip-plan-phases         Explicit DELETE FROM plan_phase (default OFF — relies',
    '                             on CASCADE via development_plan).',
    '  --skip-notification-logs   (default ON)  Skip notification_logs (announcement-bound).',
    '  --no-skip-notification-logs Include notification_logs in the wipe.',
    '  --help                     Print this help.',
    '',
    'Examples:',
    '  Dry-run (safe inventory):',
    '    npm run storage:cleanup:dry',
    '  Destructive (after dry-run review):',
    '    npm run storage:cleanup -- --tier=C --confirm-audit-override',
  ];
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Pretty-printing helpers
// ---------------------------------------------------------------------------

function padLeft(s: string | number, width: number): string {
  const t = String(s);
  if (t.length >= width) return t;
  return ' '.repeat(width - t.length) + t;
}

function padRight(s: string | number, width: number): string {
  const t = String(s);
  if (t.length >= width) return t;
  return t + ' '.repeat(width - t.length);
}

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return '   ?   ';
  return n.toLocaleString('en-US');
}

function buildInventoryTable(
  rows: Array<{ index: number; table: string; rows: number | null; note?: string }>,
): string[] {
  const indexWidth = 4;
  const tableWidth = 42;
  const rowsWidth = 11;
  const noteWidth = 30;
  const sep =
    '┌' +
    '─'.repeat(indexWidth + 2) +
    '┬' +
    '─'.repeat(tableWidth + 2) +
    '┬' +
    '─'.repeat(rowsWidth + 2) +
    '┬' +
    '─'.repeat(noteWidth + 2) +
    '┐';
  const mid =
    '├' +
    '─'.repeat(indexWidth + 2) +
    '┼' +
    '─'.repeat(tableWidth + 2) +
    '┼' +
    '─'.repeat(rowsWidth + 2) +
    '┼' +
    '─'.repeat(noteWidth + 2) +
    '┤';
  const bot =
    '└' +
    '─'.repeat(indexWidth + 2) +
    '┴' +
    '─'.repeat(tableWidth + 2) +
    '┴' +
    '─'.repeat(rowsWidth + 2) +
    '┴' +
    '─'.repeat(noteWidth + 2) +
    '┘';

  const out: string[] = [];
  out.push(sep);
  out.push(
    '│ ' +
      padRight('#', indexWidth) +
      ' │ ' +
      padRight('Table', tableWidth) +
      ' │ ' +
      padLeft('Rows', rowsWidth) +
      ' │ ' +
      padRight('Note', noteWidth) +
      ' │',
  );
  out.push(mid);
  let total = 0;
  for (const r of rows) {
    if (r.rows !== null) total += r.rows;
    out.push(
      '│ ' +
        padRight(r.index, indexWidth) +
        ' │ ' +
        padRight(r.table.length > tableWidth ? r.table.substring(0, tableWidth) : r.table, tableWidth) +
        ' │ ' +
        padLeft(fmtNum(r.rows), rowsWidth) +
        ' │ ' +
        padRight((r.note ?? '').substring(0, noteWidth), noteWidth) +
        ' │',
    );
  }
  out.push(mid);
  out.push(
    '│ ' +
      padRight('', indexWidth) +
      ' │ ' +
      padRight('GRAND TOTAL ROWS', tableWidth) +
      ' │ ' +
      padLeft(fmtNum(total), rowsWidth) +
      ' │ ' +
      padRight('', noteWidth) +
      ' │',
  );
  out.push(bot);
  return out;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the table physically exists in the current schema.
 * Used to swallow "undefined_table" errors for OPTIONAL entries (#11) so
 * the script is portable between staging (where the table may exist as a
 * raw join row without an `@Entity`) and clean dev DBs.
 */
async function tableExists(em: EntityManager, table: string): Promise<boolean> {
  const result = await em.query(
    `SELECT to_regclass($1) AS reg`,
    [`public.${table}`],
  );
  return Array.isArray(result) && result.length > 0 && result[0].reg !== null;
}

async function countRows(em: EntityManager, table: string): Promise<number | null> {
  try {
    const rows = await em.query(`SELECT count(*)::bigint AS n FROM "${table}"`);
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    return Number(rows[0].n ?? 0);
  } catch (err: any) {
    // 42P01 = undefined_table
    if (err?.code === '42P01') return null;
    throw err;
  }
}

async function deleteAll(em: EntityManager, table: string): Promise<number> {
  // No WHERE clause — Tier C is full wipe.
  // No CASCADE modifier — we rely on the explicit FK order; missing
  // children would surface as a foreign-key violation that aborts the
  // whole transaction (intended).
  const result = await em.query(`DELETE FROM "${table}"`);
  // node-postgres returns { rowCount } as the second element for raw query
  // results; TypeORM's wrapper exposes rowCount differently across versions.
  // For raw `DELETE` the wrapper returns an array, but the affected count
  // travels via `result[1]?.rowCount` in some configs. Read defensively.
  if (Array.isArray(result) && result.length >= 2 && typeof result[1] === 'object') {
    const meta = result[1] as { rowCount?: number };
    if (typeof meta.rowCount === 'number') return meta.rowCount;
  }
  // Fall back: re-count post-delete to derive affected (should be 0 after wipe).
  return 0;
}

// ---------------------------------------------------------------------------
// Main driver
// ---------------------------------------------------------------------------

async function run(opts: CliOptions): Promise<void> {
  const logger = new Logger('storage-files-cleanup');
  const env = process.env.NODE_ENV ?? 'unknown';

  logger.log(`[cleanup] env=${env} dryRun=${opts.dryRun} tier=${opts.tier ?? 'NONE'}`);

  // -----------------------------------------------------------------
  // Argument validation
  // -----------------------------------------------------------------
  if (!opts.tier) {
    logger.error('REFUSED: --tier=<A|B|C> is required.');
    printUsage();
    process.exit(1);
  }
  if (opts.tier !== 'C') {
    logger.error(
      `REFUSED: tier=${opts.tier} is reserved for a future wave. Only Tier C is implemented.`,
    );
    process.exit(1);
  }
  if (env === 'production' && !opts.allowProd) {
    logger.error(
      'REFUSED: NODE_ENV=production requires --allow-prod. This is a destructive operation.',
    );
    process.exit(1);
  }
  if (opts.tier === 'C' && !opts.confirmAuditOverride && !opts.dryRun) {
    logger.error(
      'REFUSED: Tier C deletes tracking_status (CLAUDE.md §12 audit override). ' +
        'Re-run with --confirm-audit-override to acknowledge.',
    );
    process.exit(1);
  }

  // -----------------------------------------------------------------
  // Build the effective delete plan (apply skip flags)
  // -----------------------------------------------------------------
  const effectivePlan: TableEntry[] = DELETE_ORDER.filter((e) => {
    if (e.controlledBy === 'skipNotificationLogs' && opts.skipNotificationLogs) return false;
    return true;
  });

  // ai_usage_quotas + plan_phase: appended only if explicitly requested.
  const extras: TableEntry[] = [];
  if (!opts.skipQuotas) {
    // ai_usage_logs (#26) FK-references ai_usage_quotas with NO ACTION;
    // since #26 has already cleared, the quota table becomes deletable.
    extras.push({ index: 26.5, table: 'ai_usage_quotas' });
  }
  if (opts.skipPlanPhases) {
    // Insert explicit plan_phase before development_plan (#40).
    extras.push({ index: 39.5, table: 'plan_phase' });
  }
  // Merge by index so they appear in the correct printed order.
  const fullPlan = [...effectivePlan, ...extras].sort((a, b) => a.index - b.index);

  // -----------------------------------------------------------------
  // Print the planned delete order for operator visual confirmation
  // -----------------------------------------------------------------
  logger.log('[cleanup] Planned delete order (FK-safe; from BE-SCOPE report):');
  for (const e of fullPlan) {
    const marker = e.optional ? ' (optional — DROP IF EXISTS)' : '';
    // eslint-disable-next-line no-console
    console.log(`  ${padLeft(e.index, 4)}. DELETE FROM ${e.table}${marker}`);
  }
  const skipNotes: string[] = [];
  if (opts.skipNotificationLogs) skipNotes.push('notification_logs (announcement-bound)');
  if (opts.skipQuotas) skipNotes.push('ai_usage_quotas (per-user budget)');
  if (!opts.skipPlanPhases) skipNotes.push('plan_phase (auto-CASCADE via development_plan)');
  if (skipNotes.length > 0) {
    logger.log(`[cleanup] Skipped: ${skipNotes.join(', ')}`);
  }

  // -----------------------------------------------------------------
  // Boot Nest application context
  // -----------------------------------------------------------------
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const startedAt = Date.now();
  let inventory: Array<{ index: number; table: string; rows: number | null; note?: string }> = [];
  let deletedSummary: Array<{ table: string; deleted: number }> = [];
  let exitCode = 0;

  try {
    const dataSource = app.get(DataSource);
    const em = dataSource.manager;

    // 5-second countdown before destructive work (skipped in dry-run).
    if (!opts.dryRun) {
      for (let i = 5; i > 0; i--) {
        logger.warn(
          `[cleanup] Destructive run begins in ${i}s … (Ctrl+C to abort)`,
        );
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    // -----------------------------------------------------------------
    // Inventory phase (read-only, always runs)
    // -----------------------------------------------------------------
    logger.log('[cleanup] Inventory phase — SELECT count(*) per in-scope table');
    inventory = [];
    for (const e of fullPlan) {
      const rows = await countRows(em, e.table);
      const note = rows === null ? 'TABLE NOT FOUND' : e.optional ? 'optional' : '';
      inventory.push({ index: e.index, table: e.table, rows, note });
    }
    for (const line of buildInventoryTable(inventory)) {
      // eslint-disable-next-line no-console
      console.log(line);
    }

    // Survivor inventory — informational only.
    logger.log('[cleanup] Reference / survivor tables (must remain intact):');
    const survivors: Array<{ table: string; rows: number | null }> = [];
    for (const t of SURVIVOR_TABLES) {
      const rows = await countRows(em, t);
      survivors.push({ table: t, rows });
    }
    for (const s of survivors) {
      // eslint-disable-next-line no-console
      console.log(`  ${padRight(s.table, 42)} : ${padLeft(fmtNum(s.rows), 11)}`);
    }
    for (const opt of OPTIONAL_SKIP_TABLES) {
      const rows = await countRows(em, opt.table);
      const skipped =
        (opt.controlledBy === 'skipQuotas' && opts.skipQuotas) ||
        (opt.controlledBy === 'skipPlanPhases' && !opts.skipPlanPhases);
      const tag = skipped ? '(SKIPPED — survives)' : '(in delete plan)';
      // eslint-disable-next-line no-console
      console.log(`  ${padRight(opt.table, 42)} : ${padLeft(fmtNum(rows), 11)}   ${tag}`);
    }

    if (opts.dryRun) {
      logger.log('[cleanup] --dry-run set; no mutations performed. Exit 0.');
      return;
    }

    // -----------------------------------------------------------------
    // Destructive phase — single transaction
    // -----------------------------------------------------------------
    logger.warn('[cleanup] Beginning destructive transaction …');
    deletedSummary = await dataSource.transaction(async (manager) => {
      const summary: Array<{ table: string; deleted: number }> = [];
      for (const e of fullPlan) {
        // Count BEFORE delete (TypeORM `query()` for raw DELETE does not
        // reliably expose `rowCount`, so compute affected = pre-count).
        let affected = 0;
        try {
          const exists = e.optional ? await tableExists(manager, e.table) : true;
          if (!exists) {
            logger.log(`[cleanup] table=${e.table} status=skipped (table not found)`);
            summary.push({ table: e.table, deleted: 0 });
            continue;
          }
          const pre = await countRows(manager, e.table);
          affected = pre ?? 0;
          await deleteAll(manager, e.table);
        } catch (err: any) {
          if (e.optional && err?.code === '42P01') {
            logger.log(`[cleanup] table=${e.table} status=skipped (undefined_table swallowed)`);
            summary.push({ table: e.table, deleted: 0 });
            continue;
          }
          throw err;
        }
        logger.log(`[cleanup] table=${e.table} deleted=${affected}`);
        summary.push({ table: e.table, deleted: affected });
      }

      // Post-flight assertion: every in-scope table must be empty before commit.
      logger.log('[cleanup] Post-flight zero-check …');
      for (const e of fullPlan) {
        const exists = e.optional ? await tableExists(manager, e.table) : true;
        if (!exists) continue;
        const after = await countRows(manager, e.table);
        if ((after ?? 0) !== 0) {
          throw new Error(
            `[cleanup] post-flight FAIL: table=${e.table} expected=0 actual=${after}. ` +
              `Rolling back the entire transaction.`,
          );
        }
      }

      return summary;
    });
  } catch (err) {
    exitCode = 1;
    logger.error(`[cleanup] FATAL: ${(err as Error).stack || (err as Error).message || err}`);
  } finally {
    // -----------------------------------------------------------------
    // Final summary
    // -----------------------------------------------------------------
    const durationMs = Date.now() - startedAt;
    if (exitCode === 0) {
      logger.log('[cleanup] === DONE ===');
      const totalDeleted = deletedSummary.reduce((a, t) => a + t.deleted, 0);
      const skippedTables = deletedSummary
        .filter((t) => t.deleted === 0)
        .map((t) => t.table);
      logger.log(`Tables touched  : ${deletedSummary.length}`);
      logger.log(`Rows deleted    : ${fmtNum(totalDeleted)}`);
      logger.log(`Empty / skipped : ${skippedTables.length}`);
      logger.log(`Duration        : ${durationMs}ms`);
      // Survivor verification (post-transaction).
      try {
        const ds = app.get(DataSource);
        logger.log('Reference data survives:');
        for (const t of SURVIVOR_TABLES) {
          const rows = await countRows(ds.manager, t);
          // eslint-disable-next-line no-console
          console.log(`  ${padRight(t, 42)} : ${padLeft(fmtNum(rows), 11)}`);
        }
      } catch {
        // best-effort post-summary
      }
    } else {
      logger.error(`[cleanup] FAILED after ${durationMs}ms. No partial writes (single tx).`);
    }
    await app.close();
    process.exit(exitCode);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
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
  await run(opts);
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  main();
}

export {
  parseArgs,
  DELETE_ORDER,
  SURVIVOR_TABLES,
  OPTIONAL_SKIP_TABLES,
  CliOptions,
  TableEntry,
};
