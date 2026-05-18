import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsUUID,
} from 'class-validator';

/**
 * ReplaceMappingDto — Strategic Graph BE-04 inter-master replace-mode payload.
 *
 * Used by `POST /v1/strategic-graph/mapping/:type`. Replace mode means:
 * the caller submits the FULL desired target set for `sourceId`; the
 * service DELETEs all existing source→target rows and INSERTs the new
 * set in a single transaction.
 *
 * `targetIds = []` is valid → clears all mappings for the source.
 */
export class ReplaceMappingDto {
  @IsUUID()
  sourceId: string;

  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
  targetIds: string[];
}
