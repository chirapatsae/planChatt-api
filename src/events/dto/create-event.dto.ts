import { IsString, IsOptional, IsDateString, IsArray, ValidateNested, IsObject } from 'class-validator';
import { Type } from 'class-transformer';

class LocationDto {
  @IsString()
  name: string;

  @IsString()
  address: string;

  @IsOptional()
  @IsObject()
  coordinates?: {
    lat: number;
    lng: number;
  };
}

class AttachmentDto {
  @IsString()
  filename: string;

  @IsString()
  originalName: string;

  @IsString()
  mimetype: string;

  @IsOptional()
  size?: number;

  @IsString()
  path: string;
}

export class CreateEventDto {
  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @ValidateNested()
  @Type(() => LocationDto)
  location: LocationDto;

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AttachmentDto)
  attachments?: AttachmentDto[];
}
