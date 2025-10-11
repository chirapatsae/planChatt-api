import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateRevisionTypeDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(50)
  name: string;
}
