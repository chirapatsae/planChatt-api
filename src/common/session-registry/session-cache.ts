/**
 * SessionCache — a tiny in-process TTL cache for per-session (`sid`) revocation
 * state, shared (as CODE, not as a singleton instance) by the citizen + staff
 * `SessionRegistryService`s (login-alerts / device-session-management, Batch 1).
 *
 * Each registry service owns its OWN `SessionCache` instance so the citizen /
 * staff boundaries never share memory or a Map (§17.3 spirit — no cross-cohort
 * coupling). The cache stores only the minimum needed to authorize a request
 * without a DB round-trip: `{ revokedAt, expiresAt, cachedAt }` keyed by `sid`.
 *
 * TTL semantics: an entry is considered fresh for `ttlMs` (default 30s) after
 * `cachedAt`. Past that, `get()` evicts and returns `undefined` so the caller
 * falls back to a single indexed PK lookup (which re-populates the cache). This
 * bounds revocation latency to at most `ttlMs` while keeping the hot path
 * write-free (see `touchLastSeen` for the throttled last-seen update).
 *
 * NOT a Nest provider — a plain class so it can be `new`-ed privately inside
 * each service without DI wiring or accidental cross-module sharing.
 */
export interface SessionCacheEntry {
  /** epoch ms of revocation, or null if the session is still active. */
  revokedAt: number | null;
  /** epoch ms at which the session expires. */
  expiresAt: number;
  /** epoch ms this entry was cached (freshness anchor). */
  cachedAt: number;
}

export class SessionCache {
  private readonly ttlMs: number;
  private readonly map = new Map<string, SessionCacheEntry>();

  constructor(ttlMs = 30_000) {
    this.ttlMs = ttlMs;
  }

  /** Fresh entry or `undefined` (miss / stale — stale entries are evicted). */
  get(sid: string): SessionCacheEntry | undefined {
    const entry = this.map.get(sid);
    if (!entry) return undefined;
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.map.delete(sid);
      return undefined;
    }
    return entry;
  }

  set(sid: string, entry: SessionCacheEntry): void {
    this.map.set(sid, entry);
  }

  /** Evict a single sid (called after revoke so the next request re-loads). */
  bust(sid: string): void {
    this.map.delete(sid);
  }
}
