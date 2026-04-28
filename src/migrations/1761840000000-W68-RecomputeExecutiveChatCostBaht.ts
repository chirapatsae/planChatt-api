import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * W68-FIX-01 (2026-04-28) — Historical backfill for under-charged
 * executive-chat `cost_bath` rows.
 *
 * Why this exists
 * ---------------
 * Before W68-FIX-01, `AiExecutiveChatService.deductPostTurnUsage`
 * computed `costUsd = (meta.hops || 1) * PER_HOP_ESTIMATE_THB * 0.03`
 * — a hop-based estimate that ignored real OpenAI token counts. For a
 * typical 2-hop turn this yields ~$0.01 USD → ฿0.34 at FX=34, regardless
 * of how many tokens were actually consumed. The user-reported reference
 * case (47954 input / 249 output / `gpt-4o`) was billed at ฿0.34 instead
 * of the correct ฿4.16 — a 12.24× under-charge.
 *
 * The code-level fix lands in the service file (`calculateAiCost(model,
 * usage)`, matching every other `checkAndLogUsage` caller in the
 * codebase). This migration repairs the historical `ai_usage_logs` rows
 * so analytics, billing reconciliation, and admin dashboards observe
 * truthful cost data.
 *
 * Scope
 * -----
 * - Touches `ai_usage_logs.cost_bath` for `usage_type = 'executive-chat'`
 *   rows ONLY.
 * - Does NOT touch `ai_usage_quotas.quota_used` per W68 user direction
 *   Q2=B: do not retroactively penalize users for a system-side bug. The
 *   accounting view is corrected; the quota balance view is preserved.
 * - Does NOT touch `tracking_status` (§17.3 audit separation).
 * - Does NOT touch `ai_executive_messages` rows (only the usage log).
 *
 * FX rate
 * -------
 * Reads `OPENAI_USD_TO_THB_FX` from the environment at migration runtime
 * (default 34 if unset / invalid). This mirrors the runtime FX accessor
 * in `src/ai-usage-quotas/fx-config.ts`. The FX value used is logged for
 * audit; ops should snapshot the value at the time of `up()` execution.
 *
 * Idempotency
 * -----------
 * Re-running the migration produces zero changes by construction: the
 * recomputed value is deterministic from `(input_tokens, output_tokens,
 * model_name, FX)`. If a row already carries the correct cost, the
 * UPDATE is a self-assignment (Postgres still touches the row, but the
 * effective state is unchanged).
 *
 * Down migration
 * --------------
 * The original buggy formula depended on the per-turn `hops` value,
 * which was NEVER persisted to `ai_usage_logs`. Therefore an exact
 * reverse-restore is impossible without re-deriving hops from
 * `ai_executive_messages` row counts per turn — out of scope for a
 * historical correction. `down()` is a no-op with this caveat
 * documented inline.
 *
 * Cited §§:
 *   §12   — audit history preserved; no tracking_status writes.
 *   §17.2 — advisory; cost tracking does NOT gate workflow.
 *   §17.3 — AI audit separation; FK-free, project tables untouched.
 *   §17.11 — no role exemption; this is integrity, not permission.
 */
