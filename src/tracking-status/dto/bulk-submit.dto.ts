import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsUUID,
} from 'class-validator';

/**
 * W105-BE-PR1 — payload for `POST /tracking-status/bulk-submit`.
 *
 * Owner-scoped bulk Ready → Pending transition for main-plan projects.
 * Each `projectId` is a `ProjectGroup.id`. Per CLAUDE.md §VALIDATION ORDER
 * the submitter is validated once globally and each project is validated
 * independently inside the service so that one bad project does not poison
 * the batch (partial-success contract).
 *
 * Validation rules:
 *   - non-empty array
 *   - every element is a UUID
 *   - capped at 100 elements (DoS protection per task §8 + §6.1)
 *   - duplicate IDs are rejected at the SERVICE layer with errorCode
 *     `DUPLICATE_PROJECT_ID` (kept here as IsArray + class-validator does
 *     not have a built-in unique-element validator; the service performs
 *     a Set-based dedup check).
 */
export class BulkSubmitDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  projectIds: string[];
}
