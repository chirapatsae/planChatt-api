import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/**
 * Body of `POST /v1/citizen-engagement/posts`.
 *
 * Cross-field shape (idea requires geo + category + text; discussion forces
 * geo/category null) is asserted in `CitizenPostService.create`, NOT here —
 * the DTO only bounds individual fields. See §17.2 advisory board contract.
 */
export class CreateCitizenPostDto {
  @IsIn(['idea', 'discussion'])
  postKind: 'idea' | 'discussion';

  @IsOptional()
  @IsNumber()
  lat?: number;

  @IsOptional()
  @IsNumber()
  lng?: number;

  // Amphoe CODE (e.g. "3001" — matches `amphoes.id`), NOT a uuid. Normally
  // derived server-side from the pin (lat/lng); accepted here only as an
  // optional client hint.
  @IsOptional()
  @IsString()
  @MaxLength(16)
  amphoeId?: string;

  @IsOptional()
  @IsIn(['road', 'water', 'public', 'safety', 'other'])
  category?: 'road' | 'water' | 'public' | 'safety' | 'other';

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  detail?: string;

  /**
   * Ids of the caller's already-uploaded, UNATTACHED media (C2 v1). Each is
   * single-attached to the new post in array order. Ownership + single-attach
   * are re-asserted in `CitizenMediaService.attachMediaToPost`.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsUUID('4', { each: true })
  mediaIds?: string[];

  /**
   * W-S6: resolved identity ids the author @mentioned in the post body. Each is
   * validated (real, non-deleted, active citizen) + de-duped + self/blocked-
   * dropped in `CitizenMentionService.processMentions`; invalid ids are silently
   * ignored (§17.2 advisory — a mention never blocks the post write). Alias is
   * NEVER trusted from the client — only the id; the FE picks it via autocomplete.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  mentions?: string[];
}
