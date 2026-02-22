import { IsString, IsNumber, IsOptional, IsUUID } from 'class-validator';

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
}
