/**
 * Issue-based criteria type definitions (Wave 24).
 *
 * Source of truth: docs/architecture/ISSUE_BASED_CRITERIA.md §3 (type
 * schema) and §2 (registry taxonomy).
 *
 * Advisory-only per CLAUDE.md §17.2 — these types drive advisory UI
 * chips and prompt injection, NEVER workflow gating. Every evaluation
 * produced using these types is stamped with `rulesetVersion` so old
 * snapshots remain faithful to the regulation version in force at the
 * time they were taken (§17.4 snapshot-only semantics).
 *
 * The shape mirrors the regulation vocabulary directly:
 *   - `IssueRuleEntry` = one logically distinct criteria-set (6 total
 *     in Wave 24: royal / quality-of-life / economic-3-1 /
 *     economic-3-2 / urban-4-1to4 / urban-4-5to6)
 *   - `IssueSubType`   = one sub-category shown in UI
 *   - `IssueCriterion` = one checklist item evaluated per project
 */

/**
 * Province-code discriminator. Closed set — extending requires a new
 * registry sibling file (see architecture §10 extensibility).
 */
export type ProvinceCode = 'NAKHON_RATCHASIMA';

/**
 * Regulatory criticality. Advisory-only at Wave 24 — `blocking` is a
 * UI-severity hint for the reviewer, NOT a submit gate.
 */
export type Criticality = 'blocking' | 'preferred' | 'advisory';

/**
 * Deterministic pre-check type hint. Consumed by the AI pre-check
 * layer (N4) to decide which criterion rows can be resolved without
 * an LLM call. `null` / unset = resolved via LLM only.
 */
export type AutoCheckKind =
  | 'cross-amphoe'
  | 'in-protected-zone'
  | 'attachment-presence'
  | null;

/**
 * One checklist item (criterion) evaluated against a single project.
 */
export interface IssueCriterion {
  /** Stable ID, e.g. `C3_2.c`. Used as verdict key in snapshots. */
  id: string;
  /** Short Thai label for compact UI chips. */
  label: string;
  /** Full verbatim Thai regulation quote (rendered in expand panel). */
  description: string;
  /** 1-5 impact weight. Inputs the overall score; does not gate submit. */
  weight: number;
  /** Severity class. Advisory-only at Wave 24 (§17.2). */
  criticality: Criticality;
  /** Whether the criterion requires an attached evidence document. */
  evidenceRequired: boolean;
  /** OCR / attachment-tag hints for the evidence auto-check layer. */
  evidenceTags?: string[];
  /** Deterministic pre-check hint (geo / attachment). */
  geoAutoCheck?: AutoCheckKind;
  /** Regulation citation(s) shown beside the description in UI. */
  sourceRefs?: string[];
}

/**
 * One sub-category shown beneath the issue in the UI panel.
 * Read-only display data; does not affect validation.
 */
export interface IssueSubType {
  /** e.g. `1.1`, `3.2.1`. Stable within the regulation. */
  code: string;
  label: string;
  // Wave 39 N1 — concrete activity templates per sub-type for the
  // [EXAMPLES] prompt block injected into ISSUE_BASED generate calls.
  // Advisory — LLM uses these as "วัตถุดิบทางเลือก" for drafting, not
  // as mandatory content. 4-6 entries per sub-type; each ≤ 160 chars.
  // Each entry should have at least 3 of 4 specificity attributes:
  //   - activity name (verb + noun)
  //   - location / target group with size
  //   - frequency / duration
  //   - budget hint OR measurement mechanism
  // Entries use interpunct " · " as delimiter between attributes.
  exampleActivities?: string[];
}

/**
 * A registry entry ties one logical criteria-set to one (or more) plan
 * `DevelopmentIssue.name` values within a province. The `matchers`
 * block is how the service resolves a free-text DevelopmentIssue name
 * to the canonical entry — see architecture §3 matching strategy.
 */
export interface IssueRuleEntry {
  provinceCode: ProvinceCode;
  /** Stable ID (kebab-case). Never translated, safe for analytics. */
  issueKey: string;
  /** Thai display name rendered in the UI panel header. */
  issueDisplayName: string;
  /** Plain-Thai descriptions of the project types the issue accepts. */
  characteristics: string[];
  matchers: {
    /** Exact names (post-NFC-normalize, post-trim). */
    exactNames: string[];
    /** Fallback substring tokens for minor Thai spelling variance. */
    keywordContains: string[];
  };
  subTypes: IssueSubType[];
  criteria: IssueCriterion[];
  /** Regulation revision stamp ('2026-04-18' for Wave 24). */
  rulesetVersion: string;
  /** Regulation citations / doc links rendered in UI footer. */
  sourceRefs: string[];
}

