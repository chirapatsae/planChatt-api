import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiUsageLogsModule } from 'src/ai-usage-logs/ai-usage-logs.module';
import { AiUsageLog } from 'src/ai-usage-logs/entities/ai-usage-log.entity';
import { AiUsageQuotasController } from './ai-usage-quotas.controller';
import { AiUsageQuotasService } from './ai-usage-quotas.service';
import { AiUsageQuota } from './entities/ai-usage-quota.entity';
import { User } from 'src/users/entities/user.entity';
// Wave 44 / BE-W44-03 — pre-call enforcement stack (task §5.1).
// Guard + weight map + org cap + FX config all live in this module so
// any consumer that imports `AiUsageQuotasModule` picks up the full
// enforcement surface.
import { AiQuotaGuard } from './guards/ai-quota.guard';
import { QuotaOrgCapService } from './quota-org-cap.service';
import { FxRefreshService } from './fx-refresh.service';

@Module({
  imports: [
    // `AiUsageLog` is registered here (in addition to its home module)
    // so `QuotaOrgCapService` can inject its repository. `AiUsageLogsModule`
    // remains imported for its create/query service surface used by
    // `checkAndLogUsage`.
    TypeOrmModule.forFeature([AiUsageQuota, User, AiUsageLog]),
    AiUsageLogsModule,
  ],
  controllers: [AiUsageQuotasController],
  providers: [AiUsageQuotasService, QuotaOrgCapService, AiQuotaGuard, FxRefreshService],
  exports: [AiUsageQuotasService, QuotaOrgCapService, AiQuotaGuard],
})
export class AiUsageQuotasModule { }
