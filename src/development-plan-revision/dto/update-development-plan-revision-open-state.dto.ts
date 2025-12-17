import { IsBoolean } from 'class-validator';

export class UpdateDevelopmentPlanRevisionOpenStateDto {
  @IsBoolean()
  isOpen: boolean;
}


