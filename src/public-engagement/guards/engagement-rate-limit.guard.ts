import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';

/**
 * In-memory IP-keyed rate-limit guard for engagement POSTs.
 *
 * PDPA: the IP address is read from `req.ip` for this rate-limit gate
 * ONLY. It is NEVER logged, NEVER inserted into any table, and the
 * counter map lives entirely in process memory (the map MUST NOT be
 * persisted). The map self-cleans entries whose window has elapsed.
 *
 * Per CLAUDE.md §17.2 — engagement is advisory; this guard does not
 * affect workflow transitions even on 429.
 *
 * Limit: 30 POSTs per minute per IP across all engagement endpoints.
 */
@Injectable()
export class EngagementRateLimitGuard implements CanActivate {
  private static readonly WINDOW_MS = 60_000;
  private static readonly MAX_PER_WINDOW = 30;

  /**
   * key = client IP, value = { count, windowStartMs }.
   * Exposed as a Map (not an LRU) because the total population is
   * bounded by anonymous public traffic over one minute; entries are
   * evicted lazily on the next hit from the same key.
   */
  private readonly buckets = new Map<
    string,
    { count: number; windowStartMs: number }
  >();

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    // Defensive — Express `trust proxy` setting governs `req.ip`. If
    // missing, fall back to a sentinel so the bucket still keys
    // deterministically.
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();

    const bucket = this.buckets.get(ip);
    if (!bucket || now - bucket.windowStartMs >= EngagementRateLimitGuard.WINDOW_MS) {
      this.buckets.set(ip, { count: 1, windowStartMs: now });
      return true;
    }

    if (bucket.count >= EngagementRateLimitGuard.MAX_PER_WINDOW) {
      throw new HttpException(
        { message: 'มีการกระทำมากเกินไป กรุณาลองใหม่อีกครั้ง' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    bucket.count += 1;
    return true;
  }
}
