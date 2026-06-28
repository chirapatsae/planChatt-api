import { IsIn, IsOptional } from 'class-validator';

import {
  CITIZEN_REACTION_TYPES,
  CitizenReactionType,
} from '../constants/citizen-reactions';

/**
 * Body for `POST posts/:id/reactions/toggle` (W-S1).
 *
 * `reactionType` is OPTIONAL — when omitted the service defaults to `like`
 * (back-compat with the heart toggle). When present it MUST be one of the 4
 * FROZEN keys; anything else is rejected by `class-validator` with a 400 before
 * the service runs.
 */
export class ReactToPostDto {
  @IsOptional()
  @IsIn(CITIZEN_REACTION_TYPES as readonly string[])
  reactionType?: CitizenReactionType;
}
