import { AiUsageQuota } from 'src/ai-usage-quotas/entities/ai-usage-quota.entity';

export class AiUsageLogResponseDto {
  id: string;
  usageType: string;
  // Wave 37 hotfix — surface modelName + token counts that the entity
  // has always stored but the DTO omitted. FE drawer rendered "-" for
  // these because the mapper returned `undefined` instead of the real
  // values.
  modelName?: string;
  inputTokens?: number;
  outputTokens?: number;
  inputTextLength: number;
  outputTextLength: number;
  costBaht: number;
  usedAt: Date;
  aiUsageQuota?: AiUsageQuota;

  // Wave 36 N1 — detail-log fields (all nullable; pre-Wave-36 rows
  // will surface as `null` through the response). §17.3 audit
  // separation: targetId / actorWorkHistoryId are soft references
  // without FK integrity.
  endpoint?: string | null;
  summaryTh?: string | null;
  requestPayload?: any;
  responsePayload?: any;
  targetId?: string | null;
  targetKind?: string | null;
  actorWorkHistoryId?: string | null;
  durationMs?: number | null;
  error?: string | null;
}
