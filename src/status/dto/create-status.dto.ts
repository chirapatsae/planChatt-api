import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateStatusDto {
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  th_name?: string;
}
