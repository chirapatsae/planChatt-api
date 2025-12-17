import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

export class CreateCommentInput {
  @IsNotEmpty()
  detail: string;

  @IsNumber()
  step: number;
}

export class CreateTrackingStatusDto {
  @IsUUID()
  @IsNotEmpty()
  projectId: string;

  @IsUUID()
  @IsNotEmpty()
  statusId: string;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CreateCommentInput)
  comment?: CreateCommentInput[];

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CreateComments)
  comments?: CreateComments[];

  @IsOptional()
  @IsString()
  oldAdditionDetail?: string;
}

export class CreateComments {
  @IsNotEmpty()
  detail: string;

  @IsNumber()
  @IsNotEmpty()
  step: number;
}
