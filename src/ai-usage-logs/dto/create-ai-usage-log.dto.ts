import { IsString, IsNumber, IsOptional, IsUUID } from 'class-validator';

export class CreateAiUsageLogDto {
  @IsString()
  usageType: string;

  @IsNumber()
  inputTextLength: number;

  @IsNumber()
  outputTextLength: number;

  @IsNumber()
  costBaht: number;

  @IsOptional()
  @IsUUID()
  aiUsageQuotaId?: string;
}
