import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateWorkStatusDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  th_name?: string;
}
