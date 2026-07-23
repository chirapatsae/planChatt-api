import { IsIn } from 'class-validator';

import {
  STORY_REACTION_KEYS,
  StoryReactionKey,
} from '../constants/citizen-story-reactions';

/**
 * Body for `PUT citizen-engagement/stories/:id/reaction` (FB-6).
 *
 * `emoji` is REQUIRED and MUST be one of the 6 story reaction KEYS
 * (`love` | `haha` | `wow` | `sad` | `angry` | `like`). Anything else — a
 * missing value, the glyph itself, or an unknown key — is rejected by
 * `class-validator` with a 400 BEFORE the service runs (the DB CHECK is
 * defense-in-depth behind this).
 */
export class CitizenStoryReactionDto {
  @IsIn(STORY_REACTION_KEYS as readonly string[])
  emoji: StoryReactionKey;
}
