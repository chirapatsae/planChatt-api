import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { AI_QUOTA_WEIGHT_METADATA } from '../decorators/ai-quota-weight.decorator';
import { QUOTA_WEIGHT_MAP, QuotaWeight } from '../quota-weight.map';
import { AiUsageQuotasService } from '../ai-usage-quotas.service';
import { QuotaOrgCapService } from '../quota-org-cap.service';
import { resolveModel } from '../quota-model-override';

/**
 * Wave 44 / BE-W44-03 — pre-call AI quota enforcement guard.
 *
 * Responsibilities (CLAUDE.md §17.2 / §17.8 / §17.11):
 *   1. Read `@AiQuotaWeight(key)` metadata; pass-through when absent.
 *   2. Look up `QUOTA_WEIGHT_MAP[key]`; 500 `QUOTA_WEIGHT_UNKNOWN`
 *      on miss (dev mistake — MUST NOT ship).
 *   3. Load the caller's quota row (read-only snapshot). Missing →
 *      401 `AI_QUOTA_MISSING`.
 *   4. Reject 429 `AI_QUOTA_EXHAUSTED` when effective remaining is
 *      below `estMinThb`.
 *   5. Reject 429 `AI_ORG_QUOTA_EXHAUSTED` when the org-wide monthly
 *      spend is at or above `AI_ORG_MONTHLY_CAP_THB`.
 *   6. Write `request.aiQuotaContext` + `request.aiModelOverride` so
 *      downstream services can honor the 80 % auto-downgrade rule.
 *
 * Hard guardrails:
 *   - Read-only. MUST NOT mutate the quota row. Deduction remains
 *     post-call in `checkAndLogUsage`.
 *   - No project / tracking / workflow imports. Pure AI-layer guard.
 *   - Per §17.11, no role exemption — super-admin hits the same 429.
 *   - MUST run BEFORE `AiCooldownGuard` in the guard chain so an
 *     over-quota rejection does not arm the cooldown timer.
 */
