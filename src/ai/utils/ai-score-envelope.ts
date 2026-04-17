/**
 * ai-score-envelope.ts — Canonical AI score envelope types and helpers.
 *
 * Part of the Staff-AI staleness-model foundation (CLAUDE.md §17.4, §17.10).
 *
 * This module is the single source of truth for the AI score envelope
 * shape consumed by both backend controllers and frontend components.
 * Downstream RF2 (diff-aware smart-approve) and RF5 (persisted pre-submit
 * result) import from here.
 *
 * No TypeORM / Nest dependencies. Pure type + pure function.
 */

/**
 * Interpretation band for an AI score (§17.10).
 *   - green ≥ 80
 *   - amber 50..79
 *   - red   < 50
 */
export type AiScoreBand = 'green' | 'amber' | 'red';

/**
 * Per-result staleness policy (§17.4).
 *
 *   - `strict`          : Result is stale when `content_hash` differs from
 *                        the current hash. UI shows a stale banner.
 *                        RF2 (diff-aware smart-approve) uses this.
 *   - `snapshot-only`   : Result is NEVER stale — it is a photograph-at-
 *                        submit-time. `isStale` is forced to `false`.
 *                        RF5 (user-side pre-submit) uses this.
 *   - `warning-only`    : Stale banner shown; no gating. For non-blocking
 *                        hints (future RF3/RF4 style checks).
 */
export type AiStalenessPolicy = 'strict' | 'snapshot-only' | 'warning-only';

/**
 * Target-kind discriminator for AI result rows (§17.3).
 *
 * AI result rows reference a project via `(target_id, target_kind)` WITHOUT
 * a foreign key, so §14.6 rollback hard-deletes do not cascade into AI
 * audit history.
 */
export type AiResultTargetKind =
  | 'project-group'
  | 'revised-project-group'
  | 'supplement-project-group';

/**
 * Canonical AI score envelope consumed by UI surfaces.
 *
 * The shape MUST remain stable — frontend `PreSubmitScoreBadge` and any
 * downstream AI-result endpoint (currently RF5 pre-submit snapshot;
 * RF2 removed in Wave 6) serializes against it.
 */
export interface AiScoreEnvelope {
  /** Normalized score 0..100 (integer). Null when no scored category. */
  score: number | null;
  /** Interpretation band. Null when `score` is null. */
  band: AiScoreBand | null;
  /** ISO-8601 UTC timestamp of the AI run. */
  computedAt: string;
  /** SHA-256 hex of the canonical input hash that produced this result. */
  contentHash: string;
  /** Whether the stored hash differs from the current live hash. */
  isStale: boolean;
  /** Model identifier (e.g. 'gpt-4o'). */
  model: string;
  /** Endpoint path (e.g. 'smart-approve/analyze/revised'). */
  endpoint: string;
  /** Per-result policy driving the `isStale` semantics. */
  stalenessPolicy: AiStalenessPolicy;
  /**
   * Best-effort Thai-labelled list of fields whose current value differs
   * from the stored hash's value. MAY be empty. Only populated when the
   * service can compute a field-level diff.
   */
  changedFields?: string[];
}

/**
 * Build a canonical `AiScoreEnvelope` from stored result fields.
 *
 * This helper is consumed by RF5 (`snapshot-only` policy — `isStale` always
 * forced to `false`) and is also the shape that RF2 should produce with
 * `strict` policy (isStale computed from hash comparison).
 *
 * §17.4 contract:
 *   - `snapshot-only` → `isStale` is forced `false`, regardless of
 *     `storedHash` / `currentHash`.
 *   - `strict`        → `isStale` = (storedHash !== currentHash).
 *   - `warning-only`  → `isStale` = (storedHash !== currentHash), but the
 *                       UI consumer must treat it as advisory.
 */
export function buildAiScoreEnvelope(input: {
  score: number | null;
  band: AiScoreBand | null;
  computedAt: Date | string;
  contentHash: string;
  model: string;
  endpoint: string;
  policy: AiStalenessPolicy;
  currentHash?: string | null;
  changedFields?: string[];
}): AiScoreEnvelope {
  const computedAtIso =
    typeof input.computedAt === 'string'
      ? input.computedAt
      : input.computedAt.toISOString();

  let isStale: boolean;
  if (input.policy === 'snapshot-only') {
    // §17.4 canonical — pre-submit photograph never goes stale.
    isStale = false;
  } else {
    isStale =
      typeof input.currentHash === 'string' &&
      input.currentHash.length > 0 &&
      input.currentHash !== input.contentHash;
  }

  const envelope: AiScoreEnvelope = {
    score: input.score,
    band: input.band,
    computedAt: computedAtIso,
    contentHash: input.contentHash,
    isStale,
    model: input.model,
    endpoint: input.endpoint,
    stalenessPolicy: input.policy,
  };
  if (input.changedFields && input.changedFields.length > 0) {
    envelope.changedFields = input.changedFields;
  }
  return envelope;
}

/**
 * Map a raw score (any numeric value) to its interpretation band.
 *
 * Thresholds per §17.10:
 *   - ≥ 80 → green
 *   - ≥ 50 → amber
 *   - <  50 → red
 *
 * Scores outside 0..100 are clamped before banding. Non-finite numbers
 * fall back to `red` (conservative advisory position).
 */
export function scoreToBand(score: number): AiScoreBand {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'red';
  const clamped = Math.max(0, Math.min(100, score));
  if (clamped >= 80) return 'green';
  if (clamped >= 50) return 'amber';
  return 'red';
}
