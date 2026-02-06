import { IsUUID, IsNotEmpty, IsString } from 'class-validator';

export class CreateFavoriteDto {
  @IsUUID()
  @IsNotEmpty()
  projectId: string;

  @IsString()
  @IsNotEmpty()
  projectType : string
}
