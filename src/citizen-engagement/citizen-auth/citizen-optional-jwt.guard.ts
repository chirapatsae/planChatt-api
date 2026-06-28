import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * CitizenOptionalJwtGuard — OPTIONAL ThaID-citizen authentication for PUBLIC
 * reads (W-T1).
 *
 * Behaviour:
 *   - a VALID `aud:'citizen'` bearer token → `req.user = { identityId, … }`
 *     (the personalized block/mute read-filter then applies to this viewer)
 *   - NO token, an expired token, a malformed token, or an internal-staff
 *     token → `req.user` is left UNDEFINED and the request PROCEEDS as anonymous
 *
 * It NEVER throws 401. This is the key W-T1 pattern: a logged-in viewer's
 * block/mute filter applies to the public feed/search/profile reads, while an
 * anonymous viewer sees the unfiltered public board. Apply it to PUBLIC reads
 * ONLY — write actions stay on the strict `CitizenJwtGuard` (which DOES reject).
 *
 * It does NOT re-check `status` / `session_version` against
 * `citizen_identities` (unlike the strict guard) — a read filter is advisory
 * (§17.2) and a stale-but-valid token only ever HIDES more posts from the
 * viewer, never grants extra access. The strict guard owns the revocation gate
 * for the write surfaces.
 */
@Injectable()
export class CitizenOptionalJwtGuard extends AuthGuard('citizen-jwt') {
  /**
   * Always allow the request through. `AuthGuard.canActivate` still runs the
   * passport strategy (populating `req.user` on a valid token), but `handleRequest`
   * below swallows any auth error instead of throwing.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      await super.canActivate(context);
    } catch {
      // Swallow — an invalid / missing token must NOT reject an anonymous read.
    }
    return true;
  }

  /**
   * Passport calls this with the validate() result. On ANY error or missing
   * user, return `undefined` (anonymous) instead of throwing — the public read
   * proceeds unfiltered.
   */
  // Passport calls handleRequest(err, user, info, context, status); accept the
  // optional trailing args so the override is call-compatible (the spec passes
  // info too). We only ever use `user`.
  handleRequest(_err: unknown, user: unknown, _info?: unknown): any {
    return user || undefined;
  }
}
