import { IsBoolean } from 'class-validator';

export class UpdateDevelopmentPlanSupplementOpenStateDto {
  @IsBoolean()
  isOpen: boolean;
}