@Injectable()
export class AiQuotaGuard implements CanActivate {
  private readonly logger = new Logger(AiQuotaGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly quotaService: AiUsageQuotasService,
    private readonly orgCapService: QuotaOrgCapService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const weightKey = this.reflector.getAllAndOverride<string | undefined>(
      AI_QUOTA_WEIGHT_METADATA,
      [context.getHandler(), context.getClass()],
    );

    // Endpoints without the decorator are not gated by this guard.
    // Keeps the guard safe to wire into a global scope later.
    if (!weightKey) return true;

    const weight: QuotaWeight | undefined = QUOTA_WEIGHT_MAP[weightKey];
    if (!weight) {
      // A missing entry is ALWAYS a developer error (decorator typo or
      // missing weight-map update). Fail loud — this response is never
      // user-facing because the endpoint shouldn't be in prod without
      // its weight registered.
      throw new InternalServerErrorException({
        code: 'QUOTA_WEIGHT_UNKNOWN',
        weightKey,
        message: `Quota weight not registered for key "${weightKey}"`,
      });
    }

    const request = context
      .switchToHttp()
      .getRequest<
        Request & {
          user?: { userId?: string };
          aiQuotaContext?: unknown;
          aiModelOverride?: string;
        }
      >();
    const response = context.switchToHttp().getResponse<Response>();

    const userId = request.user?.userId;
    if (!userId) {
      // JwtAuthGuard should have populated this. Bail safely.
      throw new UnauthorizedException('User not authenticated');
    }

    const snap = await this.quotaService.getQuotaSnapshot(userId);
    if (!snap) {
      throw new HttpException(
        {
          code: 'AI_QUOTA_MISSING',
          message: 'ไม่มีโควตา AI กรุณาติดต่อผู้ดูแลระบบ',
        },
        HttpStatus.UNAUTHORIZED,
      );
    }

    // If the period has already lapsed and auto-renew is ON, the
    // post-call `checkAndLogUsage` will lazily renew. For the pre-call
    // check, we treat the full limit as effectively available so users
    // aren't blocked at the exact boundary.
    const now = new Date();
    const periodLapsed = now > snap.periodEnd;
    const effectiveRemaining =
      periodLapsed && snap.isAutoRenew
        ? Number(snap.quotaLimit)
        : Number(snap.remainingQuota);

    if (!Number.isFinite(effectiveRemaining) || effectiveRemaining < weight.estMinThb) {
      const retryAfter = Math.max(
        1,
        Math.ceil((snap.periodEnd.getTime() - now.getTime()) / 1000),
      );
      response.setHeader('Retry-After', String(retryAfter));
      throw new HttpException(
        {
          code: 'AI_QUOTA_EXHAUSTED',
          remainingThb: Number(effectiveRemaining.toFixed(4)),
          resetAt: snap.periodEnd.toISOString(),
          isAutoRenew: snap.isAutoRenew,
          message: 'โควตา AI หมดสำหรับรอบนี้',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Org-wide monthly cap (§7.9). Evaluated AFTER the per-user check
    // so users see their own quota error first when both apply.
    const orgCheck = await this.orgCapService.checkOrgCap();
    if (!orgCheck.withinCap) {
      // Compute next calendar-month reset in Asia/Bangkok approximation
      // (system local TZ; acceptable blunt fallback per task §7.9).
      const resetAt = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const retryAfter = Math.max(
        1,
        Math.ceil((resetAt.getTime() - now.getTime()) / 1000),
      );
      response.setHeader('Retry-After', String(retryAfter));
      throw new HttpException(
        {
          code: 'AI_ORG_QUOTA_EXHAUSTED',
          orgConsumedThb: Number(orgCheck.usedThb.toFixed(4)),
          orgCapThb: orgCheck.capThb,
          resetAt: resetAt.toISOString(),
          message: 'ระบบ AI ถึงเพดานการใช้งานรายเดือนขององค์กร',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Auto-downgrade (§7.10). Compute consumed ratio from the SAME
    // snapshot we just validated. Guard writes the resolved model on
    // the request; downstream services (AiService, LlmToolLoopAdapter)
    // read `request.aiModelOverride` and pass it into the LLM client.
    const quotaLimit = Number(snap.quotaLimit);
    const quotaUsed = Number(snap.quotaUsed);
    const consumedRatio =
      quotaLimit > 0 && Number.isFinite(quotaUsed)
        ? quotaUsed / quotaLimit
        : 0;
    const modelOverride = resolveModel(consumedRatio, weight.model);

    request.aiQuotaContext = {
      weightKey,
      remainingBefore: effectiveRemaining,
      consumedRatio,
      modelOverride,
    };
    request.aiModelOverride = modelOverride;

    return true;
  }

  /**
   * Static mid-turn helper for the executive-chat tool loop
   * (BE-W44-02). Does NOT throw — callers inspect `ok` to decide
   * whether to emit `quota_soft_stop` over SSE and return partial
   * output. Matches task §7.8 contract.
   */
  static async checkMidTurn(
    quotaService: AiUsageQuotasService,
    orgCapService: QuotaOrgCapService,
    userId: string,
    weightKey: string,
  ): Promise<{
    ok: boolean;
    reason?: 'USER_QUOTA_EXHAUSTED' | 'ORG_CAP_EXHAUSTED';
    remainingThb: number;
    // W68-FIX-08 (2026-04-28) — extended union to include gpt-4.1 family
    // (mini = new default, nano = auto-downgrade target). gpt-4o family
    // retained for back-compat (other endpoints + auto-title).
    modelOverride?: 'gpt-4o' | 'gpt-4o-mini' | 'gpt-4.1' | 'gpt-4.1-mini' | 'gpt-4.1-nano';
  }> {
    const weight = QUOTA_WEIGHT_MAP[weightKey];
    // Unknown key: fail closed for safety — caller will soft-stop.
    if (!weight) {
      return { ok: false, reason: 'USER_QUOTA_EXHAUSTED', remainingThb: 0 };
    }
    const snap = await quotaService.getQuotaSnapshot(userId);
    if (!snap) {
      return { ok: false, reason: 'USER_QUOTA_EXHAUSTED', remainingThb: 0 };
    }
    const now = new Date();
    const periodLapsed = now > snap.periodEnd;
    const effectiveRemaining =
      periodLapsed && snap.isAutoRenew
        ? Number(snap.quotaLimit)
        : Number(snap.remainingQuota);

    // Mid-turn uses a smaller single-hop threshold: minimum credit for
    // one more hop is estMinThb / (maxHops || 1). Clamp to estMinThb as
    // a ceiling (never require MORE than estMinThb mid-turn).
    const hopThreshold = Math.min(
      weight.estMinThb,
      weight.estMinThb / (weight.maxHops ?? 1),
    );

    if (!Number.isFinite(effectiveRemaining) || effectiveRemaining < hopThreshold) {
      return {
        ok: false,
        reason: 'USER_QUOTA_EXHAUSTED',
        remainingThb: Number.isFinite(effectiveRemaining)
          ? effectiveRemaining
          : 0,
      };
    }

    const orgCheck = await orgCapService.checkOrgCap();
    if (!orgCheck.withinCap) {
      return {
        ok: false,
        reason: 'ORG_CAP_EXHAUSTED',
        remainingThb: effectiveRemaining,
      };
    }

    const quotaLimit = Number(snap.quotaLimit);
    const quotaUsed = Number(snap.quotaUsed);
    const consumedRatio =
      quotaLimit > 0 && Number.isFinite(quotaUsed)
        ? quotaUsed / quotaLimit
        : 0;
    return {
      ok: true,
      remainingThb: effectiveRemaining,
      modelOverride: resolveModel(consumedRatio, weight.model),
    };
  }
}
