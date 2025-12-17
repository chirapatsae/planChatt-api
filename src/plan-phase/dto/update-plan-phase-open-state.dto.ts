import { IsBoolean } from 'class-validator';

export class UpdatePlanPhaseOpenStateDto {
  @IsBoolean()
  isOpen: boolean;
}


