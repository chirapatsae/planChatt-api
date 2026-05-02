import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  UseFilters,
} from '@nestjs/common';

import { VerifyActionLinkDto } from './dto/verify-action-link.dto';
import {
  verifyActionLinkToken,
  VerifyResult,
} from './action-link-token.util';
import { ActionLinkVerifyMalformedFilter } from './action-link-verify-malformed.filter';

/**
 * W93-VERIFY-API — Stateless action-link verifier endpoint.
 *
 * POST /v1/notifications/action-link/verify
 *
 * Public, unauthenticated endpoint that consumes `{ projectId, token, expiry }`
 * and returns `{ valid, reason }`. The endpoint is the backend half of the
 * W93 verification design (Q2 = Option α, frontend-guard + backend stateless
 * verify). It MUST be reachable without a JWT so an unauthenticated user
 * landing from an email can learn "your link expired" before being bounced
 * through the login flow.
 *
 * Design constraints (CLAUDE.md):
 *   - §4.1  — verify result is advisory; JWT remains the authority gate
 *   - §12   — endpoint MUST NOT write to `tracking_status`
 *   - §17.2 — verify result MUST NOT change project state
 *   - §17.3 — no FK from this surface to any project table
 *   - W83   — log only the first 8 chars of the token (token masking)
 *
 * Statelessness:
 *   - No DB read, no DB write, no Redis call
 *   - No call into `notifications-email.service`, `recipient-resolver`, etc.
 *   - Pure CPU: HMAC compute + constant-time compare in
 *     `verifyActionLinkToken`
 *
 * Public route plumbing:
 *   The neighboring controllers in this module (`EmailStatsController`,
 *   `NotificationSettingsController`) opt in to JWT via
 *   `@UseGuards(JwtAuthGuard)`. NestJS does NOT register a global JWT
 *   guard in `main.ts`, so simply omitting `@UseGuards` here leaves the
 *   route public. No `@Public()` / `@SkipAuth()` decorator exists in this
 *   codebase, so the omit-the-guard pattern is the project convention.
 *
 * DTO validation envelope:
 *   The route is wrapped in `ActionLinkVerifyMalformedFilter` which
 *   converts the global `ValidationPipe`'s 400 into a
 *   `200 { valid: false, reason: 'malformed' }`, satisfying spec §10's
 *   single-response-shape requirement.
 */
@Controller({
  version: '1',
  path: 'notifications',
})
export class ActionLinkVerifyController {
  private readonly logger = new Logger(ActionLinkVerifyController.name);

  @Post('action-link/verify')
  @HttpCode(HttpStatus.OK)
  @UseFilters(ActionLinkVerifyMalformedFilter)
  async verifyActionLink(
    @Body() dto: VerifyActionLinkDto,
  ): Promise<VerifyResult> {
    const result = verifyActionLinkToken({
      projectId: dto.projectId,
      token: dto.token,
      expiry: dto.expiry,
    });

    // W83 — token MUST be masked to first 8 chars only. The full HMAC
    // and the secret never appear in logs. `projectId` is a UUID and is
    // also clipped to 8 chars to match the report-spec format used
    // across other Wave 9x notify logs.
    const tokenPrefix =
      typeof dto.token === 'string' ? dto.token.slice(0, 8) : '';
    const projectIdPrefix =
      typeof dto.projectId === 'string' ? dto.projectId.slice(0, 8) : '';

    this.logger.log(
      `[Notify] action-link verify ` +
        `result=${result.reason} ` +
        `projectId=${projectIdPrefix} ` +
        `token=${tokenPrefix} ` +
        `expiry=${dto.expiry}`,
    );

    return result;
  }
}
