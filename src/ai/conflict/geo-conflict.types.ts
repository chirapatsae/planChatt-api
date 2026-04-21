/**
 * GeoConflict types — Wave 30 N1
 *
 * Deterministic, advisory-only types consumed by `GeoConflictService`
 * to assess feature-vs-project-type conflicts (e.g. reservoir pin +
 * road-like project). Advisory per CLAUDE.md §17.2 — never gates
 * any workflow transition. No persistence (§17.3).
 */

export type ConflictLevel = 'low' | 'medium' | 'high' | 'none';

/**
 * Canonical project-type codes derived from the LAO ISSUE_BASED
 * sub-type catalogue (`nakhon-ratchasima-issue-rules.ts`). See
 * `SUBTYPE_TO_PROJECT_TYPE` in `geo-conflict-rules.ts` for the
 * sub-type → project-type mapping. Unmapped sub-types resolve to
 * `'unknown'` (conservative — no conflict claim without context).
 */
export type ProjectTypeCode =
  | 'road-like'
  | 'building-like'
  | 'water-supply'
  | 'irrigation-like'
  | 'drainage'
  | 'agriculture-support'
  | 'public-facility'
  | 'environmental'
  | 'unknown';

export type GeoFeatureType = 'reservoir' | 'river' | 'canal';

export interface GeoAnalysisInput {
  geoFeature: {
    featureType: GeoFeatureType;
    nameTh: string;
    featureId: string;
  };
  projectType: ProjectTypeCode;
}

export interface GeoAnalysisResult {
  /** Copied from input.geoFeature.featureType. */
  featureType: string;
  projectType: ProjectTypeCode;
  conflictLevel: ConflictLevel;
  /** Thai, 1-3 items (6-item safety cap; generally 1-3). */
  reasons: string[];
  /** Thai, 1-3 items (6-item safety cap). */
  recommendations: string[];
  /** Audit breadcrumb — not persisted. */
  rulesetVersion: string;
}
