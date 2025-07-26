import { AiUsageQuota } from 'src/ai-usage-quotas/entities/ai-usage-quota.entity';

export class AiUsageLogResponseDto {
  id: string;
  usageType: string;
  inputTextLength: number;
  outputTextLength: number;
  costBaht: number;
  usedAt: Date;
  aiUsageQuota?: AiUsageQuota;
} 