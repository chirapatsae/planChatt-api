import {
  IsString,
  IsNumber,
  IsOptional,
  IsUUID,
  IsObject,
  IsInt,
  Min,
} from 'class-validator';

export class CreateAiUsageLogDto {
  @IsString()
  usageType: string;

  @IsString()
  modelName: string;

  @IsNumber()
  inputTokens: number;

  @IsNumber()
  outputTokens: number;

  @IsOptional()
  @IsNumber()
  inputTextLength: number;

  @IsOptional()
  @IsNumber()
  outputTextLength: number;

  @IsNumber()
  costBaht: number;

  @IsOptional()
  @IsUUID()
  aiUsageQuotaId?: string;

  // Wave 36 N1 — detail-log fields (all optional; §17.3 audit separation)

  @IsOptional()
  @IsString()
  endpoint?: string;

  @IsOptional()
  @IsString()
  summaryTh?: string;

  @IsOptional()
  @IsObject()
  requestPayload?: any;

  @IsOptional()
  @IsObject()
  responsePayload?: any;

  @IsOptional()
  @IsUUID()
  targetId?: string;

  @IsOptional()
  @IsString()
  targetKind?: string;

  @IsOptional()
  @IsUUID()
  actorWorkHistoryId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  durationMs?: number;

  @IsOptional()
  @IsString()
  error?: string;
}
