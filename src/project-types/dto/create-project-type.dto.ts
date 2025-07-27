import { IsNotEmpty, IsString } from 'class-validator';

export class CreateProjectTypeDto {
  @IsNotEmpty()
  @IsString()
  name: string;
}
