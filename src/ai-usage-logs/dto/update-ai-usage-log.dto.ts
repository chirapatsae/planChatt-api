import { PartialType } from '@nestjs/mapped-types';
import { CreateAiUsageLogDto } from './create-ai-usage-log.dto';

export class UpdateAiUsageLogDto extends PartialType(CreateAiUsageLogDto) {}
