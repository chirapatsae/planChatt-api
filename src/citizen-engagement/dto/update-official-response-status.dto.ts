import { IsIn } from 'class-validator';

/**
 * W-G2: body for advancing an official response's issue-handling status. The
 * responder identity is resolved from the JWT context at the controller and the
 * authority is the C4 `respond` grant — NEVER ownership (§4.1). Only a
 * forward-or-same transition is accepted by the service.
 */
export const OFFICIAL_RESPONSE_STATUSES = [
  'received',
  'in_progress',
  'resolved',
] as const;

export type OfficialResponseStatus =
  (typeof OFFICIAL_RESPONSE_STATUSES)[number];

export class UpdateOfficialResponseStatusDto {
  @IsIn(OFFICIAL_RESPONSE_STATUSES)
  status: OfficialResponseStatus;
}
