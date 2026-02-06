import { IsNotEmpty, IsNumber, IsString, IsUUID } from 'class-validator';

export class CreateAttachmentRevisedProjectGroupDto {
  @IsString()
  filename: string;

  @IsString()
  originalName: string;

  @IsString()
  mimetype: string;

  @IsNumber()
  size: number;

  @IsString()
  path: string;

  @IsUUID()
  @IsNotEmpty()
  revisedProjectGroupId: string;
}


