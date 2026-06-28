import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Body of `POST /v1/citizen-engagement/posts/:id/appeal` (W-T3). */
export class SubmitAppealDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}
