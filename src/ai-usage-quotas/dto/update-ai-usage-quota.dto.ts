import { PartialType } from '@nestjs/mapped-types';
import { CreateAiUsageQuotaDto } from './create-ai-usage-quota.dto';

export class UpdateAiUsageQuotaDto extends PartialType(CreateAiUsageQuotaDto) {}
