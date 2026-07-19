/**
 * Executive AI Chat — tool-registry type surface.
 *
 * CLAUDE.md references:
 *   - §17.2 Advisory-only — every tool below is a READ aggregator. None
 *     mutate state, none gate workflow transitions.
 *   - §17.7 / §16.5 — any tool that reads classification fields MUST
 *     branch on the parent plan's `reportFormat`. Tool specs below
 *     declare that requirement in their `description`; handler bodies
 *     (BE-W44-02) enforce it.
 *   - §17.9 — tool result shape is schema-validated server-side before
 *     being sent back to the LLM. `resultSchema` here is the canonical
 *     contract.
 *
 * JSON Schema:
 *   We avoid adding a `json-schema` dependency by declaring a minimal
 *   structural subset of JSON Schema Draft-07. The fields we actually
 *   consume (`type`, `properties`, `required`, `enum`, `items`,
 *   `minimum`, `maximum`, `default`, `format`, `description`) are the
 *   same shape OpenAI's tool-params spec expects, so this structure is
 *   directly re-usable in the BE-W44-02 tool-loop adapter.
 */

export type ExecutiveToolName =
  | 'listActivePlans'
  | 'getDevelopmentIssues'
  | 'getPendingCountsByScope'
  | 'getTeamWorkloadSummary'
  | 'getBudgetSummaryByPlan'
  | 'searchProjectsByKeyword'
  | 'getProjectStatusBreakdown'
  | 'getApprovalPipelineSnapshot'
  // --- Scope expansion (2026-04-23): decision-assist tools ---
  | 'detectWorkflowAgingProjects'
  | 'highlightBudgetOutliers'
  // --- Wave 48 (BE-W48-03): enumerate projects bound to a given plan ---
  | 'listProjectsInPlan'
  // --- Wave 53 (BE-W53-02): coverage-extension tools (3).
  //     Grouped alphabetically so Wave 53's sibling node BE-W53-03 can
  //     slot `getProjectClassificationBreakdown` in alongside
  //     `getProjectLocationBreakdown` without a merge collision.
  | 'getProjectLocationBreakdown'
  | 'listDevelopmentPlanRevisions'
  | 'listDevelopmentPlanSupplements'
  // --- Wave 53 (BE-W53-03): classification breakdown per plan with §17.7 branching ---
  | 'getProjectClassificationBreakdown'
  // --- Wave 54 (BE-W54-06): Tier C executive tools composing Tier B
  //     aggregation services via the shared ExecutiveQuery DSL.
  //     `getPlanOverview` requires `planId`; `getExecutiveDashboardSnapshot`
  //     accepts an optional `planId`; `getCrossPlanInsights` forbids
  //     `planId` at the schema level (`{ not: {} }`). ---
  | 'getPlanOverview'
  | 'getExecutiveDashboardSnapshot'
  | 'getCrossPlanInsights'
  // --- Wave 61: Mode 3 lineage tools — per-project HEAD-of-lineage book
  //     lookup ("เล่มล่าสุดของโครงการ X") and full forward chain
  //     ("ไทม์ไลน์โครงการ X"). Both are advisory/read-only (§17.2 / §17.3).
  | 'getProjectHeadBook'
  | 'listProjectHeadRoster'
  | 'getProjectLineage'
  // --- Wave 66 (W66-BE-AGG-01): explicit "no responsibleAgency" lister.
  //     Counts AND lists projects whose `responsible_agency_id` is NULL
  //     across the three project tables (PG / RPG-edit / RPG-change).
  //     Disambiguates from `getTeamWorkloadSummary.inReviewCount` which
  //     answered a different (workflow) question. Read-only (§17.2 /
  //     §17.3).
  | 'listProjectsWithoutResponsibleAgency'
  // --- Wave 67 (W67-AMPHOE-FIX-PROMPT-01, Path A): amphoe name → PK
  //     resolver tool. The aggregator's `applyFilters({ amphoeIds })`
  //     correctly targets `pg.amphoe_id` (string PK), but the LLM had
  //     no path to translate "อำเภอเมือง" → '3007' and habitually sent
  //     the Thai literal verbatim → SQL bind matches zero rows.
  //     Read-only (§17.2 / §17.3) — supports `nameContains` partial
  //     match; scoped to the deployment province (Nakhon Ratchasima
  //     per §13.5 — the `amphoes` table contains only that province's
  //     rows).
  | 'listAmphoes'
  // --- Wave 67 (W67-LAO-RESOLVER): LAO name → PK resolver, mirrors
  //     `listAmphoes`. Required to resolve "อบต. โคกกรวด" / "เทศบาล
  //     ขามสะแกแสง" / etc. → the string PK consumed by the new
  //     `filters.laoIds` clause on the shared ExecutiveQuery DSL.
  //     Hybrid validation (Q2=c): handler enforces at-least-one of
  //     `{ amphoeId, nameContains }` so a 430+ row dump is impossible.
  //     Read-only (§17.2 / §17.3 / §13.5 changwat scope inherited
  //     from the underlying table population).
  | 'listLaos'
  // --- Wave 67 (W67-AGENCY-RESOLVER): government_agency name → PK
  //     resolver, mirrors `listAmphoes` / `listLaos`. The aggregator's
  //     `applyFilters({ agencyIds })` already coerces values via
  //     `Number(x)` (agency PK is an auto-increment integer column),
  //     but the LLM had no path to translate "กองยุทธศาสตร์" → 12
  //     until this resolver landed. Read-only (§17.2 / §17.3); no
  //     at-least-one-of guard (agencies are far fewer than LAOs so
  //     dumping the full list when no filter is provided is acceptable
  //     token-wise).
  | 'listAgencies'
  // --- Wave AI-Exec-Chat-Book-Coverage BE-01 (2026-05-28): sub-book
  //     drill-down read tools. Closes the gap that prevented executive
  //     chat from answering "ข้อมูลเล่มแก้ไขมีกี่โครงการ" /
  //     "เล่มเพิ่มเติมครั้งที่ 1 มีโครงการอะไร" — `listProjectsInPlan`
  //     could scope to `revised|supplement` but only ACROSS all sub-
  //     books; it had no per-DPR / per-DPS drill-in. These four tools
  //     accept a sub-book UUID directly. Per Q1 (org-wide read) the
  //     handlers apply NO owner filter; per Q2 the listers cap at
  //     200 rows + `nextOffset`, summaries are uncapped. HEAD-of-
  //     lineage filter (§14.2) is applied by default; opt-out via
  //     `includeHistoricalVersions: true` on the listers only.
  //     Read-only (§17.2 / §17.3). §17.11 no role exemption.
  | 'listProjectsInRevisionBook'
  | 'listProjectsInSupplementBook'
  | 'getRevisionBookSummary'
  | 'getSupplementBookSummary'
  // --- Wave AI-Exec-Chat-Enterprise-Output-Tone BE-01 (2026-05-28):
  //     `getPlanCatalogOverview` — orchestrator that fans out
  //     `listActivePlans` + per-plan `listDevelopmentPlanRevisions` +
  //     `listDevelopmentPlanSupplements` and pre-renders the canonical
  //     Rule #47 bullet layout in a `renderedMarkdown` envelope field.
  //     Phase 1 of the document-centric catalog architecture — proves
  //     the pattern. The LLM emits `renderedMarkdown` verbatim per
  //     Rule #32 + Rule #47 + Rule #48 ("Enterprise Output Bar",
  //     appended by BE-02). Read-only (§17.2 / §17.3); §17.11 no role
  //     exemption — handler MUST NOT branch on role.
  | 'getPlanCatalogOverview'
  // --- Wave AI-Knowledge-Hub BE-04 (2026-06-12): `searchKnowledgeBase`
  //     — published-only curated/external knowledge retrieval (§17.15.4
  //     exposure invariant). Backed by `KnowledgeSearchService` in the
  //     `ai-knowledge-hub` module (one-way dependency chat → hub).
  //     pg_trgm + ILIKE retrieval per Q5; top-k ≤ 5, excerpt ≤ 800
  //     chars. Advisory per §17.2 — derived (live-DB) tool data WINS on
  //     conflict; provenance (origin / sourceName / updatedAt) is
  //     mandatory in the envelope so the LLM can cite ที่มา. Rides the
  //     existing executive-chat cooldown/quota keys (§17.8 — no new
  //     key). Read-only (§17.2 / §17.3); §17.11 no role exemption.
  | 'searchKnowledgeBase'
  // --- Wave AI-Exec-Chat-Equipment-ผ.03 (2026-07-18,
  //     docs/tasks/AI_EXEC_CHAT_EQUIPMENT_P03_COVERAGE.md): seven
  //     standalone equipment (ผ.03) tools. Spine = the canonical
  //     `UnifiedEquipmentService.executiveList` (EPG + RELPG + SEPG,
  //     §14.2 HEAD-of-lineage REPLACE, W67 strip+4-group tag) via
  //     `UnifiedEquipmentAggregatorService`. Deliberately NOT folded
  //     into the Tier-C ExecutiveQuery DSL (task §3.1 D1 — byte-identity
  //     invariant of dsl-contract.spec + pending PR3 collapse).
  //     Read-only (§17.2 / §17.3); §17.11 no role exemption; §16.5
  //     dual classification shape honored (no STRATEGY_BASED
  //     assumption).
  | 'searchEquipmentByKeyword'
  | 'listEquipmentInPlan'
  | 'listEquipmentHeadRoster'
  | 'getEquipmentBudgetSummary'
  | 'getEquipmentStatusBreakdown'
  | 'getEquipmentCategoryBreakdown'
  | 'listEquipmentInRevisionBook'
  | 'listEquipmentInSupplementBook';

