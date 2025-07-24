import { IsNotEmpty, IsString } from 'class-validator';

export class CreateWorkStatusDto {
  @IsNotEmpty()
  @IsString()
  name: string;
}
