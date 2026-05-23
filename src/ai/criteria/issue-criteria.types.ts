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
 *
 * Wave AI-Enforcement-Model (2026-05-22) — added `'title-uniqueness'`
 * for the "ไม่ซ้ำซ้อนกับภารกิจของ อปท. อื่น" family of criteria. The
 * check queries the ProjectGroup repository for same-title projects
 * (excluding self) and emits a deterministic verdict — AI never sees
 * the criterion in its prompt.
 */
export type AutoCheckKind =
  | 'cross-amphoe'
  | 'in-protected-zone'
  | 'attachment-presence'
  | 'title-uniqueness'
  | null;

/**
 * Wave AI-Enforcement-Model (2026-05-22) — enforcement classification
 * for a single criterion. Drives WHO produces the verdict:
 *
 *   - `llm-prose`   AI judges from generated prose (e.g. "คุ้มค่า",
 *                   "ดำเนินการในภาพรวมจังหวัด/อำเภอ"). This is the
 *                   ONLY mode that participates in the LLM call's
 *                   [CRITERIA] section.
 *
 *   - `auto-check`  Deterministic system check resolves the verdict
 *                   without LLM involvement (geo polygon, attachment
 *                   presence, title uniqueness). The corresponding
 *                   `geoAutoCheck` kind picks the service.
 *
 *   - `auto-pass`   Implicit by system inclusion — e.g. "อปท. ในพื้นที่
 *                   ดำเนินการเองไม่ได้" is implied for every project
 *                   that enters this coordination system. Force
 *                   verdict='pass' with the criterion's
 *                   `autoPassRationale` string. AI MUST NOT judge.
 *
 *   - `staff-only`  Out of AI's domain expertise (engineering
 *                   standards, legal compliance, attached-document
 *                   review). AI MUST NOT judge — force verdict
 *                   ='not-applicable' with rationale pointing to
 *                   staff review.
 *
 * §17.2 — all four modes remain advisory; never gates workflow.
 * §17.14 — registry stays bound to LAO-coordination scope.
 */
export type CriterionEnforcement =
  | 'llm-prose'
  | 'auto-check'
  | 'auto-pass'
  | 'staff-only';

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
  /** Deterministic pre-check hint (geo / attachment / title). */
  geoAutoCheck?: AutoCheckKind;
  /** Regulation citation(s) shown beside the description in UI. */
  sourceRefs?: string[];
  /**
   * Wave AI-Enforcement-Model (2026-05-22) — required classification.
   * Drives WHO produces the verdict. See `CriterionEnforcement` for
   * the full rationale of each mode. The AI service uses this field
   * to:
   *   1. Filter which criteria enter the LLM prompt (`llm-prose` only)
   *   2. Apply deterministic verdicts for `auto-check` (via service)
   *   3. Force pass verdicts for `auto-pass` (with `autoPassRationale`)
   *   4. Force not-applicable verdicts for `staff-only`
   */
  enforcement: CriterionEnforcement;
  /**
   * Thai rationale shown on the criteria card when verdict is forced
   * to `pass` via `enforcement: 'auto-pass'`. REQUIRED for auto-pass
   * criteria; ignored for other enforcement modes.
   */
  autoPassRationale?: string;
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
  /**
   * Wave AI-Enforcement-Model (2026-05-22) — mirror of the registry
   * criterion's `enforcement` so the FE can render an authoritative
   * "who decided this" badge without inferring from `source`. Optional
   * to preserve back-compat with stored snapshots written before this
   * wave (they carry no enforcement field; FE treats absent as 'llm-
   * prose' for visual default).
   */
  enforcement?: CriterionEnforcement;
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
 * Wave LAO+STRATEGY_BASED AI parity (2026-05-21).
 *
 * STRATEGY_BASED submissions resolve to 1-N IssueRuleEntries via
 * findAllByStrategyName. Pre-submit-review evaluates the project
 * against EACH matched entry independently. The opaque
 * categories.criteriaEvaluations[] envelope below carries one
 * CriteriaEvaluationPayload per matched issueKey.
 *
 * Back-compat (D1=A): when matched-count === 1, the response ALSO
 * writes the legacy singular `criteriaEvaluation` key (set to the same
 * payload object). Readers expecting either shape continue to work.
 *
 * §17.4 snapshot-only — each payload independently stamps its
 * `rulesetVersion`, so historical snapshots remain readable even if
 * the registry's frozen version bumps in a future wave.
 */
export interface CriteriaEvaluationsEnvelope {
  /**
   * Array of per-issue evaluation payloads. Length 1-N. Empty array is
   * NOT emitted — when no entries match, the envelope itself is
   * omitted from the `categories` bag.
   */
  criteriaEvaluations: CriteriaEvaluationPayload[];

  /**
   * Wave-9 idempotency-compatible single-payload back-compat key.
   * Populated ONLY when criteriaEvaluations.length === 1 (mirrors the
   * single payload to ease FE migration). Omitted for length > 1.
   */
  criteriaEvaluation?: CriteriaEvaluationPayload;
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
  /**
   * Wave LAO+STRATEGY_BASED parity (N5, 2026-05-21).
   *
   * Source `IssueRuleEntry.issueKey` of the entry that produced this
   * hint. Required for STRATEGY_BASED multi-entry resolution where one
   * Strategy maps to N (1-6) entries — the merger uses this to attribute
   * each hint to the correct `CriteriaEvaluationPayload`.
   *
   * Optional in the type to preserve byte-identical wire shape with
   * pre-N5 ISSUE_BASED single-entry runs (where the merger can derive
   * the source entry from the global lookup unambiguously). New code
   * SHOULD populate it on every hint; readers MUST tolerate absence
   * and fall back to global criterionId lookup.
   *
   * Advisory-only per §17.2 — does NOT participate in workflow gating.
   */
  issueKey?: string;
}
