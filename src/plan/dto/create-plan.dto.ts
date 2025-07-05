import { IsNotEmpty } from 'class-validator';

export class CreatePlanDto {
  @IsNotEmpty()
  id: string;

  @IsNotEmpty()
  name: string;
}
