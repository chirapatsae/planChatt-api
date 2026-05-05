/**
 * rollup-backfill.ts — W107-BE-PR1 backfill CLI.
 *
 * Usage:
 *   npx ts-node -T scripts/rollup-backfill.ts --start=2026-01-01 --end=2026-04-30
 *
 * Iterates day-by-day from --start to --end (inclusive, ICT calendar)
 * and calls `RollupCronService.rollupForDate(bucketDate)` for each day.
 *
 * The CLI shares the same code path as the nightly cron — there is one
 * source of truth for the rollup algorithm, and replaying a day produces
 * an identical row per segment because the UPSERT key is
 * (bucket_date, role, COALESCE(amphoe_id, ''), COALESCE(government_agency_id, ''))
 * and all metric inputs are immutable historical data.
 *
 * §17.2 — output is advisory metadata; this CLI does NOT touch
 *         tracking_status or any project table.
 * §17.3 — only writes to system_usage_daily_rollups (via the cron service).
 *
 * Operator note: do NOT include today's date in the range — the cron
 * owns today and a backfill collision would needlessly UPSERT twice.
 */

import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { RollupCronService } from '../src/system-usage/rollup-cron.service';

interface CliArgs {
  start: string;
  end: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string> = {};
  for (const a of argv.slice(2)) {
    const m = /^--([a-zA-Z0-9_-]+)=(.+)$/.exec(a);
    if (m) args[m[1]] = m[2];
  }
  if (!args.start || !args.end) {
    throw new Error(
      'Usage: rollup-backfill --start=YYYY-MM-DD --end=YYYY-MM-DD',
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.start)) {
    throw new Error(`--start must be YYYY-MM-DD (got "${args.start}")`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.end)) {
    throw new Error(`--end must be YYYY-MM-DD (got "${args.end}")`);
  }
  if (args.start > args.end) {
    throw new Error(`--start (${args.start}) must be <= --end (${args.end})`);
  }
  return { start: args.start, end: args.end };
}

/**
 * Inclusive day-by-day iterator. Operates on the date string directly
 * to avoid timezone drift. ICT calendar arithmetic is just integer
 * addition on the (year, month, day) tuple.
 */
function* dateRange(start: string, end: string): Generator<string> {
  const [sy, sm, sd] = start.split('-').map((s) => parseInt(s, 10));
  const [ey, em, ed] = end.split('-').map((s) => parseInt(s, 10));
  // Use UTC midnight to avoid TZ drift; we never read the time component.
  const cur = new Date(Date.UTC(sy, sm - 1, sd));
  const stop = new Date(Date.UTC(ey, em - 1, ed));
  while (cur.getTime() <= stop.getTime()) {
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, '0');
    const d = String(cur.getUTCDate()).padStart(2, '0');
    yield `${y}-${m}-${d}`;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
}

async function main(): Promise<void> {
  const logger = new Logger('rollup-backfill');
  const { start, end } = parseArgs(process.argv);

  logger.log(`backfill start=${start} end=${end}`);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  let okDays = 0;
  let failDays = 0;
  const failures: Array<{ day: string; error: string }> = [];

  try {
    const svc = app.get(RollupCronService);
    for (const day of dateRange(start, end)) {
      const t0 = Date.now();
      try {
        const rows = await svc.rollupForDate(day);
        const ms = Date.now() - t0;
        logger.log(`day=${day} rows=${rows} duration=${ms}ms OK`);
        okDays++;
      } catch (e: any) {
        const ms = Date.now() - t0;
        logger.error(
          `day=${day} duration=${ms}ms FAILED: ${e?.message ?? e}`,
          e?.stack,
        );
        failures.push({ day, error: e?.message ?? String(e) });
        failDays++;
      }
    }
  } finally {
    await app.close();
  }

  logger.log(
    `backfill complete ok_days=${okDays} fail_days=${failDays} range=${start}..${end}`,
  );
  if (failDays > 0) {
    logger.error(
      `failures: ${JSON.stringify(failures, null, 2)}`,
    );
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[rollup-backfill] fatal:', e);
  process.exit(1);
});
