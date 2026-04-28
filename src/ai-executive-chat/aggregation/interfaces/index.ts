/**
 * Wave 54 — Aggregation Layer Foundation (BE-W54-01).
 *
 * Barrel for the Tier B service interfaces. Six interfaces total —
 * concrete implementations land in BE-W54-02..05 and BE-W54-07.
 */
export type {
  IUnifiedProjectAggregator,
  UnifiedProjectQuery,
  ExecutiveStatusBreakdownCounts,
  GroupedExecutiveStatusBreakdown,
  GroupedExecutiveStatusBreakdownBook,
  GroupedExecutiveStatusBreakdownStatusGroup,
  GroupedExecutiveStatusBreakdownProject,
} from './unified-project-aggregator.interface';
export type { IBudgetAggregator } from './budget-aggregator.interface';
export type {
  IStatusAggregator,
  LatestStatus,
} from './status-aggregator.interface';
export type {
  IGeoEnrichment,
  AmphoeLabel,
  GeoEnrichmentResult,
} from './geo-enrichment.interface';
export type {
  IAgencyEnrichment,
  AgencyLabel,
  AgencyEnrichmentResult,
} from './agency-enrichment.interface';
export type {
  IResilienceEnvelope,
  DimensionTask,
  ResilienceRunOptions,
} from './resilience-envelope.interface';
