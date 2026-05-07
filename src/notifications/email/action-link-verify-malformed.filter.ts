import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * W93-VERIFY-API — converts DTO validation failures into the spec's
 * 200-with-`{ valid: false, reason: 'malformed' }` envelope.
 *
 * Why this exists:
 *   The task spec §7.2 / §10 require a SINGLE response shape so the
 *   frontend handles only one parser path. NestJS's global ValidationPipe
 *   throws `BadRequestException` (HTTP 400) on validator violations.
 *   Applying this filter at the route level intercepts those 400s and
 *   re-emits them as 200 with the `malformed` envelope.
 *
 * Scope:
 *   This filter is applied via `@UseFilters` ONLY on the
 *   `POST /v1/notifications/action-link/verify` handler. It MUST NOT be
 *   registered globally — every other endpoint relies on the standard
 *   400 contract for invalid input.
 *
 * Constraints (CLAUDE.md):
 *   - §4.1 — verifier outcome is integrity, not workflow authority
 *   - §12  — no tracking_status writes anywhere in this filter
 *   - W83  — this filter does not log; logging discipline lives in the handler
 */
@Catch(BadRequestException)
export class ActionLinkVerifyMalformedFilter implements ExceptionFilter {
  catch(_exception: BadRequestException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    res.status(HttpStatus.OK).json({ valid: false, reason: 'malformed' });
  }
}
