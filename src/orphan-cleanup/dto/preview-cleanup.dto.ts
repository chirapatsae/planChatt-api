import { IsEnum, IsIn, IsString, IsUUID } from 'class-validator';

/**
 * W110-BE-01 — Read-only preview DTO consumed by the FE-01 confirmation
 * modal. The endpoint mirrors the host book operation's authority guard
 * (admin + super-admin) but performs no DB writes.
 *
 * `kind` selects which predicate set is materialized (CLAUDE.md §18.4):
 *   - 'cancel'   → all non-soft-deleted rows under the book
 *   - 'finalize' → rows whose latest status is NOT IN
 *                  {Approved, Ready, Rejected}
 *
 * `bookKind` discriminates the scope binding (PG vs RPG vs SPG). Passing
 * the kind explicitly avoids an extra round-trip to look up the book row
 * just to learn its concrete type.
 */
export class PreviewCleanupQueryDto {
  @IsUUID('4')
  bookId!: string;

  @IsString()
  @IsIn(['PLAN', 'REVISION', 'SUPPLEMENT'])
  bookKind!: 'PLAN' | 'REVISION' | 'SUPPLEMENT';

  @IsString()
  @IsIn(['cancel', 'finalize'])
  kind!: 'cancel' | 'finalize';
}

export interface PreviewCleanupResponseDto {
  pgCount: number;
  rpgCount: number;
  /** Always 0 — PGs do not participate in the lineage-lock check. Field
   * is preserved in the contract to match FE-01 expectations. */
  pgWithLiveDescendant: 0;
  rpgWithLiveDescendant: number;
}
