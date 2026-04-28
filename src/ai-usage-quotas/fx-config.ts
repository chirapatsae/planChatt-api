/**
 * Wave 44 / BE-W44-03 — single-source FX accessor.
 *
 * Replaces the hardcoded `* 34` USD → THB conversion that was previously
 * inlined in `ai-usage-quotas.service.ts`. Reads
 * `OPENAI_USD_TO_THB_FX` from the environment per request; ops may rotate
 * the rate without a backend restart.
 *
 * Fallback discipline:
 *   - unset            → 34
 *   - non-numeric      → 34
 *   - zero or negative → 34
 *
 * The constant is intentionally NOT cached at module-load; read cost is
 * a single env lookup + Number() and is negligible on the hot path.
 * If profiling ever shows this is expensive, a 5-minute TTL cache is
 * acceptable (task §7.11).
 */
export function getUsdToThbFx(): number {
  const raw = process.env.OPENAI_USD_TO_THB_FX;
  const parsed = raw !== undefined && raw !== '' ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 34;
}
