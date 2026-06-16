import { DataSource } from 'typeorm';
import { ExecutiveToolName } from '../executive-tool.types';
import type {
  IAgencyEnrichment,
  IBudgetAggregator,
  IGeoEnrichment,
  IResilienceEnvelope,
  IStatusAggregator,
  IUnifiedProjectAggregator,
} from '../../aggregation/interfaces';
import type { ProjectLineageService } from '../../aggregation/services/project-lineage.service';
// Wave 103 PR2 — canonical agency-projects aggregator. Behind feature flag
// `EXECUTIVE_AI_CANONICAL_AGENCY_AGGREGATOR` (default OFF). Optional in the
// deps bag so existing unit tests / golden fixtures that build the bag by
// hand do not need to stub it. Production wiring in `AiExecutiveChatService`
// always provides the concrete service.
import type { AgencyProjectsCanonicalAggregatorService } from '../../aggregation/services/agency-projects-canonical-aggregator.service';
// Wave AI-Knowledge-Hub BE-04 — published-only knowledge retrieval
// backend for the `searchKnowledgeBase` tool. Type-only import keeps
// the dependency one-way (chat → hub) and erased at runtime; the
// concrete instance is provided by `AiExecutiveChatService` via the
// hub module's exported provider.
import type { KnowledgeSearchService } from 'src/ai-knowledge-hub/services/knowledge-search.service';

/**
 * Caller-identity snapshot resolved once per turn and passed into every
 * tool handler so each can re-enforce §17.11 "no role exemption"
 * belt-and-braces AFTER the controller-level `ExecutiveRoleGuard`.
 */
export interface ExecutiveCallerContext {
  userId: string;
  workHistoryId: string;
  roleName: string;
  workStatusName: string;
}

/**
 * Dependency bag given to every handler. DataSource is enough to run
 * the Wave 53 read-only aggregations without pulling in each domain
 * module; Wave 54 extends the bag with the five Tier B aggregation
 * services so the new Tier C handlers (BE-W54-06) can compose
 * multi-source projections without any `getRepository()` access.
 *
 * §4.1 / §17.2 — all handlers are READ aggregators.
 * Wave 54 Path A (task §7 LOCKED 2026-04-24):
 *   - Extend the single handler-deps bag with the five Tier B service
 *     instances. Wave 53 handlers continue to use `deps.dataSource`
 *     directly (demote-not-retire); Wave 54 Tier C handlers use the
 *     new fields exclusively and MUST NOT call `dataSource.getRepository`.
 *   - Concrete services are resolved in `AiExecutiveChatService` via the
 *     DI tokens declared in `aggregation/tokens.ts`.
 */
export interface ExecutiveToolHandlerDeps {
  dataSource: DataSource;
  // Wave 54 Tier B — injected by AiExecutiveChatService (BE-W54-06).
  unifiedProject: IUnifiedProjectAggregator;
  budget: IBudgetAggregator;
  status: IStatusAggregator;
  geo: IGeoEnrichment;
  agency: IAgencyEnrichment;
  // Wave 54 BE-W54-07 — resilience envelope. Every Tier C handler
  // wraps its enrichment-dimension calls through `runDimensions(...)`;
  // the spine call (`unifiedProject.listUnifiedProjects`) remains
  // unwrapped per the orchestrator policy — spine failures throw.
  resilience: IResilienceEnvelope;
  // Wave 61 — Mode 3 lineage service. Backs `getProjectHeadBook` /
  // `getProjectLineage` handlers. Read-only (§17.2 / §17.3).
  // Wave 60c (2026-04-25): made OPTIONAL so the wide test surface (W55-W60
  // golden fixtures + service unit specs) doesn't require an explicit
  // stub. Wave 61 handlers MUST guard `if (!deps.projectLineage)` and
  // return a graceful "not available" envelope when the service is
  // absent. Production wiring continues to provide the real service via
  // the ai-executive-chat module.
  projectLineage?: ProjectLineageService;
  // Wave 103 PR2 — canonical agency-projects aggregator. Optional so the
  // wide test surface continues to work without an explicit stub. The
  // `getExecutiveDashboardSnapshot` and `getCrossPlanInsights` handlers
  // guard `if (!deps.agencyProjectsCanonical)` and silently fall through
  // to the legacy code path when absent. §17.2 advisory; §17.3 read-only.
  agencyProjectsCanonical?: AgencyProjectsCanonicalAggregatorService;
  // Wave AI-Knowledge-Hub BE-04 — `searchKnowledgeBase` retrieval
  // backend. OPTIONAL (same convention as `projectLineage`) so the wide
  // test surface doesn't need a stub; the handler guards
  // `if (!deps.knowledgeSearch)` and returns an empty, schema-valid
  // envelope when absent. Production wiring always provides the real
  // service. §17.2 advisory; §17.3 read-only (`ai_knowledge_*` only).
  knowledgeSearch?: KnowledgeSearchService;
}

/**
 * Handler return contract. Wave 53 tools return plain record objects;
 * the three new Wave 54 Tier C tools (`getPlanOverview`,
 * `getExecutiveDashboardSnapshot`, `getCrossPlanInsights`) return an
 * `ExecutiveEnvelope<T>` — structurally a string-keyed object, so the
 * Tier C handler bodies cast via
 * `envelope as unknown as Record<string, unknown>` at the return site.
 * Keeping the map type narrowed to `Record<string, unknown>` preserves
 * the property-access ergonomics Wave 53 tests rely on.
 */
export type ExecutiveToolHandler = (
  params: Record<string, unknown>,
  ctx: ExecutiveCallerContext,
  deps: ExecutiveToolHandlerDeps,
) => Promise<Record<string, unknown>>;

export type ExecutiveToolHandlerMap = Record<
  ExecutiveToolName,
  ExecutiveToolHandler
>;

/**
 * §17.11 belt-and-braces — re-check role + workStatus inside every
 * handler. The controller guard ran once; this is a tripwire in case
 * a future refactor calls the handler outside the HTTP guard chain.
 *
 * HOTFIX-W44-02 (Wave 44): the whitelist here MUST stay byte-identical
 * with `ExecutiveRoleGuard.ALLOWED_ROLES` — any drift causes a live
 * turn to pass the HTTP guard and then fail inside the tool loop with
 * a confusing `EXECUTIVE_ROLE_REQUIRED`, rolling back the whole turn
 * transaction (no user/assistant rows persisted). The legacy
 * `'executive'` token belonged to an earlier design and is not a real
 * role in `user_roles`.
 */
export function assertExecutiveRole(ctx: ExecutiveCallerContext): void {
  const allowed = new Set(['staff', 'admin', 'super-admin', 'c-level']);
  if (!allowed.has((ctx.roleName ?? '').toLowerCase())) {
    throw new Error('EXECUTIVE_ROLE_REQUIRED');
  }
  if ((ctx.workStatusName ?? '').toLowerCase() !== 'approved') {
    throw new Error('EXECUTIVE_ROLE_REQUIRED');
  }
}
