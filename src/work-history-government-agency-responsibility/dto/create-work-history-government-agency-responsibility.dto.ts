import { IsUUID, IsString } from 'class-validator';

export class CreateWorkHistoryGovernmentAgencyResponsibilityDto {
  @IsUUID()
  workHistoryId: string;

  @IsString()
  governmentAgencyId: string;
}