/**
 * Minimal structural subset of JSON Schema Draft-07. Consumed by the
 * tool-loop adapter (BE-W44-02) for both OpenAI tool-definition
 * emission and server-side result validation.
 */
export interface ToolJsonSchema {
  type?:
    | 'object'
    | 'array'
    | 'string'
    | 'number'
    | 'integer'
    | 'boolean'
    | 'null';
  description?: string;
  // object
  properties?: Record<string, ToolJsonSchema>;
  required?: string[];
  additionalProperties?: boolean | ToolJsonSchema;
  // array
  items?: ToolJsonSchema;
  minItems?: number;
  uniqueItems?: boolean;
  // string
  format?: string;
  enum?: Array<string | number | boolean | null>;
  // number / integer
  minimum?: number;
  maximum?: number;
  default?: unknown;
  // Wave 54 (BE-W54-06): `not` clause is used by `getCrossPlanInsights`
  // to declare that `planId` is forbidden at the schema level. The
  // shape `{ not: {} }` forbids ANY value, effectively removing the
  // property from the accepted payload.
  not?: ToolJsonSchema;
}

export interface ExecutiveToolSpec {
  name: ExecutiveToolName;
  /** Thai-friendly short label used in UI + provenance chips. */
  thaiLabel: string;
  /** Natural-language description seeded to the LLM. */
  description: string;
  paramsSchema: ToolJsonSchema;
  returnSchema: ToolJsonSchema;
  /**
   * BE-W44-01 leaves the handler unset. BE-W44-02 registers handlers in
   * a separate map and MUST refuse to execute any tool whose name is
   * not present in this registry.
   */
  handlerPlaceholder: null;
}
