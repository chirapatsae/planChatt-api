/**
 * Wave 54 — Aggregation Layer Foundation (BE-W54-01).
 *
 * `MissingDimension` enumerates the known runtime failure modes of the
 * multi-source executive engine. When a dimension fails (or is
 * unavailable by design — see `geo:supplement`), the ResilienceEnvelope
 * records the dimension name here and pairs it with a server-authored
 * static Thai advisory string.
 *
 * Shape contract — must match design memo §5.1 verbatim.
 *
 * Defined members:
 *   - `budget`           — BudgetAggregator raised on this run
 *   - `status`           — StatusAggregator raised on this run
 *   - `geo`              — GeoEnrichment raised on this run (amphoe join)
 *   - `geo:supplement`   — SPG rows expected skipped (no amphoe_id col;
 *                          §11.3 locked decision, deferred to Wave 55)
 *   - `agency`           — AgencyEnrichment raised on this run
 *   - `classification`   — ClassificationBranching shape mismatch or
 *                          cross-format groupBy (§16.5 / §17.7)
 *
 * Notes:
 *   - Role-check failure is NOT a dimension. `ForbiddenException` is a
 *     pre-dimension policy gate (design §5.2).
 *   - Schema-validator failures on incoming params are NOT dimensions
 *     either — the tool-loop rejects with a structured 400 (§17.9).
 *   - Advisories accompany these values but live in the envelope
 *     (`advisories: string[]`) — see `ExecutiveEnvelope`.
 */
export type MissingDimension =
  | 'budget'
  | 'status'
  | 'geo'
  | 'geo:supplement'
  | 'agency'
  | 'classification';
