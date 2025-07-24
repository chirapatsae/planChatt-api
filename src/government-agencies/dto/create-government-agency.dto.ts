import { IsNotEmpty, IsString } from 'class-validator';

export class CreateGovernmentAgencyDto {
  @IsNotEmpty()
  @IsString()
  name: string;
}
