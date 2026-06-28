/**
 * Public response shapes for the W-S6 @mention surface.
 *
 * PII guard (§17.3 / PDPA): these shapes expose the resolved identity `id` (an
 * OPAQUE uuid handle, NOT PII) + the public `displayAlias` ONLY — never the
 * `national_id_hash` / `thaid_sub_hash` / `*_enc` columns. The mention targets a
 * specific identity id; the alias is display-only (the FE linkifies
 * `@alias` → `/community/u/:identityId`).
 */

/**
 * One citizen returned by the mention autocomplete
 * (`GET citizens/search?q=`). `id` is the resolved identity uuid the composer
 * tracks; `displayAlias` is what the dropdown renders.
 */
export interface CitizenMentionSearchResultDto {
  id: string;
  displayAlias: string;
}

/**
 * A resolved mention attached to a post / comment response (`mentions[]`), so the
 * FE can linkify `@alias` occurrences against the chosen identity ids.
 */
export interface CitizenMentionDto {
  identityId: string;
  displayAlias: string;
}
