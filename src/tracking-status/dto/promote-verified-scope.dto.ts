import { IsIn, IsOptional, IsUUID } from 'class-validator';

/**
 * Wave wave-print-merge-scale-statuschange / BE-01 (2026-06-04).
 *
 * Scope-driven request body for
 * `POST /tracking-status/promote-verified/project-group`.
 *
 * Carries ONLY scope keys — the endpoint re-derives the row set
 * server-side from the same list-finder predicate (§10 scope binding).
 * Deliberately has NO `page` / `limit` / id-array fields: the whole
 * point is to promote EVERY Verified PG under the scope in one tx.
 */
export class PromoteVerifiedScopeDto {
  /** Main-plan DevelopmentPlan to scope the promotion to (§10). */
  @IsUUID()
  developmentPlanId: string;

  /**
   * Origin discriminator selecting which list finder predicate to reuse:
   *   - `agency`    → `findByStatusVerifiedAgency`
   *     (originAgencyId IS NULL AND responsibleAgency IS NOT NULL)
   *   - `authority` → `findProjectsByStatusInAuthority`
   *     (originAgencyId IS NOT NULL — LAO/coordinate origin)
   * Defaults to `agency` when omitted.
   */
  @IsOptional()
  @IsIn(['agency', 'authority'])
  origin?: 'agency' | 'authority';
}
