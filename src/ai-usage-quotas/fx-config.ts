/**
 * fx-config — USD → THB rate accessor.
 *
 * Resolution order (first hit wins):
 *   1. In-memory cache from the real-time fetcher (P3, 24h TTL) — only
 *      populated when `OPENAI_FX_USE_LIVE === 'true'` and the most
 *      recent `refreshLiveFx()` call succeeded.
 *   2. `OPENAI_USD_TO_THB_FX` env var — operator-pinned override.
 *   3. Static fallback = 34 (preserves legacy behavior; never throws).
 *
 * Fallback discipline (env-var branch):
 *   - unset            → next branch
 *   - non-numeric      → next branch
 *   - zero or negative → next branch
 *
 * The static fallback exists so the cost path NEVER blocks on network
 * I/O. Live-rate misses degrade gracefully to env, then static.
 */

let liveFxCache: { rate: number; fetchedAt: number } | null = null;
const LIVE_FX_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export function getUsdToThbFx(): number {
  // 1. Live cache (P3).
  if (liveFxCache && Date.now() - liveFxCache.fetchedAt < LIVE_FX_TTL_MS) {
    return liveFxCache.rate;
  }
  // 2. Env override.
  const raw = process.env.OPENAI_USD_TO_THB_FX;
  const parsed = raw !== undefined && raw !== '' ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  // 3. Static fallback.
  return 34;
}

/**
 * Fetch latest USD → THB rate from a free public FX API and cache for
 * 24h. Returns the new rate on success; returns `null` on any failure
 * (network, parse, validation) — callers MUST tolerate `null` and let
 * `getUsdToThbFx()` fall back to env / static.
 *
 * Source: open.er-api.com (no API key needed, no rate limit for low
 * volume). Endpoint shape:
 *   GET https://open.er-api.com/v6/latest/USD
 *   → { result: "success", base_code: "USD", rates: { THB: 36.42, ... } }
 *
 * Sanity guard: rejects rates outside [25, 50] to avoid catastrophic
 * mispricing if the API returns garbage (e.g., API outage payload).
 *
 * §17.2 advisory — FX cache miss never blocks an AI call. Per-call
 * lookup in `getUsdToThbFx()` reads the cache atomically; never awaits.
 */
export async function refreshLiveFx(): Promise<number | null> {
  if (process.env.OPENAI_FX_USE_LIVE !== 'true') return null;
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      result?: string;
      rates?: Record<string, number>;
    };
    if (data?.result !== 'success') return null;
    const rate = data?.rates?.THB;
    if (typeof rate !== 'number' || !Number.isFinite(rate)) return null;
    if (rate < 25 || rate > 50) return null; // sanity guard
    liveFxCache = { rate, fetchedAt: Date.now() };
    return rate;
  } catch {
    return null;
  }
}

/** Test-only — clear the cache so unit tests can assert fallback paths. */
export function __resetLiveFxCacheForTests(): void {
  liveFxCache = null;
}
