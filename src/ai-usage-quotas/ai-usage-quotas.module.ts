import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiUsageLogsModule } from 'src/ai-usage-logs/ai-usage-logs.module';
import { AiUsageQuotasController } from './ai-usage-quotas.controller';
import { AiUsageQuotasService } from './ai-usage-quotas.service';
import { AiUsageQuota } from './entities/ai-usage-quota.entity';
import { User } from 'src/users/entities/user.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([AiUsageQuota, User]),
    AiUsageLogsModule,
  ],
  controllers: [AiUsageQuotasController],
  providers: [AiUsageQuotasService],
  exports: [AiUsageQuotasService],
})
export class AiUsageQuotasModule { }
