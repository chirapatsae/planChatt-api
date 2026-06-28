/**
 * Response shapes for the EPHEMERAL story surface (W-GATE-3).
 *
 * PII guard (§17.3): the author block carries ONLY `id` + `displayAlias` from
 * the identity row — never `nationalIdHash` / `thaidSubHash` / `*_enc`. The
 * service builds these objects by hand (alias-only select), so the encrypted
 * identity columns can never leak.
 */

/** A single active story as served to the public active feed. */
export interface StoryDto {
  id: string;
  imageUrl: string;
  caption: string | null;
  createdAt: string;
  expiresAt: string;
}

/** The minimal, alias-only author block (no PII). */
export interface StoryAuthorDto {
  id: string;
  displayAlias: string;
}

/** One author's bundle of currently-active stories. */
export interface StoryGroupDto {
  author: StoryAuthorDto;
  stories: StoryDto[];
}
