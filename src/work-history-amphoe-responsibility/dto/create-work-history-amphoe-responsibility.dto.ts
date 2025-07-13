import { IsUUID, IsOptional } from 'class-validator';

export class CreateWorkHistoryAmphoeResponsibilityDto {
  @IsUUID()
  workHistoryId: string;

  @IsUUID()
  amphoeId: string;

  @IsOptional()
  @IsUUID()
  assignedByWorkHistoryId?: string;
}
