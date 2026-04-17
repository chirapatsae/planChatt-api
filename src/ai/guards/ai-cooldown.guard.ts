import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import {
  AI_COOLDOWN_METADATA,
  AiCooldownKeyFrom,
  AiCooldownMetadata,
} from '../decorators/ai-cooldown.decorator';
import {
  AI_COOLDOWN_STORE,
  AiCooldownStore,
} from '../stores/ai-cooldown.store';

/**
 * AI Cooldown Guard — per CLAUDE.md §17.8 (AI-Assist Rule cooldown canon).
 *
 * Behavior:
 *   1. Builds a cooldown key from (endpointKey, actorId, targetId).
 *   2. If an active cooldown exists: throws 429 with structured body
 *      `{ code: 'AI_COOLDOWN_ACTIVE', remainingSeconds, message }` plus
 *      the `Retry-After` header (seconds).
 *   3. Otherwise: hooks `response.on('finish')` to arm the cooldown
 *      ONLY when the final status code is 2xx. 4xx and 5xx MUST NOT arm
 *      the cooldown (§17.8 — a 5xx from the LLM must not lock the reviewer
 *      out of retrying).
 *
 * Hard guardrails:
 *   - No imports of tracking-status / project-group / revised-project-group entities.
 *   - No DB access. Store is in-memory (see ai-cooldown.store.ts).
 *   - Key derivation uses JWT `userId` from `req.user` as the actor
 *     identifier. The JWT payload does not currently carry
 *     `workHistoryId`; a user's current workHistory is 1:1 for the
 *     purpose of cooldown granularity, so userId is functionally
 *     equivalent here and avoids a DB hop on every request. Switching
 *     to a true workHistoryId later is a one-line change.
 *   - Returned_For_Revision rollback / workflow state is untouched.
 *
 * This guard MUST be registered AFTER JwtAuthGuard so `req.user` is set.
 * Controllers using @AiCooldown MUST already be behind JwtAuthGuard.
 */
@Injectable()
export class AiCooldownGuard implements CanActivate {
  private readonly logger = new Logger(AiCooldownGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(AI_COOLDOWN_STORE) private readonly store: AiCooldownStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const metadata = this.reflector.getAllAndOverride<AiCooldownMetadata>(
      AI_COOLDOWN_METADATA,
      [context.getHandler(), context.getClass()],
    );

    // No @AiCooldown decorator on this route → pass through.
    if (!metadata) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: { userId?: string } }>();
    const response = context.switchToHttp().getResponse<Response>();

    // Actor identifier. If JWT did not populate, we deliberately skip
    // enforcement — the surrounding JwtAuthGuard is the authoritative
    // auth layer, this guard only adds rate limiting once identity is known.
    const actorId = request.user?.userId;
    if (!actorId) return true;

    const targetId = this.resolveTargetId(request, metadata.keyFrom);

    // Even if targetId is missing, we still enforce a cooldown keyed on
    // `__no_target__` so a reviewer cannot evade the window by omitting the
    // field. This is consistent with §9 of the task file (do not leak
    // whether the target exists via 429).
    const key = buildCooldownKey(
      metadata.endpointKey,
      actorId,
      targetId ?? '__no_target__',
    );

    const existing = await this.store.get(key);
    const now = Date.now();

    if (existing && existing > now) {
      const remainingSeconds = Math.max(
        1,
        Math.ceil((existing - now) / 1000),
      );
      // Debug-level to avoid log spam (§7.6 of the task file).
      this.logger.debug(
        `AI cooldown hit [${metadata.endpointKey}] actor=${actorId} target=${
          targetId ?? '-'
        } remaining=${remainingSeconds}s`,
      );
      response.setHeader('Retry-After', String(remainingSeconds));
      throw new HttpException(
        {
          code: 'AI_COOLDOWN_ACTIVE',
          remainingSeconds,
          message: `กรุณารอ ${remainingSeconds} วินาที ก่อนเรียกระบบช่วยตรวจซ้ำ`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Arm cooldown ONLY on successful (2xx) responses. 4xx/5xx MUST NOT arm.
    // CLAUDE.md §17.8 canonical rule.
    const ttlMs = metadata.ttlSeconds * 1000;
    response.on('finish', () => {
      const status = response.statusCode;
      if (status >= 200 && status < 300) {
        // Fire and forget; store is in-memory sync-ish.
        this.store
          .set(key, Date.now() + ttlMs)
          .catch((err) =>
            this.logger.debug(
              `AI cooldown store.set failed: ${String(err?.message ?? err)}`,
            ),
          );
      }
      // Explicit: do NOT arm on 4xx or 5xx.
    });

    return true;
  }

  private resolveTargetId(
    request: Request,
    keyFrom: AiCooldownKeyFrom,
  ): string | null {
    const [scope, field] = keyFrom.split('.') as ['body', string];
    const source =
      scope === 'body' ? (request.body as Record<string, unknown>) : null;
    if (!source) return null;
    const value = source[field];
    if (value === undefined || value === null) return null;
    return String(value);
  }
}

/**
 * Pure helper so unit tests can assert key shape without hitting the guard.
 */
export function buildCooldownKey(
  endpointKey: string,
  actorId: string,
  targetId: string,
): string {
  return `${endpointKey}|${actorId}|${targetId}`;
}
