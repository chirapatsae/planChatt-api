import { IsNotEmpty } from 'class-validator';

export class CreateTacticDto {
  @IsNotEmpty()
  id: string;

  @IsNotEmpty()
  name: string;

  @IsNotEmpty()
  strategyId: string;
}

