import { IsDate, IsNotEmpty, IsNumber, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateAiUsageQuotaDto {
  @IsNotEmpty()
  @Type(() => Date)
  @IsDate()
  periodStart: Date;

  @IsNotEmpty()
  @Type(() => Date)
  @IsDate()
  periodEnd: Date;

  @IsNotEmpty()
  @IsNumber()
  quotaLimit: number;

  @IsOptional()
  @IsNumber()
  quotaUsed?: number;

  @IsOptional()
  @IsNumber()
  remainingQuota?: number;

}
