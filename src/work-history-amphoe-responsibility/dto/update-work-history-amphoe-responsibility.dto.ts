import { PartialType } from '@nestjs/mapped-types';
import { CreateWorkHistoryAmphoeResponsibilityDto } from './create-work-history-amphoe-responsibility.dto';
import { IsNotEmpty, IsUUID } from 'class-validator';

export class UpdateWorkHistoryAmphoeResponsibilityDto extends PartialType(
  CreateWorkHistoryAmphoeResponsibilityDto,
) {}

export class TransferResponsibilityDto {
  @IsUUID()
  @IsNotEmpty({ message: 'newWorkHistoryId should not be empty' })
  newWorkHistoryId: string;
}
