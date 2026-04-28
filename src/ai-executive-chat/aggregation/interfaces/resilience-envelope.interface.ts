/**
 * Wave 54 — Aggregation Layer Foundation (BE-W54-01).
 *
 * `IResilienceEnvelope` is the Tier B service that wraps each
 * requested dimension in `try/catch` + soft timeout (3s default per
 * locked decision §11.2), aggregates per-dimension results, and emits
 * the final `ExecutiveEnvelope<T>`.
 *
 * Contract rules (BE-W54-07 implementor):
 *   - NEVER throws on dimension failure. The tool-loop MUST receive a
 *     2xx envelope.
 *   - Role check (`assertExecutiveRole`) runs BEFORE this service is
 *     called; role failure MUST throw `ForbiddenException` up the
 *     stack — it is NOT a dimension (design §5.2).
 *   - Schema-validator failures on incoming params are NOT dimensions
 *     either — rejected with 400 by the tool-loop (§17.9).
 *   - On failure: log at `WARN`/`ERROR` with stack + target IDs;
 *     surface a static Thai advisory into `advisories[]`. NEVER leak
 *     raw SQL / TypeORM error text into the envelope.
 *   - Sets `partial: true` IFF `missingDimensions.length > 0`.
 *
 * Shape note: `data` is produced by the caller (Tier C tool handler)
 * from the successful dimension results; this service composes the
 * envelope metadata around it. The exact composition API is owned by
 * BE-W54-07 — the interface here declares only the stable entry point.
 */
import type {
  ExecutiveEnvelope,
  ExecutiveEnvelopeShape,
  ResilienceDimensionResult,
} from '../types';

/**
 * A single dimension fetch. The factory receives the already-asserted
 * caller context (Tier C) and returns a Promise. A thrown error inside
 * the factory is captured by the envelope service and converted into a
 * `missingDimensions` entry with a static Thai advisory.
 *
 * `dimension` MUST be one of the `MissingDimension` literals (the type
 * is reused here via `ResilienceDimensionResult['dimension']`).
 */
export interface DimensionTask<TValue = unknown> {
  dimension: ResilienceDimensionResult<TValue>['dimension'];
  /**
   * Thai advisory string for the documented-expected partial case
   * (e.g. SPG geo-skip). Optional — the envelope service pairs it with
   * `missingDimensions[]` when the factory rejects OR when the factory
   * resolves with `ok: false`.
   */
  expectedAdvisoryOnFailure?: string;
  run(): Promise<TValue>;
}

export interface ResilienceRunOptions {
  /** Envelope shape tag (`planOverview` | `dashboardSnapshot` | …). */
  shape: ExecutiveEnvelopeShape;
  /**
   * Soft per-dimension timeout in milliseconds. Locked default is
   * 3000 (design §11.2). Wave 54 does NOT expose per-call overrides.
   */
  perDimensionTimeoutMs?: number;
}

export interface IResilienceEnvelope {
  /**
   * Runs the supplied dimension tasks in parallel under a soft timeout,
   * and assembles the resulting `ExecutiveEnvelope<T>`.
   *
   * @param tasks  per-dimension tasks (independent — no ordering
   *               dependency between them).
   * @param assemble the Tier C tool's pure function mapping the
   *               successful dimension results to the envelope's
   *               `data: T` payload. Receives the per-dimension result
   *               records for composition.
   * @param options envelope shape + timeout options.
   */
  runDimensions<T>(
    tasks: DimensionTask[],
    assemble: (results: ResilienceDimensionResult[]) => T,
    options: ResilienceRunOptions,
  ): Promise<ExecutiveEnvelope<T>>;
}
