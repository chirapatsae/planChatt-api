import { IsIn, IsUUID } from 'class-validator';

/**
 * Body of `POST /v1/citizen-engagement/blocks` (W-T1).
 *
 * The blocker is ALWAYS `req.user.identityId` (NEVER a body field — no IDOR).
 * `targetIdentityId` is the citizen being muted/blocked; `kind` is which.
 */
export class SetCitizenBlockDto {
  /** The citizen to mute / block (their identity_id, a plain uuid). */
  @IsUUID()
  targetIdentityId: string;

  /** `mute` (hide-only) or `block` (mutual invisibility + no interaction). */
  @IsIn(['mute', 'block'])
  kind: 'mute' | 'block';
}
