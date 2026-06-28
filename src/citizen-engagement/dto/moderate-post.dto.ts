import { IsIn } from 'class-validator';

import type { ModerationAction } from '../moderation/citizen-moderation.service';

/** Body of `POST /v1/citizen-engagement/moderation/posts/:id` (C5, D13). */
export class ModeratePostDto {
  @IsIn(['hide', 'remove', 'restore'])
  action: ModerationAction;
}
