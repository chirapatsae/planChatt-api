/**
 * Wave 54 — BE-W54-07 — ResilienceEnvelope concrete service.
 *
 * Implements `IResilienceEnvelope`. Runs a set of named dimension tasks
 * in parallel under a soft 3-second per-dimension timeout and assembles
 * the final `ExecutiveEnvelope<T>` using the caller-supplied assembler.
 *
 * Hard contract (design §5, CLAUDE.md §17):
 *   - NEVER throws on dimension failure or timeout. The Tier C
 *     tool-loop MUST receive a 2xx envelope.
 *   - `ForbiddenException` raised INSIDE a dimension thunk is a
 *     pre-dimension policy gate, not a data failure — it is re-thrown
 *     uncaught (§5.2 / §17.11 / task §9).
 *   - On failure: log at `WARN` for `TypeORMError`, `DatabaseException`,
 *     `QueryFailedError`, and `DimensionTimeoutError`; `logger.error`
 *     for unexpected exception types. Surface a static Thai advisory
 *     via `advisories[]` — NEVER leak raw SQL / TypeORM error text
 *     (§17.9 prompt-injection defense).
 *   - `partial: true` IFF `missingDimensions.length > 0`.
 *   - `asOf` = server-side `new Date().toISOString()` captured at
 *     envelope composition.
 *   - Role check (`assertExecutiveRole`) is Tier C's responsibility;
 *     this service does NOT re-assert (§5.2 / §17.11).
 *
 * Locked decisions (2026-04-24):
 *   - Per-dimension soft timeout = 3000 ms, fixed. No env-var override,
 *     no per-call knob (dispatch §11.2).
 *   - Soft timeout — the underlying promise is left to settle naturally
 *     in the background (no AbortSignal for MVP, §11.R1).
 *
 * Advisory strings live in `advisory-copy.ts` — that module is the
 * SINGLE source of Thai advisory literals.
 */
import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { QueryFailedError, TypeORMError } from 'typeorm';

import { DIMENSION_ADVISORY } from './advisory-copy';
import type {
  DimensionTask,
  IResilienceEnvelope,
  ResilienceRunOptions,
} from './interfaces/resilience-envelope.interface';
import type {
  ExecutiveEnvelope,
  MissingDimension,
  ResilienceDimensionResult,
} from './types';

/**
 * Sentinel error type emitted by the internal per-dimension timeout
 * race. Carries the dimension name so the logger output can name the
 * offender precisely.
 */
export class DimensionTimeoutError extends Error {
  readonly dimension: MissingDimension;

  constructor(dimension: MissingDimension, timeoutMs: number) {
    super(`Dimension '${dimension}' timed out after ${timeoutMs}ms`);
    this.name = 'DimensionTimeoutError';
    this.dimension = dimension;
  }
}

/** LOCKED 2026-04-24 — 3-second soft per-dimension timeout. */
const DEFAULT_TIMEOUT_MS = 3000;

@Injectable()
export class ResilienceEnvelopeService implements IResilienceEnvelope {
  private readonly logger = new Logger('BE-W54-07:ResilienceEnvelope');

  async runDimensions<T>(
    tasks: DimensionTask[],
    assemble: (results: ResilienceDimensionResult[]) => T,
    options: ResilienceRunOptions,
  ): Promise<ExecutiveEnvelope<T>> {
    const timeoutMs = options.perDimensionTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Run all dimensions in parallel. We do NOT use `Promise.allSettled`
    // directly because we need to distinguish `ForbiddenException` from
    // every other failure mode and re-throw it uncaught. Instead we wrap
    // each task in a per-task coroutine that returns a
    // `ResilienceDimensionResult` on success or failure, and re-throws
    // `ForbiddenException`.
    const perTaskPromises = tasks.map((t) =>
      this.runOneDimension(t, timeoutMs),
    );

    // Use `Promise.all` — a `ForbiddenException` raised inside any task
    // coroutine propagates here and out of `runDimensions`, per §5.2.
    const results = await Promise.all(perTaskPromises);

    const missingDimensions: MissingDimension[] = [];
    const advisories: string[] = [];
    for (const r of results) {
      if (!r.ok) {
        missingDimensions.push(r.dimension);
        if (r.advisory) advisories.push(r.advisory);
      } else if (r.advisory) {
        // Documented-expected partial (e.g. `geo:supplement`) may carry
        // an advisory despite `ok: true`. Preserved for completeness —
        // GeoEnrichment today surfaces this via its own result object,
        // not via the envelope, but the contract allows it.
        advisories.push(r.advisory);
      }
    }

    const data = assemble(results);

    return {
      shape: options.shape,
      data,
      asOf: new Date().toISOString(),
      missingDimensions,
      advisories,
      partial: missingDimensions.length > 0,
    };
  }

