import { IsNotEmpty } from 'class-validator';

export class CreateStrategyDto {
  @IsNotEmpty()
  stratId: string;

  @IsNotEmpty()
  name: string;
}
