/**
 * W107-BE-PR2 — AccessLogInterceptor
 *
 * Fire-and-forget interceptor that writes one `stats_access_log` row
 * per successful (2xx) response from any handler annotated with
 * `@AccessLogged()`.
 *
 * Source-of-truth: docs/tasks/wave107/W107-BE-PR2-STATS-API.md §7.3.
 *
 * Behavior contract:
 *   - 2xx response → 1 insert
 *   - 4xx / 5xx response → 0 inserts (failed access is not in scope per
 *     the task spec; auth-layer logs already capture unauthorized hits)
 *   - The insert is fire-and-forget — the response is NEVER blocked.
 *   - Errors inside the insert are caught by StatsAccessLogService and
 *     never propagate.
 *
 * §17.2 — the interceptor never reads or mutates a workflow value.
 * §17.3 — the only DB write touched is `stats_access_log`.
 */

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { Request, Response } from 'express';

import { StatsAccessLogService } from '../services/stats-access-log.service';
import { ACCESS_LOGGED_METADATA_KEY } from '../decorators/access-logged.decorator';

@Injectable()
export class AccessLogInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly statsAccessLog: StatsAccessLogService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isLogged = this.reflector.getAllAndOverride<boolean>(
      ACCESS_LOGGED_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!isLogged) {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest<Request & { user?: { userId?: string; role?: string } }>();
    const res = http.getResponse<Response>();

    return next.handle().pipe(
      tap(() => {
        // Only successful (2xx) responses produce an access-log row.
        const status = res.statusCode ?? 200;
        if (status < 200 || status >= 300) return;

        const callerUserId = req.user?.userId;
        const callerRole = req.user?.role;
        if (!callerUserId || !callerRole) return; // defensive — JwtAuthGuard already enforced this.

        const rawIp =
          (req.headers['x-forwarded-for'] as string | undefined)
            ?.split(',')[0]
            ?.trim() ||
          req.ip ||
          null;
        // Postgres `inet` is strict — strip any `:port` suffix from IPv4
        // ("192.168.1.1:5432" → "192.168.1.1") while preserving IPv6
        // bracketed forms ("[::1]:5432" → "::1") and bare IPv6 ("::1").
        const ip = rawIp ? this.normalizeIp(rawIp) : null;
        const ua = (req.headers['user-agent'] as string | undefined) ?? null;

        const endpoint = `${req.method} ${this.routePath(req)}`;
        const queryParams = (req.query as Record<string, unknown>) ?? {};

        // Fire-and-forget — never await, never throw.
        void this.statsAccessLog.record({
          callerUserId,
          callerWorkHistoryId: null,
          callerRole,
          endpoint,
          queryParams,
          httpStatus: status,
          requestIp: ip,
          requestUserAgent: ua,
        });
      }),
    );
  }

  /**
   * Normalize an IP string for Postgres `inet`:
   *   - "1.2.3.4:5678"  → "1.2.3.4"
   *   - "[::1]:5678"    → "::1"
   *   - "::1"           → "::1"
   *   - "1.2.3.4"       → "1.2.3.4"
   * Returns null if the cleanup leaves an obviously-bad value so the
   * `inet` insert won't blow up.
   */
  private normalizeIp(raw: string): string | null {
    let s = raw.trim();
    if (!s) return null;
    // Bracketed IPv6 with port.
    const bracket = s.match(/^\[([^\]]+)\](?::\d+)?$/);
    if (bracket) return bracket[1];
    // IPv4 with optional :port (single colon means IPv4:port; multiple
    // colons indicate bare IPv6 — leave it alone).
    const colonCount = (s.match(/:/g) ?? []).length;
    if (colonCount === 1) {
      const idx = s.indexOf(':');
      s = s.slice(0, idx);
    }
    return s || null;
  }

  /**
   * Prefer the handler's route template (e.g. `/api/v1/system-usage/overview`)
   * when express has populated `req.route`. Falls back to the raw path
   * otherwise — the path is still safe (no PII surface).
   */
  private routePath(req: Request): string {
    const baseUrl = (req as unknown as { baseUrl?: string }).baseUrl ?? '';
    const route = (req as unknown as { route?: { path?: string } }).route;
    if (route?.path) {
      return `${baseUrl}${route.path}`;
    }
    return req.originalUrl?.split('?')[0] ?? req.url ?? '';
  }
}
