import { IsUUID, IsNotEmpty } from 'class-validator';

export class CreateFavoriteDto {
  @IsUUID()
  @IsNotEmpty()
  projectGroupId: string;
}