  /**
   * Runs a single dimension task under the soft timeout. Returns a
   * `ResilienceDimensionResult` — never throws unless the underlying
   * thunk raised a `ForbiddenException`, in which case the exception
   * is re-thrown uncaught so Tier C can surface the 403 upstream.
   */
  private async runOneDimension(
    task: DimensionTask,
    timeoutMs: number,
  ): Promise<ResilienceDimensionResult> {
    const { dimension } = task;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new DimensionTimeoutError(dimension, timeoutMs));
      }, timeoutMs);
    });

    try {
      const value = await Promise.race([task.run(), timeoutPromise]);
      return {
        dimension,
        ok: true,
        value,
      };
    } catch (err) {
      // §5.2 / §17.11 — ForbiddenException is a pre-dimension policy
      // gate, not a data failure. Re-throw uncaught so Tier C surfaces
      // the 403 through the tool-loop's standard error path.
      if (err instanceof ForbiddenException) {
        throw err;
      }

      this.logDimensionFailure(dimension, err);

      // Advisory resolution — preference order:
      //   1. Error-carried advisory (e.g. ClassificationShapeError —
      //      still a server-authored literal at the task definition).
      //   2. Task-supplied expected-advisory for documented partials.
      //   3. Static `DIMENSION_ADVISORY` fallback.
      // In every case the literal is server-authored (§17.9); raw
      // error text NEVER appears.
      const errorAdvisory = this.pickErrorCarriedAdvisory(err);
      const advisory =
        errorAdvisory ??
        task.expectedAdvisoryOnFailure ??
        DIMENSION_ADVISORY[dimension];

      return {
        dimension,
        ok: false,
        advisory,
      };
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    }
  }

  /**
   * Telemetry — task §7. `WARN` for known DB / timeout classes;
   * `ERROR` for unexpected types. Log shape is structured JSON so the
   * log sink can filter on `node: 'BE-W54-07'`.
   */
  private logDimensionFailure(
    dimension: MissingDimension,
    err: unknown,
  ): void {
    const payload = {
      node: 'BE-W54-07',
      dimension,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    };

    if (
      err instanceof DimensionTimeoutError ||
      err instanceof TypeORMError ||
      err instanceof QueryFailedError ||
      this.isLikelyDatabaseException(err)
    ) {
      this.logger.warn(JSON.stringify(payload));
    } else {
      this.logger.error(JSON.stringify(payload));
    }
  }

  /**
   * If the rejected error carries a server-authored `.advisory` string
   * property (e.g. `ClassificationShapeError`), return it so the
   * envelope advisory reflects the specific mismatch. We only accept
   * `string` — defensive against the advisory field being hijacked
   * with a non-literal value.
   */
  private pickErrorCarriedAdvisory(err: unknown): string | undefined {
    if (!err || typeof err !== 'object') return undefined;
    const adv = (err as { advisory?: unknown }).advisory;
    return typeof adv === 'string' && adv.length > 0 ? adv : undefined;
  }

  /**
   * Best-effort detector for project-local `DatabaseException` types
   * without hard-importing them (keeps the aggregation module decoupled
   * from every domain module). Matches any error whose constructor name
   * ends with `DatabaseException`.
   */
  private isLikelyDatabaseException(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const ctorName = (err as { constructor?: { name?: string } }).constructor
      ?.name;
    return typeof ctorName === 'string' && /DatabaseException$/.test(ctorName);
  }
}
