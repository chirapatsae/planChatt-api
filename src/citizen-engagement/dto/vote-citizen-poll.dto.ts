import { IsUUID } from 'class-validator';

/**
 * Body of `POST /v1/citizen-engagement/posts/:id/poll/vote` (W-S7).
 *
 * `optionId` is the option the caller is voting for. The service re-asserts the
 * option belongs to the poll (`:id`); voting the SAME option twice un-votes,
 * a DIFFERENT option change-votes (one live vote per citizen per poll).
 */
export class VoteCitizenPollDto {
  @IsUUID()
  optionId: string;
}
