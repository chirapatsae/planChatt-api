import { IsIn } from 'class-validator';

/**
 * Body of `POST /v1/citizen-engagement/moderation/appeals/:id` (W-T3).
 *
 *   - `reversed` → restore the post (`moderation_state = 'visible'`, resolve its
 *     open reports) AND mark the appeal `reversed`.
 *   - `upheld`   → mark the appeal `upheld` (the post stays removed).
 */
export class ResolveAppealDto {
  @IsIn(['reversed', 'upheld'])
  decision: 'reversed' | 'upheld';
}
