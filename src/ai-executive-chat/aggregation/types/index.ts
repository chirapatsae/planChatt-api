/**
 * Wave 54 — Aggregation Layer Foundation (BE-W54-01).
 *
 * Barrel for the shared Tier B types. Centralised here so aggregation
 * services and (later) Tier C handlers import from a single path:
 *   `backend/src/ai-executive-chat/aggregation/types`.
 */
export type { ProjectKind } from './project-kind';
export type { ProjectKey } from './project-key';
export type { UnifiedProject, PlanReportFormat } from './unified-project';
export type { MissingDimension } from './missing-dimension';
export type {
  ExecutiveEnvelope,
  ExecutiveEnvelopeShape,
  ResilienceDimensionResult,
} from './executive-envelope';
