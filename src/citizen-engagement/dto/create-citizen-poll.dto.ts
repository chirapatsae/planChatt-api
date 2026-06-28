import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Body of `POST /v1/citizen-engagement/polls` (W-S7).
 *
 * `question` becomes the poll post's `detail`; `options` are the 2..6 choices.
 * `closesAt` is the OPTIONAL close time (ISO-8601) — omitted → the poll never
 * closes. The 2..6 NON-EMPTY-option rule is re-asserted in
 * `CitizenPollService.createPoll` (the DTO bounds size + length only); a
 * blank/whitespace option is rejected there with `CITIZEN_POLL_OPTIONS_INVALID`.
 */
export class CreateCitizenPollDto {
  @IsString()
  @MaxLength(255)
  question: string;

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(6)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  options: string[];

  @IsOptional()
  @IsISO8601()
  closesAt?: string;
}
