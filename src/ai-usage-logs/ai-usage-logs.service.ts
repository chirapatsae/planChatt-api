import { Injectable, NotFoundException, InternalServerErrorException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { CreateAiUsageLogDto } from './dto/create-ai-usage-log.dto';
import { AiUsageLog } from './entities/ai-usage-log.entity';
import { AiUsageLogResponseDto } from './dto/ai-usage-log-response.dto';
import { handleException } from 'src/util/handleException';
import { AiUsageQuota } from 'src/ai-usage-quotas/entities/ai-usage-quota.entity';

@Injectable()
export class AiUsageLogsService {
  private readonly logger = new Logger(AiUsageLogsService.name);

  constructor(
    @InjectRepository(AiUsageLog)
    private readonly aiUsageLogRepository: Repository<AiUsageLog>,
    @InjectRepository(AiUsageQuota)
    private readonly aiUsageQuotaRepository: Repository<AiUsageQuota>,
  ) { }

  async create(createAiUsageLogDto: CreateAiUsageLogDto): Promise<AiUsageLogResponseDto> {
    try {
      const aiUsageLog = this.aiUsageLogRepository.create({
        ...createAiUsageLogDto,
        aiUsageQuota: createAiUsageLogDto.aiUsageQuotaId ? { id: createAiUsageLogDto.aiUsageQuotaId } : undefined,
      });
      const savedLog = await this.aiUsageLogRepository.save(aiUsageLog);
      return this.mapToResponseDto(savedLog);
    } catch (error) {
      throw new InternalServerErrorException(error.message);
    }
  }

  async findAll(): Promise<AiUsageLogResponseDto[]> {
    try {
      const logs = await this.aiUsageLogRepository.find({
        relations: {
          aiUsageQuota: {
            user: true,
          },
        },
        order: { used_at: 'DESC' },
      });
      return logs.map(log => this.mapToResponseDto(log));
    } catch (error) {
      throw new InternalServerErrorException(error.message);
    }
  }

  async findOne(id: string): Promise<AiUsageLogResponseDto> {
    try {
      const log = await this.aiUsageLogRepository.findOne({
        where: { id },
        relations: {
          aiUsageQuota: {
            user: true,
          },
        },
      });
      if (!log) {
        throw new NotFoundException(`AI Usage Log with ID ${id} not found`);
      }
      return this.mapToResponseDto(log);
    } catch (error) {
      handleException(this.logger, error)
    }
  }

  /**
   * Wave 36 N3 — owner-scoped detail lookup.
   *
   * Ownership chain: AiUsageLog → AiUsageQuota.user.id === userId.
   * Mismatch returns 404 (NOT 403) to prevent enumeration of other
   * users' log IDs. Missing row also returns 404. Both cases throw
   * the same `NotFoundException` so the caller cannot distinguish
   * "does not exist" from "exists but not yours".
   *
   * §17.2 advisory read / §17.3 audit separation preserved — this
   * method does NOT mutate any row and does NOT touch tracking_status.
   */
  async findDetailForUser(id: string, userId: string): Promise<AiUsageLogResponseDto> {
    const log = await this.aiUsageLogRepository.findOne({
      where: { id },
      relations: {
        aiUsageQuota: {
          user: true,
        },
      },
    });
    if (!log) {
      throw new NotFoundException('Usage log not found');
    }
    // Ownership check — return 404 (not 403) to prevent enumeration.
    if (log.aiUsageQuota?.user?.id !== userId) {
      throw new NotFoundException('Usage log not found');
    }
    return this.mapToResponseDto(log);
  }

  private mapToResponseDto(log: AiUsageLog): AiUsageLogResponseDto {
    return {
      id: log.id,
      usageType: log.usageType,
      // Wave 37 hotfix — include fields that the entity always stored
      // but the mapper previously omitted, so the FE drawer shows real
      // values instead of placeholder "-".
      modelName: log.modelName,
      inputTokens: log.inputTokens,
      outputTokens: log.outputTokens,
      inputTextLength: log.inputTextLength,
      outputTextLength: log.outputTextLength,
      costBaht: log.costBaht,
      usedAt: log.used_at,
      aiUsageQuota: log.aiUsageQuota,
      // Wave 36 N1 — detail-log fields (nullable passthrough)
      endpoint: log.endpoint ?? null,
      summaryTh: log.summaryTh ?? null,
      requestPayload: log.requestPayload ?? null,
      responsePayload: log.responsePayload ?? null,
      targetId: log.targetId ?? null,
      targetKind: log.targetKind ?? null,
      actorWorkHistoryId: log.actorWorkHistoryId ?? null,
      durationMs: log.durationMs ?? null,
      error: log.error ?? null,
    };
  }

  async getStats(year?: number): Promise<any> {
    try {
      const queryBuilder = this.aiUsageLogRepository.createQueryBuilder('log');

      if (year) {
        queryBuilder.where('EXTRACT(YEAR FROM log.used_at) = :year', { year });
      }

      // 1. Overview Stats
      const overview = await queryBuilder
        .select([
          'COUNT(log.id) as total_requests',
          'SUM(log.costBaht) as total_cost',
          'SUM(log.inputTokens) as total_input_tokens',
          'SUM(log.outputTokens) as total_output_tokens',
          'COUNT(DISTINCT log.aiUsageQuota) as unique_users' // Approximate unique quotas as users
        ])
        .getRawOne();

      // 2. Usage by Type
      const usageByType = await this.aiUsageLogRepository
        .createQueryBuilder('log')
        .select([
          'log.usageType as usage_type',
          'COUNT(log.id) as request_count',
          'SUM(log.costBaht) as total_cost'
        ])
        .where(year ? 'EXTRACT(YEAR FROM log.used_at) = :year' : '1=1', { year })
        .groupBy('log.usageType')
        .getRawMany();

      // Authoring types — always shown (zero-filled) so they stay visible even
      // before first use. Any OTHER usageType actually present in the logs
      // (e.g. 'executive-chat', 'executive-chat-autotitle', 'PDPA_ADMIN_DELETE')
      // is appended so the breakdown reflects EVERY real usage type — previously
      // these were silently dropped because only the five below were mapped.
      const knownUsageTypes = ['PROJECT_GENERATION', 'FIELD_REGENERATION', 'SMART_APPROVE_ANALYSIS', 'PRE_SUBMIT_REVIEW', 'DOCUMENT_SUMMARY'];
      const usageByTypeMap = new Map(usageByType.map(item => [item.usage_type, item]));

      const completeUsageByType = [
        ...knownUsageTypes.map(type => {
          const item = usageByTypeMap.get(type);
          return {
            type,
            count: item ? Number(item.request_count) : 0,
            cost: item ? Number(item.total_cost) : 0,
          };
        }),
        ...usageByType
          .filter(item => !knownUsageTypes.includes(item.usage_type))
          .map(item => ({
            type: item.usage_type,
            count: Number(item.request_count),
            cost: Number(item.total_cost),
          })),
      ];

      // 3. Top 5 Users
      const topUsers = await this.aiUsageLogRepository
        .createQueryBuilder('log')
        .leftJoinAndSelect('log.aiUsageQuota', 'quota')
        .leftJoinAndSelect('quota.user', 'user')
        .select([
          'user.id as user_id',
          'user.firstname as firstname',
          'user.lastname as lastname',
          'user.email as email',
          'SUM(log.costBaht) as total_cost',
          'COUNT(log.id) as request_count'
        ])
        .where(year ? 'EXTRACT(YEAR FROM log.used_at) = :year' : '1=1', { year })
        .groupBy('user.id, user.firstname, user.lastname, user.email')
        .orderBy('total_cost', 'DESC')
        .limit(5)
        .getRawMany();

      // 4. Monthly Trends
      const monthlyTrends = await this.aiUsageLogRepository
        .createQueryBuilder('log')
        .select([
          'TO_CHAR(log.used_at, \'YYYY-MM\') as month',
          'COUNT(log.id) as request_count',
          'SUM(log.costBaht) as total_cost'
        ])
        .where(year ? 'EXTRACT(YEAR FROM log.used_at) = :year' : '1=1', { year })
        .groupBy('month')
        .orderBy('month', 'ASC')
        .getRawMany();

      // 5. Quota summary — aggregate across all non-deleted quota rows
      // (1 row = 1 user × current period). Numbers are baht (numeric in
      // DB, normalize to Number for JSON). `quota_used` is the canonical
      // ledger; `remaining_quota` is a denormalized convenience column.
      const quotaAgg = await this.aiUsageQuotaRepository
        .createQueryBuilder('q')
        .select([
          'SUM(q.quotaLimit) AS total_limit',
          'SUM(q.quotaUsed) AS total_used',
          'SUM(q.remainingQuota) AS total_remaining',
          'COUNT(q.id) AS users_with_quota',
          'SUM(CASE WHEN q.quotaUsed > 0 THEN 1 ELSE 0 END) AS users_who_have_used',
          'SUM(CASE WHEN q.quotaLimit > 0 AND (q.quotaUsed / q.quotaLimit) >= 0.8 THEN 1 ELSE 0 END) AS users_near_limit',
          'MIN(q.periodStart) AS earliest_period_start',
          'MAX(q.periodEnd) AS latest_period_end',
        ])
        .where('q.deletedAt IS NULL')
        .getRawOne();

      const totalLimit = Number(quotaAgg?.total_limit ?? 0);
      const totalUsed = Number(quotaAgg?.total_used ?? 0);
      const totalRemaining = Number(quotaAgg?.total_remaining ?? 0);
      const utilizationPercent =
        totalLimit > 0 ? Math.round((totalUsed / totalLimit) * 1000) / 10 : 0;

      // 6. Per-user quota — top 10 by quotaUsed (active quotas only).
      // Joins user for display name + sorts desc so heavy users surface.
      const perUserQuota = await this.aiUsageQuotaRepository
        .createQueryBuilder('q')
        .leftJoin('q.user', 'u')
        .select([
          'q.id AS quota_id',
          'u.id AS user_id',
          'u.firstname AS firstname',
          'u.lastname AS lastname',
          'q.quotaLimit AS quota_limit',
          'q.quotaUsed AS quota_used',
          'q.remainingQuota AS remaining_quota',
          'q.periodStart AS period_start',
          'q.periodEnd AS period_end',
        ])
        .where('q.deletedAt IS NULL')
        .orderBy('q.quotaUsed', 'DESC')
        .limit(10)
        .getRawMany();

      // 7. Error rate + average duration / cost — useful operational stats
      //    that the exec page can surface alongside business metrics.
      const opsAgg = await this.aiUsageLogRepository
        .createQueryBuilder('log')
        .select([
          'COUNT(log.id) AS total_calls',
          'SUM(CASE WHEN log.error IS NOT NULL THEN 1 ELSE 0 END) AS error_calls',
          'AVG(log.durationMs) AS avg_duration_ms',
          'AVG(log.costBaht) AS avg_cost_per_call',
        ])
        .where(year ? 'EXTRACT(YEAR FROM log.used_at) = :year' : '1=1', { year })
        .getRawOne();

      const totalCalls = Number(opsAgg?.total_calls ?? 0);
      const errorCalls = Number(opsAgg?.error_calls ?? 0);
      const errorRatePercent =
        totalCalls > 0 ? Math.round((errorCalls / totalCalls) * 1000) / 10 : 0;

      return {
        overview: {
          totalRequests: Number(overview.total_requests || 0),
          totalCost: Number(overview.total_cost || 0),
          totalTokens: Number(overview.total_input_tokens || 0) + Number(overview.total_output_tokens || 0),
          uniqueUsers: Number(overview.unique_users || 0),
        },
        // NEW — quota summary (system-wide AI budget visibility)
        quotaSummary: {
          totalLimit,
          totalUsed,
          totalRemaining,
          utilizationPercent,
          usersWithQuota: Number(quotaAgg?.users_with_quota ?? 0),
          usersWhoHaveUsed: Number(quotaAgg?.users_who_have_used ?? 0),
          usersNearLimit: Number(quotaAgg?.users_near_limit ?? 0),
          currentPeriodStart: quotaAgg?.earliest_period_start ?? null,
          currentPeriodEnd: quotaAgg?.latest_period_end ?? null,
        },
        // NEW — ops metrics (error rate + average latency / cost)
        opsMetrics: {
          totalCalls,
          errorCalls,
          errorRatePercent,
          avgDurationMs: Math.round(Number(opsAgg?.avg_duration_ms ?? 0)),
          avgCostPerCall: Number(opsAgg?.avg_cost_per_call ?? 0),
        },
        // NEW — per-user quota (top 10 by usage)
        perUserQuota: perUserQuota.map((r: Record<string, unknown>) => ({
          userId: r.user_id as string | null,
          name:
            r.firstname || r.lastname
              ? `${r.firstname ?? ''} ${r.lastname ?? ''}`.trim()
              : '—',
          quotaLimit: Number(r.quota_limit ?? 0),
          quotaUsed: Number(r.quota_used ?? 0),
          remainingQuota: Number(r.remaining_quota ?? 0),
          utilizationPercent:
            Number(r.quota_limit ?? 0) > 0
              ? Math.round(
                  (Number(r.quota_used ?? 0) / Number(r.quota_limit ?? 0)) *
                    1000,
                ) / 10
              : 0,
          periodStart: r.period_start,
          periodEnd: r.period_end,
        })),
        usageByType: completeUsageByType,
        topUsers: topUsers.map(user => ({
          userId: user.user_id,
          name: `${user.firstname} ${user.lastname}`,
          email: user.email,
          totalCost: Number(user.total_cost),
          requestCount: Number(user.request_count)
        })),
        monthlyTrends: monthlyTrends.map(item => ({
          month: item.month,
          count: Number(item.request_count),
          cost: Number(item.total_cost)
        }))
      };

    } catch (error) {
      this.logger.error('Failed to get AI usage stats', error.stack);
      throw new InternalServerErrorException('Failed to retrieve statistics');
    }
  }
}
