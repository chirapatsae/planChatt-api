/**
 * W106-BE-PR1 — Query DTO for `GET /v1/presence?userIds=a,b,c`.
 *
 * The `userIds` query string arrives as a comma-separated list. We pre-split
 * + trim + dedupe in a @Transform so downstream validators see a clean
 * `string[]`. Validation rules:
 *   - at least 1 id
 *   - at most 200 ids (PRESENCE_BULK_LIMIT_EXCEEDED)
 *   - every id is a v4 UUID
 */

import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';

export const PRESENCE_BULK_MAX = 200;

export class BulkPresenceQueryDto {
  @Transform(({ value }) => {
    if (Array.isArray(value)) {
      return Array.from(
        new Set(
          value
            .flatMap((v) => String(v).split(','))
            .map((v) => v.trim())
            .filter(Boolean),
        ),
      );
    }
    if (typeof value === 'string') {
      return Array.from(
        new Set(
          value
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean),
        ),
      );
    }
    return [];
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'userIds must contain at least 1 id' })
  @ArrayMaxSize(PRESENCE_BULK_MAX, {
    // Custom code surfaced by the controller (translates to 400).
    message: 'PRESENCE_BULK_LIMIT_EXCEEDED',
  })
  @IsUUID('4', { each: true, message: 'each userId must be a v4 UUID' })
  userIds: string[];
}
