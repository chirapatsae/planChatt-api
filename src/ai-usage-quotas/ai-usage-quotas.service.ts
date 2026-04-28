import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { CreateAiUsageQuotaDto } from './dto/create-ai-usage-quota.dto';
import { UpdateAiUsageQuotaDto } from './dto/update-ai-usage-quota.dto';
import { AiUsageQuota } from './entities/ai-usage-quota.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { handleException } from 'src/util/handleException';
import { User } from 'src/users/entities/user.entity';
import { AiUsageLogsService } from 'src/ai-usage-logs/ai-usage-logs.service';
import { CreateAiUsageLogDto } from 'src/ai-usage-logs/dto/create-ai-usage-log.dto';
// Wave 44 / BE-W44-03 — config-driven FX. Replaces the hardcoded
// `* 34` USD→THB multiplier that previously lived inline in
// `checkAndLogUsage`. Reads `OPENAI_USD_TO_THB_FX` per call.
import { getUsdToThbFx } from './fx-config';
import { resolveModel } from './quota-model-override';
import { QUOTA_WEIGHT_MAP, QuotaWeightModel } from './quota-weight.map';

@Injectable()
export class AiUsageQuotasService {
  private readonly logger = new Logger(AiUsageQuotasService.name);

  constructor(
    @InjectRepository(AiUsageQuota)
    private readonly aiUsageQuotaRepository: Repository<AiUsageQuota>,

    @InjectRepository(User)
    private readonly userRepository: Repository<User>,

    private readonly aiUsageLogsService: AiUsageLogsService,
  ) { }