export class W68RecomputeExecutiveChatCostBaht1761840000000
  implements MigrationInterface
{
  name = 'W68RecomputeExecutiveChatCostBaht1761840000000';

  /**
   * Embedded pricing constants — matches `src/ai/utils/cost-calculator.ts`.
   * Migrations are intentionally self-contained and MUST NOT import the
   * runtime helper (the helper may evolve; the migration must reflect
   * the pricing as it was when the migration was authored).
   *
   * Units: USD per 1,000,000 tokens.
   */
  private static readonly PRICING: Record<
    string,
    { input: number; output: number }
  > = {
    'gpt-4o': { input: 2.5, output: 10.0 },
    'gpt-4o-mini': { input: 0.15, output: 0.6 },
  };

  /**
   * Resolve FX from env at migration runtime. Mirrors `getUsdToThbFx` in
   * `src/ai-usage-quotas/fx-config.ts` so the migration uses the same
   * fallback discipline (unset / non-numeric / non-positive → 34).
   */
  private static resolveFx(): number {
    const raw = process.env.OPENAI_USD_TO_THB_FX;
    const parsed = raw !== undefined && raw !== '' ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 34;
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    const fx = W68RecomputeExecutiveChatCostBaht1761840000000.resolveFx();
    const pricing = W68RecomputeExecutiveChatCostBaht1761840000000.PRICING;

    // eslint-disable-next-line no-console
    console.log(
      `[W68-FIX-01] Recomputing ai_usage_logs.cost_bath for executive-chat ` +
        `rows. FX = ${fx} THB/USD. Pricing: ${JSON.stringify(pricing)}.`,
    );

    // Per-model UPDATE — one statement per supported model. Each statement
    // is fully self-contained and uses parameterised numerics. Rows
    // whose model is NOT in the pricing table are skipped (logged
    // afterwards). This avoids accidentally zero-ing a row written under
    // a future model not yet in the pricing constants.
    let totalRowsUpdated = 0;

    for (const [modelName, rates] of Object.entries(pricing)) {
      // Recompute formula:
      //   cost_bath = ((input * input_rate + output * output_rate) / 1e6) * fx
      //
      // CRITICAL: we do NOT filter out rows that already match the
      // recomputed value. Postgres handles the no-op write efficiently,
      // and the explicit unconditional UPDATE makes the operation
      // trivially idempotent (re-running converges to the same state).
      const result = await queryRunner.query(
        `
        UPDATE "ai_usage_logs"
           SET "cost_bath" = ROUND(
             (
               ("input_tokens"::numeric  * $1::numeric
              + "output_tokens"::numeric * $2::numeric)
               / 1000000.0
             ) * $3::numeric,
             4
           )
         WHERE "usage_type" = 'executive-chat'
           AND "model_name" = $4
           AND "input_tokens" > 0
        `,
        [rates.input, rates.output, fx, modelName],
      );

      // pg driver returns rowCount on the QueryResult-shaped second elem.
      // typeorm flavour returns an array; we defensively read from
      // `rowCount` if present, else inspect length. Counts are advisory
      // only (logged) — they do NOT affect migration correctness.
      const updated =
        (Array.isArray(result) && typeof (result as any)[1] === 'number'
          ? (result as any)[1]
          : (result as any)?.rowCount) ?? 0;

      // eslint-disable-next-line no-console
      console.log(
        `[W68-FIX-01] model=${modelName} rows_updated=${updated} ` +
          `input_rate=${rates.input}/1M output_rate=${rates.output}/1M`,
      );
      totalRowsUpdated += Number(updated) || 0;
    }

    // Diagnostic: count executive-chat rows with a model_name OUTSIDE
    // the pricing table. Those rows were NOT touched. Operators should
    // investigate manually if the count is non-zero.
    const skippedRows = await queryRunner.query(
      `
      SELECT COUNT(*)::int AS cnt, "model_name"
        FROM "ai_usage_logs"
       WHERE "usage_type" = 'executive-chat'
         AND "input_tokens" > 0
         AND "model_name" IS NOT NULL
         AND "model_name" NOT IN (${Object.keys(pricing)
           .map((_, i) => `$${i + 1}`)
           .join(', ')})
       GROUP BY "model_name"
      `,
      Object.keys(pricing),
    );

    if (Array.isArray(skippedRows) && skippedRows.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[W68-FIX-01] WARNING: ${skippedRows.length} model(s) were not ` +
          `in the pricing table. Rows left untouched. Manual review ` +
          `recommended:`,
        skippedRows,
      );
    }

    // Diagnostic: count executive-chat rows with NULL model_name OR
    // input_tokens = 0. These rows are skipped by design (cannot
    // recompute without inputs) and are reported for completeness.
    const ineligibleRows = await queryRunner.query(
      `
      SELECT COUNT(*)::int AS cnt
        FROM "ai_usage_logs"
       WHERE "usage_type" = 'executive-chat'
         AND ("model_name" IS NULL OR "input_tokens" = 0)
      `,
    );

    // eslint-disable-next-line no-console
    console.log(
      `[W68-FIX-01] Migration complete. total_rows_updated=${totalRowsUpdated}. ` +
        `ineligible_rows=${JSON.stringify(ineligibleRows)}. ` +
        `Quota balances (ai_usage_quotas.quota_used) NOT modified per ` +
        `W68 user direction Q2=B.`,
    );
  }

  public async down(): Promise<void> {
    // Intentional no-op.
    //
    // The original under-charged value was computed from per-turn `hops`
    // (a runtime-only datum NEVER persisted to `ai_usage_logs`).
    // Recovering exact pre-W68 values would require reconstructing the
    // hop count per turn from `ai_executive_messages` row counts, which
    // is brittle and out of scope for an accounting-correction
    // migration.
    //
    // If a rollback is genuinely needed, ops should restore from a
    // pre-migration snapshot of `ai_usage_logs.cost_bath`.
    //
    // §12 audit preservation note: this asymmetry is acceptable because
    // the corrected values are MORE truthful than the originals; a
    // forensic review would prefer the recomputed numbers regardless.
    // eslint-disable-next-line no-console
    console.log(
      '[W68-FIX-01] down() is a no-op — see migration header for rationale.',
    );
  }
}
