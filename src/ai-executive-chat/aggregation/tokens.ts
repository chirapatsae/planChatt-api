/**
 * Wave 54 — Aggregation Layer Foundation (BE-W54-01).
 *
 * DI tokens for the six Tier B aggregation-service interfaces.
 *
 * Concrete classes land in BE-W54-02..05 and BE-W54-07; Tier C
 * handlers (BE-W54-06) inject by token so consumers depend on the
 * interface, not the implementation class.
 *
 * Design memo §2 Tier B rules:
 *   - INTERNAL surface only. Not exposed via any HTTP controller.
 *   - Consumed ONLY by Tier C handlers inside AiExecutiveChatModule.
 *   - Each provider MUST accept an already-asserted executive context;
 *     role checks live at Tier C.
 */

export const UNIFIED_PROJECT_AGGREGATOR = Symbol('UNIFIED_PROJECT_AGGREGATOR');
export const BUDGET_AGGREGATOR = Symbol('BUDGET_AGGREGATOR');
export const STATUS_AGGREGATOR = Symbol('STATUS_AGGREGATOR');
export const GEO_ENRICHMENT = Symbol('GEO_ENRICHMENT');
export const AGENCY_ENRICHMENT = Symbol('AGENCY_ENRICHMENT');
export const RESILIENCE_ENVELOPE = Symbol('RESILIENCE_ENVELOPE');
