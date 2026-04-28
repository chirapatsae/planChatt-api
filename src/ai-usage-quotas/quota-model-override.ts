import { QuotaWeightModel } from './quota-weight.map';

/**
 * Wave 44 / BE-W44-03 — auto-downgrade helper (task §7.10).
 *
 * Rule: when a user's consumed ratio is ≥ 0.80 (i.e. ≤ 20 % of quota
 * remains), EVERY AI call for that user is forced onto a cheap fallback
 * model regardless of the weight map's declared model. Below the
 * threshold, the declared model is honored.
 *
 * W68-FIX-08 (2026-04-28) — fallback target switched
 * `'gpt-4o-mini'` → `'gpt-4.1-nano'`. Rationale:
 *   - gpt-4.1-nano is $0.10 / $0.40 per 1M (4× cheaper than 4o-mini).
 *   - gpt-4.1-nano has 400k TPM (vs 4o-mini's 200k) so a downgraded
 *     turn never re-introduces the rate-limit ceiling that pushed
 *     us off gpt-4o in the first place.
 *   - Aligns the downgrade family with the new executive-chat default
 *     (`gpt-4.1-mini`); the mini → nano drop is the natural step
 *     within the 4.1 family.
 *
 * Called by:
 *   - `AiQuotaGuard.canActivate` — writes the resolved model to
 *     `request.aiModelOverride` for downstream services to read.
 *   - `LlmToolLoopAdapter` (BE-W44-02) — re-evaluates between hops so
 *     a turn MAY start on the declared model and downgrade mid-turn
 *     once cumulative spend pushes past 80 %.
 *
 * Pure function; no I/O; unit-testable at boundary points (0.0 / 0.79
 * / 0.80 / 0.99).
 *
 * @param consumedRatio `quotaUsed / quotaLimit`. Guard guarantees this
 *   is finite and in `[0, 1)` at the call site — values ≥ 1.0 are
 *   unreachable because the guard rejects with 429 first.
 * @param declaredModel the weight map's declared model for the endpoint.
 */
export function resolveModel(
  consumedRatio: number,
  declaredModel: QuotaWeightModel,
): QuotaWeightModel {
  if (!Number.isFinite(consumedRatio)) return declaredModel;
  if (consumedRatio >= 0.8) return 'gpt-4.1-nano';
  return declaredModel;
}
