import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Body of `POST /v1/citizen-engagement/posts/:id/comments`. */
export class CreateCitizenCommentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  text: string;

  /** Reply threading (1 level): the parent comment id when this is a reply;
   *  omitted for a top-level comment. Validated + flattened server-side. */
  @IsOptional()
  @IsUUID()
  parentCommentId?: string;

  /**
   * W-S6: resolved identity ids the author @mentioned in the comment body. Each
   * is validated (real, non-deleted, active citizen) + de-duped + self/blocked-
   * dropped in `CitizenMentionService.processMentions`; invalid ids are silently
   * ignored (§17.2 advisory — a mention never blocks the comment write). Alias is
   * NEVER trusted from the client — only the id; the FE picks it via autocomplete.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  mentions?: string[];
}
