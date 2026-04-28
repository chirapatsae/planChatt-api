/**
 * Wave 54 — Aggregation Layer Foundation (BE-W54-01).
 *
 * `ProjectKey` is a stable string representation of
 *   `(ProjectKind, projectId)`
 * used as a Map key when merging cross-FK results in application layer
 * (design memo §3.2 BudgetAggregator, §3.3 StatusAggregator).
 *
 * Shape: `` `${projectKind}:${projectId}` ``.
 *
 * Using a branded string (rather than a tuple) means aggregation
 * results can live in `Map<ProjectKey, T>` — a structure the V8
 * hashmap can key on cheaply.
 *
 * No PII is embedded in the key — only the synthetic discriminator and
 * the project UUID (§17 PII discipline).
 */
import type { ProjectKind } from './project-kind';

export type ProjectKey = `${ProjectKind}:${string}`;
