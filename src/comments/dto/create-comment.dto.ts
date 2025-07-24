import { IsNotEmpty, IsNumber, IsUUID } from 'class-validator';

export class CreateCommentDto {
  @IsNotEmpty()
  detail: string;

  @IsNumber()
  @IsNotEmpty()
  step: number;

  @IsUUID()
  @IsNotEmpty()
  trackingStatusId: string;
}
