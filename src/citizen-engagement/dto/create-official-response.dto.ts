import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body for an internal staff member posting an official response to a citizen
 * post (C4, plan D12). The responder identity is resolved from the JWT context
 * at the controller — NEVER from the body.
 */
export class CreateOfficialResponseDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body: string;
}
