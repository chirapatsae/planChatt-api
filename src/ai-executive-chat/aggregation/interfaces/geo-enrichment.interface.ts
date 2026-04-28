/**
 * Wave 54 — Aggregation Layer Foundation (BE-W54-01).
 *
 * `IGeoEnrichment` annotates a `UnifiedProject[]` batch with amphoe
 * name resolution via `Amphoe` LEFT JOIN.
 *
 * Contract rules (BE-W54-05 implementor):
 *   - READ-only.
 *   - main + revised only. Supplement rows have NO `amphoe_id` column
 *     (locked decision §11.3 — deferred to Wave 55). When the batch
 *     contains supplement rows AND `includeGeo === true`, the service
 *     MUST record:
 *         missingDimensions: ['geo:supplement']
 *         advisory          : (static Thai string per design §5.3)
 *   - Uses repository metadata resolution only (never raw SQL table
 *     literals).
 *
 * Return contract: returns a per-run result (see
 * `GeoEnrichmentResult`) rather than mutating the input. BE-W54-07
 * ResilienceEnvelope merges the result into the envelope payload.
 *
 * CLAUDE.md references:
 *   - §13 Geolocation warning — this is the EXECUTIVE-view enrichment,
 *     NOT the LAO-only submit warning. Read-only, advisory-only.
 *   - §17.2 Advisory-only.
 */
import type { MissingDimension, UnifiedProject } from '../types';

export interface AmphoeLabel {
  /** Amphoe FK id (as stored on the row). Null when unresolved. */
  amphoeId: number | null;
  /** Thai amphoe name. Null when unresolved (never an empty string). */
  amphoeName: string | null;
}

export interface GeoEnrichmentResult {
  /**
   * Per-row amphoe label keyed by `projectId`. Callers should treat a
   * missing key as "no geo data for this row".
   */
  labels: Map<string, AmphoeLabel>;

  /**
   * Dimensions that were expected-missing or failed for this run.
   * SPG rows always contribute `'geo:supplement'`.
   */
  missingDimensions: MissingDimension[];

  /**
   * Server-authored Thai advisory strings (§17.9 static, non-
   * interpolated). May be `[]` on full-success runs.
   */
  advisories: string[];
}

export interface IGeoEnrichment {
  annotate(projects: UnifiedProject[]): Promise<GeoEnrichmentResult>;
}
