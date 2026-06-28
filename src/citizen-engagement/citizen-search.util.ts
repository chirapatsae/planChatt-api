/**
 * citizen-search.util — pure, dependency-free search helpers shared by the
 * citizen-engagement search surfaces.
 *
 * `escapeLike` lived in `citizen-search.service.ts`, but W-S6's
 * `CitizenMentionService` also needs it for its alias autocomplete. Importing
 * it from the SERVICE created a require cycle
 * (`citizen-search.service` → `CitizenPostService` → `CitizenMentionService` →
 * `citizen-search.service`), which left `CitizenPostService` undefined at
 * decoration time and crashed Nest DI at boot. Keeping the helper in this
 * service-free module breaks the cycle — neither service imports the other's
 * file for this.
 */

/**
 * Escape a user string for safe use inside a SQL `LIKE`/`ILIKE` pattern.
 * Order matters: escape the backslash FIRST so the `\` we add for `%` / `_`
 * is not itself doubled.
 */
export function escapeLike(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
