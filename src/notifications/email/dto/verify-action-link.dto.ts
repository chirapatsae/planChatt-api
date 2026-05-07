import {
  IsInt,
  IsNotEmpty,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';

/**
 * W93-VERIFY-API — body shape for POST /v1/notifications/action-link/verify.
 *
 * Validation rules per the task spec §7.2:
 *   - projectId  → UUID, non-empty
 *   - token      → 64-char hex string (SHA-256 → 32 bytes → 64 hex chars)
 *   - expiry     → positive integer (epoch seconds)
 *
 * Validation failures are NOT surfaced as HTTP 400 to the client. The
 * route's per-handler `ValidationPipe` converts any class-validator error
 * into the spec's 200-with-`{ valid: false, reason: 'malformed' }` shape
 * (see `verify-action-link-malformed.exception.ts` and
 * `verify-action-link-malformed.filter.ts`). The frontend therefore has
 * exactly ONE response shape to handle.
 *
 * Source of truth:
 *   - W93-VERIFY-API task §7.1, §7.2
 *   - CLAUDE.md §4.1 — verifier outcome is advisory only
 *   - W83 — token is masked in logs; DTO does not log
 */
export class VerifyActionLinkDto {
  @IsUUID('all')
  @IsNotEmpty()
  projectId: string;

  @IsString()
  @Matches(/^[0-9a-fA-F]{64}$/)
  token: string;

  @IsInt()
  @IsPositive()
  expiry: number;
}
