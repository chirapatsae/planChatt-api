/**
 * W-GATE-1 public-profile response shapes.
 *
 * A citizen profile is PUBLIC (no auth): alias + their public posts + follow
 * counts. PII guard (§17.3): carries ONLY the identity uuid + `displayAlias` —
 * never `nationalIdHash` / `thaidSubHash` / `*_enc`.
 *
 * PRIVACY (D16): `followerCount` is a public COUNT; the follower ROSTER
 * (who-follows-whom) is NEVER exposed by this surface.
 */
export interface CitizenPublicProfileDto {
  /** The citizen's identity uuid (opaque public handle). */
  id: string;
  displayAlias: string;
  /** Public, non-removed posts authored by this citizen. */
  postCount: number;
  /** Live count of citizens who follow this person (D16 — count only, no roster). */
  followerCount: number;
}
