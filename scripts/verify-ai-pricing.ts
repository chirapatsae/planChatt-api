/**
 * verify-ai-pricing.ts — P2 (2026-05-17).
 *
 * OpenAI does not publish a stable public JSON pricing API. This script
 * is a tooling aid for the operator: it (a) prints the locally-stored
 * PRICING table in a readable format, (b) shows the "Last reviewed"
 * date stamped in `cost-calculator.ts`, and (c) WARNS when the table
 * has not been reviewed in > 30 days.
 *
 * The operator's responsibility:
 *   1. Run `npm run ai:pricing:check` monthly (or after any OpenAI
 *      pricing announcement).
 *   2. Open https://openai.com/api/pricing in a browser.
 *   3. Eyeball the numbers in the script's output vs the live page.
 *   4. If any drift: update `PRICING` in `cost-calculator.ts` AND
 *      bump the `Last reviewed: YYYY-MM-DD` comment at the top of
 *      that file.
 *
 * Exits 0 always (advisory) — does NOT fail CI. If you want a
 * hard-fail gate, wire this into a cron job that posts to ops
 * channel when the warn condition fires.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PRICING, CACHED_INPUT_DISCOUNT } from '../src/ai/utils/cost-calculator';
import { getUsdToThbFx } from '../src/ai-usage-quotas/fx-config';

const COST_CALCULATOR_PATH = path.resolve(
  __dirname,
  '../src/ai/utils/cost-calculator.ts',
);

function extractLastReviewedDate(filePath: string): string | null {
  const text = fs.readFileSync(filePath, 'utf-8');
  const m = text.match(/Last reviewed:\s*(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function daysBetween(isoDate: string, today: Date): number {
  const past = new Date(`${isoDate}T00:00:00Z`).getTime();
  const now = today.getTime();
  return Math.floor((now - past) / (1000 * 60 * 60 * 24));
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function main(): void {
  const fx = getUsdToThbFx();
  const lastReviewed = extractLastReviewedDate(COST_CALCULATOR_PATH);
  const today = new Date();

  console.log('============================================================');
  console.log('  OpenAI Pricing Self-Check                                ');
  console.log('  Source of truth: https://openai.com/api/pricing          ');
  console.log('============================================================');
  console.log();
  console.log(`Last reviewed: ${lastReviewed ?? 'UNKNOWN'}`);
  if (lastReviewed) {
    const age = daysBetween(lastReviewed, today);
    console.log(`Age:           ${age} day(s)`);
    if (age > 30) {
      console.log();
      console.log('  ⚠️  WARNING: pricing table not reviewed in over 30 days.');
      console.log('     OpenAI may have lowered prices — overcharging risk.');
      console.log('     Please verify https://openai.com/api/pricing and');
      console.log('     update PRICING + bump the "Last reviewed" comment.');
    } else {
      console.log('  ✅ Within the 30-day review window.');
    }
  } else {
    console.log('  ⚠️  Cannot find "Last reviewed: YYYY-MM-DD" stamp in');
    console.log('     cost-calculator.ts. Add one near the PRICING table.');
  }
  console.log();
  console.log(`USD → THB FX rate (env OPENAI_USD_TO_THB_FX): ${fx} ฿/$`);
  console.log();
  console.log('Per-model pricing (per 1M tokens):');
  console.log();
  console.log(
    '  ┌──────────────────┬───────────┬───────────┬────────────────┬────────────────┐',
  );
  console.log(
    '  │ Model            │ Input USD │ Output USD│ Input THB(/1M) │ Output THB(/1M)│',
  );
  console.log(
    '  ├──────────────────┼───────────┼───────────┼────────────────┼────────────────┤',
  );

  for (const [model, p] of Object.entries(PRICING)) {
    const inThb = (p.input * fx).toFixed(2);
    const outThb = (p.output * fx).toFixed(2);
    console.log(
      `  │ ${model.padEnd(16)} │ ${fmtUsd(p.input).padStart(9)} │ ${fmtUsd(p.output).padStart(9)} │ ${inThb.padStart(14)} │ ${outThb.padStart(14)} │`,
    );
  }
  console.log(
    '  └──────────────────┴───────────┴───────────┴────────────────┴────────────────┘',
  );
  console.log();
  console.log(
    `Cached-input discount (Oct 2024 prompt caching): ${(CACHED_INPUT_DISCOUNT * 100).toFixed(0)}% off input rate`,
  );
  console.log();
  console.log('Sample cost computation (1,000 input + 200 output, no cache):');
  for (const [model, p] of Object.entries(PRICING)) {
    const costUsd = (1000 / 1_000_000) * p.input + (200 / 1_000_000) * p.output;
    const costThb = costUsd * fx;
    console.log(
      `  ${model.padEnd(16)}  $${costUsd.toFixed(6)}  ≈  ฿${costThb.toFixed(4)}`,
    );
  }
  console.log();
  console.log('============================================================');
  console.log(' Action items if drift detected:                            ');
  console.log(' 1. Update PRICING table in cost-calculator.ts             ');
  console.log(' 2. Bump "Last reviewed: <today>" comment                  ');
  console.log(' 3. Update OPENAI_USD_TO_THB_FX env if FX changed > 3%     ');
  console.log('============================================================');
}

main();
