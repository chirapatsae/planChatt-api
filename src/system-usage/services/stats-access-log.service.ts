/**
 * W107-BE-PR2 — StatsAccessLogService
 *
 * Encapsulates the single insert path into `stats_access_log`. Every
 * successful (2xx) response from a /v1/system-usage/* endpoint writes
 * exactly one row through this service.
 *
 * Source-of-truth: docs/tasks/wave107/W107-BE-PR2-STATS-API.md §7.3.
 *
 * §17.3 — this service writes ONLY to `stats_access_log`. It MUST NOT
 *         reach into `tracking_status`, notification logs, or any
 *         project / plan / book table.
 * §17.11 — there is no role override; every successful access (whether
 *          super-admin, admin, or c-level) is logged identically.
 *
 * Fire-and-forget contract:
 *   - The interceptor calls `record(...)` after the response is built
 *     but BEFORE the body is flushed to the client.
 *   - The promise is intentionally NOT awaited by the interceptor so an
 *     access-log failure never converts a successful 2xx into an error.
 *   - The internal try/catch swallows DB errors and logs a single
 *     warning line. The forensic value of "we missed one row" is lower
 *     than the operational cost of crashing a stats page.
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StatsAccessLog } from '../entities/stats-access-log.entity';

export interface RecordAccessInput {
  callerUserId: string;
  callerWorkHistoryId?: string | null;
  callerRole: string;
  endpoint: string; // e.g. 'GET /v1/system-usage/overview'
  queryParams: Record<string, unknown>;
  httpStatus: number;
  requestIp?: string | null;
  requestUserAgent?: string | null;
}

@Injectable()
export class StatsAccessLogService {
  private readonly logger = new Logger(StatsAccessLogService.name);

  constructor(
    @InjectRepository(StatsAccessLog)
    private readonly repo: Repository<StatsAccessLog>,
  ) {}

  /**
   * Insert one row. Caller MAY await for tests; production interceptor
   * does NOT await.
   */
  async record(input: RecordAccessInput): Promise<void> {
    try {
      // Defensive truncation — the entity caps at 256 chars but we
      // don't want a long upstream proxy path to crash the insert.
      const endpoint =
        input.endpoint.length > 256
          ? input.endpoint.slice(0, 256)
          : input.endpoint;

      // Strip undefined / null leaves from queryParams to keep the jsonb
      // payload tidy. Free-text body fields are NOT in scope (this is a
      // GET-only controller); but this strip also defends against any
      // future POST that might accidentally pass through a body.
      const sanitized = this.sanitizeQueryParams(input.queryParams ?? {});

      await this.repo.insert({
        callerUserId: input.callerUserId,
        callerWorkHistoryId: input.callerWorkHistoryId ?? null,
        callerRole: input.callerRole,
        endpoint,
        // TypeORM's QueryDeepPartialEntity narrows `Record<string, unknown>`
        // to a recursively-deep-partial shape that does not unify with our
        // sanitized free-form jsonb payload. Cast at the boundary — the
        // value lands in a jsonb column and is round-tripped as-is.
        queryParams: sanitized as Record<string, any>,
        httpStatus: input.httpStatus,
        requestIp: input.requestIp ?? null,
        requestUserAgent: input.requestUserAgent ?? null,
      });
    } catch (err) {
      // Never propagate. Stats access logging is best-effort.
      this.logger.warn(
        `[stats-access-log] insert failed for endpoint=${input.endpoint} caller=${input.callerUserId}: ${
          (err as Error)?.message ?? err
        }`,
      );
    }
  }

  private sanitizeQueryParams(
    raw: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v === undefined || v === null) continue;
      // Drop any free-text larger than 256 chars defensively.
      if (typeof v === 'string' && v.length > 256) {
        out[k] = v.slice(0, 256);
        continue;
      }
      out[k] = v;
    }
    return out;
  }
}
