/**
 * Wave 44 / BE-W44-03 — central weight table for the pre-call
 * `AiQuotaGuard`.
 *
 * Semantics:
 *   - `estMinThb` — pre-call REJECT threshold. If the user's remaining
 *     quota (THB) is below this, the guard throws 429 BEFORE the LLM
 *     call. This is a heuristic floor; real deduction happens post-hoc
 *     in `AiUsageQuotasService.checkAndLogUsage` using actual token
 *     usage. The guard is a safety net to prevent pathological
 *     over-spend, NOT an accurate reservation.
 *   - `estMaxThb` — documentation only. Helps ops tune `estMinThb` when
 *     OpenAI pricing shifts. NOT enforced.
 *   - `model` — default model for this endpoint. §7.10 auto-downgrade
 *     may override this when the caller has used ≥ 80 % of their quota.
 *     For executive-chat (W68-FIX-08) the downgrade target is
 *     `'gpt-4.1-nano'`; legacy gpt-4o endpoints still downgrade to
 *     `'gpt-4o-mini'` per their own configuration. The guard writes
 *     the resolved model to `request.aiModelOverride`.
 *
 * Estimates are in THB at the repository FX baseline (34 THB / USD).
 * Dollar-equivalents are documented alongside so changes to the weight
 * table remain auditable.
 */
// W68-FIX-08 (2026-04-28) — extended union to include the gpt-4.1 family
// (executive-chat default flipped to 'gpt-4.1-mini'; auto-downgrade
// target flipped to 'gpt-4.1-nano'). The legacy gpt-4o / gpt-4o-mini
// strings remain valid because (a) auto-title (Wave 51) still uses
// gpt-4o-mini, (b) historical ai_usage_logs rows reference them, and
// (c) other endpoints in this map still route to gpt-4o.
export type QuotaWeightModel =
  | 'gpt-4o'
  | 'gpt-4o-mini'
  | 'gpt-4.1'
  | 'gpt-4.1-mini'
  | 'gpt-4.1-nano';

export interface QuotaWeight {
  /** Reject pre-call when remainingQuota < estMinThb. */
  estMinThb: number;
  /** Documentation-only ceiling; not enforced. */
  estMaxThb: number;
  /** Default model. May be auto-downgraded at ≥80 % consumed (target
   *  depends on declared model — see `resolveModel`). */
  model: QuotaWeightModel;
  /** Optional per-turn hop ceiling (executive-chat). */
  maxHops?: number;
}

export const QUOTA_WEIGHT_MAP: Record<string, QuotaWeight> = {
  'generate-project-detail': { estMinThb: 0.50, estMaxThb: 3.00, model: 'gpt-4o' },
  'regenerate-one-field':    { estMinThb: 0.10, estMaxThb: 0.60, model: 'gpt-4o' },
  'pre-submit-review':       { estMinThb: 0.20, estMaxThb: 1.50, model: 'gpt-4o' },
  'staff-review-analyze':    { estMinThb: 0.20, estMaxThb: 1.50, model: 'gpt-4o' },
  'prompt-suggestions':      { estMinThb: 0.05, estMaxThb: 0.15, model: 'gpt-4o' },
  'document-summary':        { estMinThb: 0.30, estMaxThb: 2.00, model: 'gpt-4o-mini' },
  'land-use-classify':       { estMinThb: 0.02, estMaxThb: 0.10, model: 'gpt-4o-mini' },
  // Executive-chat: worst-case 6 hops in a single turn (BE-W44-02 tool loop).
  // W68-FIX-08 (2026-04-28) — switched 'gpt-4o' → 'gpt-4.1-mini'.
  // gpt-4o hit 30k TPM ceiling at hop 2 of multi-tool loops; gpt-4.1-mini
  // has 200k+ TPM, is 6× cheaper ($0.40 in / $1.60 out vs $2.50 / $10.00),
  // exposes a 1M token context window, and instruction-following quality
  // is close to gpt-4o (much better than 4o-mini, which regressed in
  // W68-FIX-04 tests). The auto-downgrade target also moved from
  // 'gpt-4o-mini' → 'gpt-4.1-nano' (see quota-model-override.ts).
  //
  // Historical ledger:
  //   W68-FIX-02 — first attempt: 'gpt-4o' → 'gpt-4o-mini'. Reverted by
  //                W68-FIX-04 because mini regressed agency filtering,
  //                classification labels, and multi-rule prompts.
  //   W68-FIX-04 — REVERT to 'gpt-4o' while ops requested higher TPM.
  //   W68-FIX-08 — present switch to 'gpt-4.1-mini'.
  //
  // Token-budget reductions from W68-FIX-02 (TOOL_RESULT_MAX_BYTES
  // 8KB→4KB; CONTEXT_MESSAGE_CAP 20→8) STAY — they reduce per-request
  // load regardless of model.
  //
  // This map is the SINGLE SOURCE OF TRUTH for default model: AiQuotaGuard
  // reads it and writes `request.aiModelOverride`, which the controller
  // forwards to the service. The service-side fallback in
  // ai-executive-chat.service.ts is only used when the override
  // is absent, which never happens in the controller-driven path.
  'executive-chat':          { estMinThb: 1.00, estMaxThb: 10.00, model: 'gpt-4.1-mini', maxHops: 6 },
  // Wave 51 / BE-W51-02 — server-initiated auto-title generator. Does NOT
  // go through `AiQuotaGuard` (no HTTP request path), so this entry is
  // documentation-only: it pins the endpoint key string and the model the
  // call uses. Real cost is deducted post-call via
  // `AiUsageQuotasService.checkAndLogUsage({ usageType: 'executive-chat-autotitle' })`.
  // §17.8 — this entry does NOT arm the user-facing `executive-chat`
  // cooldown bucket; the cooldown key is keyed on the endpoint string,
  // which is distinct here.
  'executive-chat-autotitle': { estMinThb: 0.01, estMaxThb: 0.05, model: 'gpt-4o-mini' },
};

/**
 * Lookup helper used by the guard and by the per-hop mid-turn check.
 * Returns `null` for unknown keys so callers can decide whether to
 * throw `QUOTA_WEIGHT_UNKNOWN` (guard) or skip (mid-turn adapter).
 */
export function getQuotaWeight(weightKey: string): QuotaWeight | null {
  return QUOTA_WEIGHT_MAP[weightKey] ?? null;
}
