import { IsEnum, IsNotEmpty, IsUUID } from 'class-validator';
import { BookAssemblySourceType } from '../enums/book-assembly.enums';

export class CreateDraftDto {
  @IsEnum(BookAssemblySourceType)
  sourceType: BookAssemblySourceType;

  @IsUUID()
  @IsNotEmpty()
  sourceId: string;
}
