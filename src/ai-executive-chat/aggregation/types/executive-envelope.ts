/**
 * Wave 54 — Aggregation Layer Foundation (BE-W54-01).
 *
 * `ExecutiveEnvelope<T>` is the canonical return shape for every Tier C
 * executive tool. The envelope carries:
 *   - a `shape` tag so the LLM can route rendering without hallucinating,
 *   - the populated payload (`data: T`),
 *   - a timestamp (`asOf`),
 *   - a list of dimensions that failed or were unavailable
 *     (`missingDimensions`),
 *   - a required array of server-authored static Thai advisories
 *     (`advisories`, empty array permitted on full-success runs),
 *   - a `partial` flag set whenever `missingDimensions.length > 0`.
 *
 * Shape contract — must match design memo §5.1 verbatim.
 *
 * Rules (design §5.2, preserved here as TSDoc for the implementors of
 * BE-W54-06 / BE-W54-07):
 *
 *   1. The envelope MUST NOT carry raw SQL / TypeORM error messages in
 *      any field. Underlying errors go to server telemetry only. The
 *      `advisories[]` array holds ONLY server-authored static Thai
 *      strings (§17.9 prompt-injection defense).
 *
 *   2. `partial === true` IFF `missingDimensions.length > 0`. The
 *      ResilienceEnvelope service enforces this invariant.
 *
 *   3. Role-check failures throw `ForbiddenException` BEFORE the
 *      envelope is constructed — they never appear in
 *      `missingDimensions` (design §5.2).
 *
 *   4. Schema-validator failures on incoming params are rejected with a
 *      structured 400 by the tool-loop — they never appear here either.
 */
import type { MissingDimension } from './missing-dimension';

/**
 * Envelope `shape` tag. Declared as a union of literals so the LLM-
 * facing output is self-describing without exposing internal class
 * names.
 */
export type ExecutiveEnvelopeShape =
  | 'planOverview'
  | 'dashboardSnapshot'
  | 'crossPlanInsights';

export interface ExecutiveEnvelope<T> {
  /** Rendering-hint tag — see `ExecutiveEnvelopeShape`. */
  shape: ExecutiveEnvelopeShape;

  /** Populated dimensions only — shape is tool-specific. */
  data: T;

  /** ISO timestamp captured when the Tier C handler composed the envelope. */
  asOf: string;

  /**
   * Dimensions that failed or were unavailable by design (e.g.
   * `geo:supplement`). Always an array — `[]` on full-success runs.
   */
  missingDimensions: MissingDimension[];

  /**
   * Server-authored static Thai advisory strings — one entry per
   * dimension that produced an advisory (failure or documented
   * partial, e.g. `geo:supplement`). MUST NOT contain user-controlled
   * text or DB row contents (§17.9).
   *
   * REQUIRED. Full-success runs MUST emit `advisories: []` (empty
   * array) — never omit the field, never set it to `undefined`.
   * Locked 2026-04-24 to align with design memo §5.1 and enable
   * multi-dimension fallback stacking.
   */
  advisories: string[];

  /** TRUE iff `missingDimensions.length > 0`. */
  partial: boolean;
}

/**
 * Per-dimension resolution record produced by
 * `IResilienceEnvelope.runDimensions` (design §5, locked decision
 * §11.2 — 3-second soft timeout, log at WARN/ERROR, surface via
 * `missingDimensions[]`).
 *
 * The envelope service merges these records into the final
 * `ExecutiveEnvelope<T>` — implementers of BE-W54-07 should treat this
 * as the per-dimension handoff contract.
 */
export interface ResilienceDimensionResult<TValue = unknown> {
  /**
   * The dimension key. For schema-authoritative dimensions (budget,
   * status, geo, agency, classification) use the matching
   * `MissingDimension` literal. The `geo:supplement` variant is
   * reserved for GeoEnrichment's SPG-skip path.
   */
  dimension: MissingDimension;

  /** TRUE when the dimension resolved successfully. */
  ok: boolean;

  /**
   * The resolved value on success. Intentionally untyped at this layer
   * — each Tier C tool asserts its own dimension-value contract when
   * assembling `data`.
   */
  value?: TValue;

  /**
   * Server-authored Thai advisory. Populated on failure OR on
   * documented-expected partials (e.g. SPG geo-skip). MUST be static
   * (§17.9).
   */
  advisory?: string;
}
