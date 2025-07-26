import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiUsageLogsService } from './ai-usage-logs.service';
import { AiUsageLogsController } from './ai-usage-logs.controller';
import { AiUsageLog } from './entities/ai-usage-log.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AiUsageLog])],
  controllers: [AiUsageLogsController],
  providers: [AiUsageLogsService],
  exports: [AiUsageLogsService],
})
export class AiUsageLogsModule {}
