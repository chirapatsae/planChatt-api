/**
 * AI Cooldown Store — per CLAUDE.md §17.8 (AI-Assist Rule — cooldown canon).
 *
 * Scope:
 *   - Tracks active cooldown windows for AI smart-approve style endpoints.
 *   - Key shape (see AiCooldownGuard): `${endpointKey}|${actorId}|${targetId}`.
 *   - Storage is in-memory and ephemeral by design (§17.3: no tracking_status
 *     write, and per the task file no DB migration).
 *
 * Hard guardrails (CLAUDE.md §17.8):
 *   - Only 2xx responses arm the cooldown. 5xx MUST NOT arm.
 *     (Enforced in the guard, not here — the store only records when told.)
 *   - Cooldown window is time-scoped; there is no "stale" concept.
 *
 * Boundedness:
 *   - Memory store caps at MEMORY_CAPACITY entries using approximate LRU
 *     eviction: re-ordering on set/get via Map's insertion-order iteration.
 *
 * Redis backend is an interface-compatible stub; the env flag is read in the
 * provider factory. Not wired to a live client by default.
 *
 * No imports of tracking-status / project-group / revised-project-group /
 * development-plan entities — by task contract.
 */

export const AI_COOLDOWN_STORE = Symbol('AI_COOLDOWN_STORE');

export interface AiCooldownStore {
  /**
   * Returns the expiresAt (ms since epoch) for an active cooldown, or null
   * when no active cooldown is recorded. Entries whose window has already
   * elapsed are treated as absent and MAY be evicted opportunistically.
   */
  get(key: string): Promise<number | null>;

  /**
   * Record a new cooldown window. `expiresAt` is milliseconds since epoch.
   */
  set(key: string, expiresAt: number): Promise<void>;

  /**
   * Remove a cooldown entry. Idempotent.
   */
  delete(key: string): Promise<void>;
}

/**
 * In-memory LRU-ish implementation.
 *
 * Capacity is bounded at 10 000 entries to prevent runaway memory growth if
 * the key space accidentally explodes (e.g. someone decorates an endpoint
 * that varies by a high-cardinality field). On overflow, the oldest entry
 * by insertion order is evicted. Map preserves insertion order in JS, so
 * this yields approximate LRU when callers re-insert on access (which the
 * guard does via `set` at the end of a 2xx response).
 */
export class InMemoryAiCooldownStore implements AiCooldownStore {
  static readonly MEMORY_CAPACITY = 10_000;

  private readonly store = new Map<string, number>();

  async get(key: string): Promise<number | null> {
    const expiresAt = this.store.get(key);
    if (expiresAt === undefined) return null;
    if (expiresAt <= Date.now()) {
      // Lazy eviction of expired entries.
      this.store.delete(key);
      return null;
    }
    return expiresAt;
  }

  async set(key: string, expiresAt: number): Promise<void> {
    // Refresh insertion order for approximate LRU semantics.
    if (this.store.has(key)) {
      this.store.delete(key);
    }
    this.store.set(key, expiresAt);

    // Bound capacity.
    while (this.store.size > InMemoryAiCooldownStore.MEMORY_CAPACITY) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) break;
      this.store.delete(oldestKey);
    }
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  /** Test helper — reset the whole store. NOT for production use. */
  _reset(): void {
    this.store.clear();
  }

  /** Test helper — current entry count. */
  _size(): number {
    return this.store.size;
  }
}

/**
 * Redis-backed stub. Interface-compatible placeholder for future activation
 * via `AI_COOLDOWN_BACKEND=redis`. Falls back to memory when instantiated
 * without a live client.
 *
 * Intentionally NOT wired to ioredis to avoid adding a runtime dependency
 * before the Redis rollout is green-lit. When enabled, replace the inner
 * store with a real SET PX client call.
 */
export class RedisAiCooldownStoreStub implements AiCooldownStore {
  private readonly fallback = new InMemoryAiCooldownStore();

  async get(key: string): Promise<number | null> {
    return this.fallback.get(key);
  }

  async set(key: string, expiresAt: number): Promise<void> {
    return this.fallback.set(key, expiresAt);
  }

  async delete(key: string): Promise<void> {
    return this.fallback.delete(key);
  }
}

/**
 * Provider factory. Reads AI_COOLDOWN_BACKEND to decide.
 * Default: memory.
 */
export function createAiCooldownStore(): AiCooldownStore {
  const backend = (process.env.AI_COOLDOWN_BACKEND || 'memory').toLowerCase();
  if (backend === 'redis') {
    return new RedisAiCooldownStoreStub();
  }
  return new InMemoryAiCooldownStore();
}
