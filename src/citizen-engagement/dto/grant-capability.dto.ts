import { IsIn, IsUUID } from 'class-validator';

/**
 * Body for the super-admin grant/revoke endpoints (C4, plan D6).
 *
 * `userId` is the INTERNAL user uuid (PLAIN — §17.3, no FK). `capability` is one
 * of the four backend-access capabilities; the CHECK constraint in the M0
 * migration enforces the same set at the DB level.
 */
export class GrantCapabilityDto {
  @IsUUID()
  userId: string;

  @IsIn(['moderate', 'insight', 'access_mgmt', 'respond'])
  capability: string;
}
