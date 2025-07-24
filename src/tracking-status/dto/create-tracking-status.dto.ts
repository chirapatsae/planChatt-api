import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
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
  @IsNotEmpty()
  projectId: string;

  @IsUUID()
  @IsNotEmpty()
  statusId: string;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CreateCommentInput)
  comment?: CreateCommentInput[];
}
