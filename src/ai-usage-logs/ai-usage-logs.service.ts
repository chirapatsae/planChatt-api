import { Injectable, NotFoundException, InternalServerErrorException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateAiUsageLogDto } from './dto/create-ai-usage-log.dto';
import { AiUsageLog } from './entities/ai-usage-log.entity';
import { AiUsageLogResponseDto } from './dto/ai-usage-log-response.dto';
import { handleException } from 'src/util/handleException';

@Injectable()
export class AiUsageLogsService {
  private readonly logger = new Logger(AiUsageLogsService.name);

  constructor(
    @InjectRepository(AiUsageLog)
    private readonly aiUsageLogRepository: Repository<AiUsageLog>,
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

  private mapToResponseDto(log: AiUsageLog): AiUsageLogResponseDto {
    return {
      id: log.id,
      usageType: log.usageType,
      inputTextLength: log.inputTextLength,
      outputTextLength: log.outputTextLength,
      costBaht: log.costBaht,
      usedAt: log.used_at,
      aiUsageQuota: log.aiUsageQuota,
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

      const allusageTypes = ['PROJECT_GENERATION', 'FIELD_REGENERATION', 'SMART_APPROVE_ANALYSIS'];
      const usageByTypeMap = new Map(usageByType.map(item => [item.usage_type, item]));

      const completeUsageByType = allusageTypes.map(type => {
        const item = usageByTypeMap.get(type);
        return {
          type,
          count: item ? Number(item.request_count) : 0,
          cost: item ? Number(item.total_cost) : 0
        };
      });

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

      return {
        overview: {
          totalRequests: Number(overview.total_requests || 0),
          totalCost: Number(overview.total_cost || 0),
          totalTokens: Number(overview.total_input_tokens || 0) + Number(overview.total_output_tokens || 0),
          uniqueUsers: Number(overview.unique_users || 0),
        },
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