// ---------------------------------------------------------------------------
// Wave 24 N4 — response-fragment types carried inside the opaque
// `categories.criteriaEvaluation` bag on the pre-submit review response.
//
// Advisory-only per CLAUDE.md §17.2 — these types are presentational and
// MUST NOT drive workflow transitions. Every shape carries enough metadata
// for §17.10 five-element UI rendering (value, band, staleness, timestamp,
// endpoint provenance) when paired with the envelope produced by
// `AiResultEnvelopeService`.
// ---------------------------------------------------------------------------

/**
 * Per-criterion verdict emitted by the AI pre-submit review path.
 *
 * - `pass` — criterion satisfied
 * - `fail` — criterion affirmatively not satisfied (staff signal only — no
 *            workflow block; §17.2)
 * - `needs-evidence` — cannot confirm without additional documentation
 * - `not-applicable` — criterion does not apply to this project flavor
 */
export type CriterionVerdict =
  | 'pass'
  | 'fail'
  | 'needs-evidence'
  | 'not-applicable';

/**
 * Provenance of the verdict. The service FORCIBLY assigns this value —
 * the LLM is not trusted to claim `geo-auto` or `evidence-auto` to
 * prevent prompt-injection from escalating source trust (§17.9).
 */
export type CriterionSource = 'geo-auto' | 'evidence-auto' | 'llm';

/**
 * One row in the final response. `rationale` is short Thai; UI renders
 * it beside the chip. `evidenceLink` is populated ONLY for
 * `evidence-auto` passes when the matched attachment has an id we can
 * surface; link format is app-relative (never a raw S3 URL per §17.9).
 */
export interface CriterionResult {
  criterionId: string;
  label: string;
  verdict: CriterionVerdict;
  rationale: string;
  source: CriterionSource;
  evidenceLink?: string | null;
}

/**
 * Full payload embedded under `categories.criteriaEvaluation` on the
 * pre-submit review response. Persists through Wave 13's opaque
 * `result_json` / `categories_json` storage without any DTO change.
 */
export interface CriteriaEvaluationPayload {
  rulesetVersion: string;
  provinceCode: ProvinceCode;
  issueKey: string;
  results: CriterionResult[];
  overallAlignment: 'aligned' | 'partially-aligned' | 'misaligned';
  /**
   * Wave 28 N1 — OPTIONAL advisory metadata used by the FE to highlight
   * which sub-type / criteria were cited in the rationale. Rides inside
   * the existing Wave 13 opaque `categories` envelope; it is NOT a new
   * top-level DTO field and does NOT require a schema migration.
   *
   * Validation discipline: payloads that OMIT `rationaleRefs` MUST
   * validate successfully (backward compatible). Payloads that include
   * it are advisory-only per §17.2 — the FE MAY use it for chip
   * highlighting but MUST NOT treat it as a workflow gate.
   *
   * Shape is intentionally loose (all fields optional) so the LLM can
   * populate any subset without triggering §17.9 schema drift. The
   * service layer MAY additionally sanitize `criterionIds` against the
   * registry whitelist before returning it to the caller.
   */
  rationaleRefs?: {
    issueKey?: string;
    subTypeCode?: string;
    criterionIds?: string[];
  };
}

/**
 * Deterministic pre-check hint produced BEFORE the LLM call. The
 * `source` here lives on the resulting `CriterionResult`, not on the
 * hint itself — the hint only carries WHAT the deterministic signal
 * said. The service merges this into the LLM output with documented
 * precedence rules (architecture §7 / §8).
 */
export interface CriterionHint {
  criterionId: string;
  suggestedVerdict: CriterionVerdict;
  reason: string;
  evidenceLink?: string | null;
  /**
   * Which deterministic layer produced this hint. Drives the forced
   * `source` value on the final result (`geo-auto` / `evidence-auto`).
   */
  kind: 'geo-auto' | 'evidence-auto';
  /**
   * When the hint is `evidence-auto` + `needs-evidence`, the LLM is
   * allowed to override with quoted counter-evidence (architecture §8).
   * When the hint is `geo-auto`, the hint is authoritative (pre-check
   * wins). This flag encodes the precedence rule for the merger.
   */
  hardOverride: boolean;
}
