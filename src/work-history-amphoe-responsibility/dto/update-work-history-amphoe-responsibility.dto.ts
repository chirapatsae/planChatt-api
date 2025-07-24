import { PartialType } from '@nestjs/mapped-types';
import { CreateWorkHistoryAmphoeResponsibilityDto } from './create-work-history-amphoe-responsibility.dto';

export class UpdateWorkHistoryAmphoeResponsibilityDto extends PartialType(
  CreateWorkHistoryAmphoeResponsibilityDto,
) {}

export class TransferResponsibilityDto {
  newWorkHistoryId: string;
}
