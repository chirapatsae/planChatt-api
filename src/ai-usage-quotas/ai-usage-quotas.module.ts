import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiUsageQuotasService } from './ai-usage-quotas.service';
import { AiUsageQuotasController } from './ai-usage-quotas.controller';
import { AiUsageQuota } from './entities/ai-usage-quota.entity';
import { User } from 'src/users/entities/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AiUsageQuota, User])],
  controllers: [AiUsageQuotasController],
  providers: [AiUsageQuotasService],
  exports: [AiUsageQuotasService],
})
export class AiUsageQuotasModule {}
