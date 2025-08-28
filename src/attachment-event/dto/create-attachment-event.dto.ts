import { IsString, IsNumber, IsUUID } from 'class-validator';

export class CreateAttachmentEventDto {
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
  eventId: string;
} 