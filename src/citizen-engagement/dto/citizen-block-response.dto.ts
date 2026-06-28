/**
 * Public response shapes for the citizen BLOCK / MUTE surface (W-T1).
 *
 * PRIVACY (W-T1): these shapes expose ONLY the caller's OWN outbound blocks/mutes
 * — never an inbound "who blocked me" roster (the target is never notified and
 * never learns it was blocked).
 */

/** Result of `POST /v1/citizen-engagement/blocks`. */
export interface SetCitizenBlockResponseDto {
  targetId: string;
  kind: 'mute' | 'block';
}

/** One entry of the owner-scoped `GET /v1/citizen-engagement/me/blocks` list. */
export interface CitizenBlockEntryDto {
  targetId: string;
  kind: 'mute' | 'block';
}
