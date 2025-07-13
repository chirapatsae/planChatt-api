import { IsUUID, IsOptional, IsString } from 'class-validator';

export class CreateWorkHistoryAmphoeResponsibilityDto {
  @IsUUID()
  workHistoryId: string;

  @IsString()
  amphoeId: string;

}
