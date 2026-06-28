import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Query of `GET /v1/citizen-engagement/citizens/search?q=` (W-S6 @mention
 * autocomplete). The composer types `@<alias>` and the FE debounce-searches
 * citizens by alias prefix. `q` is bounded at the DTO (the service caps the
 * result count + filters to active citizens only); the response carries
 * `{ id, displayAlias }` ONLY — never any PII (§17.3 / PDPA).
 */
export class SearchCitizensQueryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  q: string;
}