  async createDefaultQuota(userId: string): Promise<AiUsageQuota> {
    try {
      const existingQuota = await this.aiUsageQuotaRepository.findOne({
        where: { user: { id: userId }, deletedAt: undefined },
      });

      if (existingQuota) {
        this.logger.warn(`User ${userId} already has a quota. Skipping default creation.`);
        return existingQuota;
      }

      const user = await this.userRepository.findOne({ where: { id: userId } });
      if (!user) {
        throw new NotFoundException(`User with ID ${userId} not found`);
      }

      // Default: Monthly Quota (300 THB), Auto-Renew: True
      const now = new Date();
      const nextMonth = new Date(now);
      nextMonth.setMonth(now.getMonth() + 1);

      const defaultQuota = this.aiUsageQuotaRepository.create({
        periodStart: now,
        periodEnd: nextMonth,
        quotaLimit: 300,
        quotaUsed: 0,
        remainingQuota: 300,
        isAutoRenew: true,
        user,
      });

      return await this.aiUsageQuotaRepository.save(defaultQuota);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async create(dto: CreateAiUsageQuotaDto, userId: string): Promise<AiUsageQuota> {
    try {
      const user = await this.userRepository.findOne({
        where: { id: userId },
      });
      if (!user) {
        throw new UnauthorizedException(
          'Invalid user. User not found.',
        );
      }

      // Check if user already has an active quota
      const existingQuota = await this.aiUsageQuotaRepository.findOne({
        where: { user: { id: userId }, deletedAt: undefined },
      });

      if (existingQuota) {
        throw new UnauthorizedException(
          'User already has an active AI usage quota.',
        );
      }

      const { periodStart, periodEnd, quotaLimit, quotaUsed = 0 } = dto;
      const remainingQuota = quotaLimit - quotaUsed;

      const aiUsageQuota = this.aiUsageQuotaRepository.create({
        periodStart,
        periodEnd,
        quotaLimit,
        quotaUsed,
        remainingQuota,
        isAutoRenew: true, // Default to true for manual creation too? Or maybe add to DTO later.
        user,
      });

      return await this.aiUsageQuotaRepository.save(aiUsageQuota);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll(): Promise<AiUsageQuota[]> {
    this.logger.log('Fetching all AI usage quotas');
    try {
      return await this.aiUsageQuotaRepository.find({
        where: { deletedAt: undefined },
        relations: ['user'],
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<AiUsageQuota> {
    this.logger.log(`Fetching AI usage quota with ID: ${id}`);
    try {
      const aiUsageQuota = await this.aiUsageQuotaRepository.findOne({
        where: { id },
        relations: ['user'],
      });
      if (!aiUsageQuota) {
        throw new NotFoundException(`AI usage quota with ID ${id} not found`);
      }
      return aiUsageQuota;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(
    id: string,
    updateAiUsageQuotaDto: UpdateAiUsageQuotaDto,
  ): Promise<AiUsageQuota> {
    try {
      const aiUsageQuotaToUpdate = await this.aiUsageQuotaRepository.preload({
        id: id,
        ...updateAiUsageQuotaDto,
      });
      if (!aiUsageQuotaToUpdate) {
        throw new NotFoundException(`AI usage quota with ID ${id} not found`);
      }
      return await this.aiUsageQuotaRepository.save(aiUsageQuotaToUpdate);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.aiUsageQuotaRepository.delete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`AI usage quota with ID ${id} not found`);
      }
      return {
        message: `AI usage quota with ID ${id} has been permanently removed.`,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async softRemove(id: string): Promise<{ message: string }> {
    try {
      const aiUsageQuota = await this.aiUsageQuotaRepository.findOne({ where: { id } });
      if (!aiUsageQuota) {
        throw new NotFoundException(`AI usage quota with ID ${id} not found`);
      }

      await this.aiUsageQuotaRepository.softRemove(aiUsageQuota);

      return { message: `AI usage quota with ID ${id} has been soft-removed.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async restore(id: string): Promise<{ message: string }> {
    try {
      const result = await this.aiUsageQuotaRepository.restore(id);
      if (result.affected === 0) {
        throw new NotFoundException(
          `AI usage quota with ID ${id} not found or was not deleted.`,
        );
      }
      return { message: `AI usage quota with ID ${id} has been restored.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async incrementUsage(id: string, usageAmount: number = 1): Promise<AiUsageQuota> {
    try {
      const aiUsageQuota = await this.aiUsageQuotaRepository.findOne({
        where: { id },
      });
      if (!aiUsageQuota) {
        throw new NotFoundException(`AI usage quota with ID ${id} not found`);
      }

      const currentUsed = Number(aiUsageQuota.quotaUsed);
      const limit = Number(aiUsageQuota.quotaLimit);

      aiUsageQuota.quotaUsed = currentUsed + usageAmount;
      aiUsageQuota.remainingQuota = limit - aiUsageQuota.quotaUsed;

      if (aiUsageQuota.remainingQuota < 0) {
        throw new UnauthorizedException('Quota limit exceeded');
      }

      return await this.aiUsageQuotaRepository.save(aiUsageQuota);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async toggleAutoRenew(userId: string): Promise<{ isAutoRenew: boolean, message: string }> {
    try {
      const quota = await this.aiUsageQuotaRepository.findOne({
        where: { user: { id: userId }, deletedAt: undefined },
      });

      if (!quota) {
        throw new NotFoundException('User does not have an active AI quota.');
      }

      quota.isAutoRenew = !quota.isAutoRenew;

      // If toggled ON and currently expired, renew immediately
      const now = new Date();
      if (quota.isAutoRenew && now > quota.periodEnd) {
        const nextMonth = new Date(now);
        nextMonth.setMonth(now.getMonth() + 1);

        quota.periodStart = now;
        quota.periodEnd = nextMonth;
        quota.quotaUsed = 0;
        quota.remainingQuota = 300; // Reset to 300
        this.logger.log(`User ${userId} toggled auto-renew ON. Immediate renewal triggered.`);
      }

      await this.aiUsageQuotaRepository.save(quota);

      return {
        isAutoRenew: quota.isAutoRenew,
        message: `Auto-renew is now ${quota.isAutoRenew ? 'ON' : 'OFF'}`
      };

    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async backfillQuotas(): Promise<{ processed: number, created: number, errors: number, details: any[] }> {
    this.logger.log('Starting backfill of AI usage quotas...');
    const result: { processed: number, created: number, errors: number, details: any[] } = {
      processed: 0,
      created: 0,
      errors: 0,
      details: [],
    };

    try {
      // Fetch all users
      // Optimization: In a real large-scale app, we should use pagination or a stream. 
      // For now, fetching all is acceptable assuming reasonable user count.
      // Better yet: Query only users who do NOT have a quota.
      // Better yet: Query users who do NOT have a quota OR have a quota with limit <= 0
      const usersToProcess = await this.userRepository
        .createQueryBuilder('user')
        .leftJoinAndSelect('user.aiUsageQuota', 'quota', 'quota.deletedAt IS NULL')
        .where('quota.id IS NULL OR quota.quotaLimit <= 0')
        .getMany();

      this.logger.log(`Found ${usersToProcess.length} users with missing or zero-limit quotas.`);

      for (const user of usersToProcess) {
        result.processed++;
        try {
          if (!user.aiUsageQuota) {
            // Create new quota
            await this.createDefaultQuota(user.id);
            result.created++;
            result.details.push({ userId: user.id, status: 'created' });
          } else {
            // Fix existing zero quota
            user.aiUsageQuota.quotaLimit = 300;
            user.aiUsageQuota.remainingQuota = 300;
            // Reset used? Maybe used is correct, but limit was wrong.
            // If limit was 0, used should be 0 too, or maybe negative remaining if they used something?
            // Safest is to reset to clean slate.
            user.aiUsageQuota.quotaUsed = 0;

            await this.aiUsageQuotaRepository.save(user.aiUsageQuota);
            result.created++; // Count as "fixed/created"
            result.details.push({ userId: user.id, status: 'fixed_zero_limit' });
          }
        } catch (error) {
          result.errors++;
          result.details.push({ userId: user.id, status: 'error', error: error.message });
          this.logger.error(`Failed to process quota for user ${user.id}`, error.stack);
        }
      }

      this.logger.log(`Backfill completed. Created: ${result.created}, Errors: ${result.errors}`);
      return result;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Wave 36 N2 — helper for `AiService` / `LandUseClassifierService` to
   * resolve the current quota row id for a user WITHOUT going through
   * `checkAndLogUsage`. Used for the rich-detail `ai_usage_logs` writes
   * added in Wave 36 so the detail row carries the correct
   * `aiUsageQuotaId` FK (Wave 18 quota ownership).
   *
   * Returns `null` when the user has no active quota row — callers must
   * treat logging as best-effort per §17.2 and must NOT throw.
   */
  async findQuotaIdByUserId(userId: string): Promise<string | null> {
    try {
      const quota = await this.aiUsageQuotaRepository.findOne({
        where: { user: { id: userId }, deletedAt: undefined },
        select: ['id'],
      });
      return quota?.id ?? null;
    } catch (err) {
      this.logger.warn(
        `[ai-usage-quotas] findQuotaIdByUserId failed for userId=${userId}: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  async checkAndLogUsage(
    userId: string,
    costUsd: number,
    metadata?: {
      usageType: string;
      inputTokens: number;
      outputTokens: number;
      /**
       * Optional model attribution override.
       * Back-compat: when undefined, defaults to 'gpt-4o' — keeps every
       * existing call site (ai.service.ts PRE_SUBMIT_REVIEW, AI_PROJECT_ASSISTANT, etc.)
       * logging `gpt-4o` exactly as before.
       * New call sites (DOCUMENT_SUMMARY uses gpt-4o-mini) SHOULD pass the
       * actual model name so dashboard cost attribution is accurate.
       */
      modelName?: string;
    }
  ): Promise<void> {
    try {
      // 1. Fetch user's quota
      const quota = await this.aiUsageQuotaRepository.findOne({
        where: { user: { id: userId }, deletedAt: undefined },
      });

      if (!quota) {
        throw new UnauthorizedException('ผู้เข้าใช้งานไม่มีโควตา AI ที่ใช้งานได้');
      }

      const now = new Date();

      // 2. Check for Expiration & Renewal
      if (now > quota.periodEnd) {
        if (quota.isAutoRenew) {
          // Lazy Auto-Renewal
          const nextMonth = new Date(now);
          nextMonth.setMonth(now.getMonth() + 1);

          quota.periodStart = now;
          quota.periodEnd = nextMonth;
          quota.quotaUsed = 0;
          quota.remainingQuota = 300; // Reset to monthly limit

          this.logger.log(`User ${userId} quota auto-renewed. New period: ${quota.periodStart} - ${quota.periodEnd}`);
          // We save here to ensure the renewal is persisted even if the subsequent usage check fails (though it shouldn't for a fresh quota)
          await this.aiUsageQuotaRepository.save(quota);
        } else {
          throw new UnauthorizedException('โควตาของคุณหมดอายุแล้ว กรุณาเปิดใช้งานการต่ออายุอัตโนมัติเพื่อดำเนินการต่อ');
        }
      }

      // 3. Convert Cost to THB. Wave 44 / BE-W44-03 — FX is now
      // config-driven via `OPENAI_USD_TO_THB_FX` (default 34). Read per
      // call so ops can rotate the rate without a backend restart.
      const exchangeRate = getUsdToThbFx();
      const costThb = costUsd * exchangeRate;

      // 4. Check remaining quota
      const currentRemaining = Number(quota.remainingQuota);
      if (currentRemaining < costThb) {
        throw new UnauthorizedException(
          `ยอดเงินคงเหลือของคุณไม่เพียงพอ (ค่าใช้จ่าย: ${costThb.toFixed(2)} บาท, คงเหลือ: ${currentRemaining.toFixed(2)} บาท)`,
        );
      }

      // 5. Deduct quota
      const currentUsed = Number(quota.quotaUsed);
      const limit = Number(quota.quotaLimit);

      quota.quotaUsed = currentUsed + costThb;
      quota.remainingQuota = limit - quota.quotaUsed;

      await this.aiUsageQuotaRepository.save(quota);

      // 6. Log Usage (Transaction Log)
      if (metadata) {
        const createLogDto: CreateAiUsageLogDto = {
          usageType: metadata.usageType,
          // Back-compat: fall back to 'gpt-4o' for any caller that does not
          // supply modelName. DOCUMENT_SUMMARY passes 'gpt-4o-mini'.
          modelName: metadata.modelName ?? 'gpt-4o',
          inputTokens: metadata.inputTokens,
          outputTokens: metadata.outputTokens,
          inputTextLength: 0, // Optional or calculated if needed
          outputTextLength: 0, // Optional or calculated if needed
          costBaht: costThb,
          aiUsageQuotaId: quota.id
        }
        await this.aiUsageLogsService.create(createLogDto);
      }

      this.logger.log(
        `User ${userId} AI usage deducted: ${costThb.toFixed(2)} THB. Remaining: ${quota.remainingQuota.toFixed(2)} THB`,
      );
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Wave 44 / BE-W44-03 — pre-call guard support + FE-facing snapshot.
  //
  // These methods are READ-ONLY. They MUST NOT mutate the quota row —
  // deduction remains the exclusive responsibility of `checkAndLogUsage`.
  // Per §17.2 / §17.11, no role exemption is applied here; the guard
  // handles rejection uniformly for every role.
  // ────────────────────────────────────────────────────────────────────

  /**
   * Read-only snapshot of a user's active quota row for the pre-call
   * `AiQuotaGuard`. Returns `null` when no active quota exists so the
   * guard can surface a 401 `AI_QUOTA_MISSING`.
   */
  async getQuotaSnapshot(
    userId: string,
  ): Promise<Pick<
    AiUsageQuota,
    | 'id'
    | 'quotaLimit'
    | 'quotaUsed'
    | 'remainingQuota'
    | 'periodStart'
    | 'periodEnd'
    | 'isAutoRenew'
  > | null> {
    try {
      const quota = await this.aiUsageQuotaRepository.findOne({
        where: { user: { id: userId }, deletedAt: undefined },
        select: [
          'id',
          'quotaLimit',
          'quotaUsed',
          'remainingQuota',
          'periodStart',
          'periodEnd',
          'isAutoRenew',
        ],
      });
      return quota ?? null;
    } catch (err) {
      this.logger.warn(
        `[ai-usage-quotas] getQuotaSnapshot failed for userId=${userId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
      return null;
    }
  }

  /**
   * Consumed ratio (`quotaUsed / quotaLimit`) for the 80 % auto-downgrade
   * helper. Returns 0 for missing / invalid rows so callers default to
   * the declared model. Safe on expired-and-auto-renew rows because
   * auto-renew happens lazily in `checkAndLogUsage` — the ratio will
   * correctly report 0 on the next call after renewal.
   */
  async getQuotaRatio(userId: string): Promise<number> {
    const snap = await this.getQuotaSnapshot(userId);
    if (!snap) return 0;
    const limit = Number(snap.quotaLimit);
    const used = Number(snap.quotaUsed);
    if (!Number.isFinite(limit) || limit <= 0) return 0;
    if (!Number.isFinite(used) || used < 0) return 0;
    return used / limit;
  }

  /**
   * FE-facing snapshot for the quota pill / header indicator.
   *
   * Returns a stable shape so FE code doesn't need to know about the
   * underlying row. `percentUsed` is rounded to one decimal for display
   * stability (avoids jittering at 79.997 → 80.003).
   */
  async getQuotaSnapshotForUi(userId: string): Promise<{
    usedThb: number;
    limitThb: number;
    percentUsed: number;
    remainingThb: number;
    periodEnd: string;
    isAutoRenew: boolean;
  } | null> {
    const snap = await this.getQuotaSnapshot(userId);
    if (!snap) return null;
    const limit = Number(snap.quotaLimit);
    const used = Number(snap.quotaUsed);
    const remaining = Number(snap.remainingQuota);
    const percent = limit > 0 ? (used / limit) * 100 : 0;
    return {
      usedThb: Number.isFinite(used) ? Number(used.toFixed(4)) : 0,
      limitThb: Number.isFinite(limit) ? Number(limit.toFixed(4)) : 0,
      percentUsed: Number(percent.toFixed(1)),
      remainingThb: Number.isFinite(remaining) ? Number(remaining.toFixed(4)) : 0,
      periodEnd: snap.periodEnd.toISOString(),
      isAutoRenew: snap.isAutoRenew,
    };
  }

  /**
   * Per-hop gate for the executive-chat tool loop (BE-W44-02 adapter).
   *
   * Unlike the pre-call guard, this helper does NOT throw — it returns
   * a structured verdict so the adapter can decide to emit
   * `quota_soft_stop` over SSE and return partial output. See task
   * §7.8 for the end-to-end soft-stop contract.
   */
  async checkMidTurn(
    userId: string,
    estimatedNextHopUsd: number,
  ): Promise<{ canProceed: boolean; reason?: string; remainingThb: number }> {
    const snap = await this.getQuotaSnapshot(userId);
    if (!snap) {
      return { canProceed: false, reason: 'QUOTA_MISSING', remainingThb: 0 };
    }
    const now = new Date();
    const periodLapsed = now > snap.periodEnd;
    const effectiveRemaining =
      periodLapsed && snap.isAutoRenew
        ? Number(snap.quotaLimit)
        : Number(snap.remainingQuota);
    const costThb = estimatedNextHopUsd * getUsdToThbFx();

    if (!Number.isFinite(effectiveRemaining) || effectiveRemaining < costThb) {
      return {
        canProceed: false,
        reason: 'USER_QUOTA_EXHAUSTED',
        remainingThb: Number.isFinite(effectiveRemaining)
          ? effectiveRemaining
          : 0,
      };
    }
    return {
      canProceed: true,
      remainingThb: effectiveRemaining,
    };
  }

  /**
   * Thin wrapper around `quota-model-override.resolveModel` so services
   * can ask "should I downgrade?" without importing the helper directly.
   * Falls back to the requested model on any lookup failure.
   */
  async resolveModel(
    userId: string,
    requestedModel: QuotaWeightModel,
  ): Promise<QuotaWeightModel> {
    const ratio = await this.getQuotaRatio(userId);
    return resolveModel(ratio, requestedModel);
  }

  /**
   * Convenience: estimate the hop cost in USD using the central weight
   * map (`estMinThb` scaled through FX). Used by BE-W44-02 when the
   * caller only knows the endpoint key and not an actual USD estimate.
   */
  estimateHopCostUsd(weightKey: string): number {
    const weight = QUOTA_WEIGHT_MAP[weightKey];
    if (!weight) return 0;
    const fx = getUsdToThbFx();
    if (!Number.isFinite(fx) || fx <= 0) return 0;
    return weight.estMinThb / fx;
  }
}
