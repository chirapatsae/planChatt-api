import { PartialType } from '@nestjs/mapped-types';
import { CreateWorkHistoryGovernmentAgencyResponsibilityDto } from './create-work-history-government-agency-responsibility.dto';

export class UpdateWorkHistoryGovernmentAgencyResponsibilityDto extends PartialType(
  CreateWorkHistoryGovernmentAgencyResponsibilityDto,
) {}

export class TransferResponsibilityDto {
  newWorkHistoryId: string;
}
