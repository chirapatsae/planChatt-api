import { IsBoolean } from 'class-validator';

export class UpdateDevelopmentPlanLatestStatusDto {
  @IsBoolean()
  isLatest: boolean;
}


