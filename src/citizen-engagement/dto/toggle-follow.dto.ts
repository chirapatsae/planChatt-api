import { IsIn, IsString, MaxLength } from 'class-validator';

/**
 * Body of `POST /v1/citizen-engagement/follows/toggle`.
 *
 * W-GATE-1 (§10 APPROVED): follow targets are AREA (amphoe), TOPIC (category),
 * or PERSON (another citizen). `targetKind` is constrained to
 * `amphoe` | `category` | `person`; the service further validates `targetKey`
 * (uuid for amphoe, one of the 5 categories for category, an EXISTING + active
 * + non-self identity_id for person) and rejects with
 * `400 CITIZEN_FOLLOW_INVALID` (shape) / `400 CITIZEN_FOLLOW_SELF` (self) /
 * `404 CITIZEN_IDENTITY_NOT_FOUND` (missing/blocked person).
 */
export class ToggleFollowDto {
  @IsIn(['amphoe', 'category', 'person'])
  targetKind: 'amphoe' | 'category' | 'person';

  @IsString()
  @MaxLength(64)
  targetKey: string;
}
