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

@Injectable()
export class AiUsageQuotasService {
  private readonly logger = new Logger(AiUsageQuotasService.name);

  constructor(
    @InjectRepository(AiUsageQuota)
    private readonly aiUsageQuotaRepository: Repository<AiUsageQuota>,

    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

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

      aiUsageQuota.quotaUsed += usageAmount;
      aiUsageQuota.remainingQuota = aiUsageQuota.quotaLimit - aiUsageQuota.quotaUsed;

      if (aiUsageQuota.remainingQuota < 0) {
        throw new UnauthorizedException('Quota limit exceeded');
      }

      return await this.aiUsageQuotaRepository.save(aiUsageQuota);
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}
