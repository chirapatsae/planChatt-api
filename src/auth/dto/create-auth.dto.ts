import { IsString } from 'class-validator';

export class CreateAuthDto {
  @IsString()
  id_token: string;
  @IsString()
  division_id: string;
  @IsString()
  division_name: string;
}
