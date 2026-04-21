/**
 * Feasibility types — Wave 33.6 N1
 *
 * Deterministic, advisory-only types consumed by `FeasibilityGateService`
 * to evaluate whether a (geoFeature, projectType, conflictLevel) triple is
 * physically feasible for AI-generation purposes. When the verdict is
 * `block`, the AI-generate pipeline short-circuits BEFORE any LLM call —
 * no synthesized prose is produced for impossible combos (e.g. a road in
 * the middle of a reservoir polygon).
 *
 * Compliance:
 *   - §17.2 advisory-only — TOOL-BEHAVIOR gate (whether AI emits copy on
 *     this one invocation), NOT a workflow-transition gate. Submit /
 *     approve / reject / pull-back / rollback paths are unaffected.
 *   - §17.3 — no persistence, no FK into project tables, no
 *     TrackingStatus write.
 *   - §17.9 — service-authored Thai literals only; user text never flows
 *     into reason / recommendations.
 *   - §17.11 — no role exemption. Same verdict for every role.
 */

export type FeasibilitySeverity = 'pass' | 'warn' | 'block';

export interface FeasibilityVerdict {
  /** True iff severity !== 'block'. Convenience flag for call sites. */
  isFeasible: boolean;
  severity: FeasibilitySeverity;
  /** Thai prose, sanitized via Wave 31 sanitizer; populated for warn/block. */
  reason?: string;
  /** Thai, each sanitized; typically populated for block. */
  recommendations?: string[];
  /** rule-id for audit/debug, e.g. 'reservoir-vs-road-like'. */
  triggeredRule?: string;
}

export interface FeasibilityInput {
  geoFeature: {
    featureType: string; // e.g. 'reservoir' | 'river' | 'canal' | 'sea'
    nameTh?: string | null;
    featureId?: string | null;
  } | null;
  /** Wave 30 ProjectTypeCode value, e.g. 'road-like'. String-typed for forward-compat. */
  projectType: string;
  conflictLevel: 'none' | 'low' | 'medium' | 'high' | 'unknown';
}

export const FEASIBILITY_RULESET_VERSION = 'wave-33.6-v1';
