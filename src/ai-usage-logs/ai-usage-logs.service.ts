import { Injectable, NotFoundException, InternalServerErrorException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateAiUsageLogDto } from './dto/create-ai-usage-log.dto';
import { UpdateAiUsageLogDto } from './dto/update-ai-usage-log.dto';
import { AiUsageLog } from './entities/ai-usage-log.entity';
import { AiUsageLogResponseDto } from './dto/ai-usage-log-response.dto';
import { handleException } from 'src/util/handleException';

@Injectable()
export class AiUsageLogsService {
  private readonly logger = new Logger(AiUsageLogsService.name);

  constructor(
    @InjectRepository(AiUsageLog)
    private readonly aiUsageLogRepository: Repository<AiUsageLog>,
  ) {}

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
        relations: ['aiUsageQuota'],
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
        relations: ['aiUsageQuota'],
      });
      if (!log) {
        throw new NotFoundException(`AI Usage Log with ID ${id} not found`);
      }
      return this.mapToResponseDto(log);
    } catch (error) {
      handleException( this.logger , error)
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
}
