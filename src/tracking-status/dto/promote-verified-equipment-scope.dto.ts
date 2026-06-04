import { IsUUID } from 'class-validator';

/**
 * Wave wave-print-merge-scale-statuschange / BE-04 (2026-06-04).
 *
 * Scope-driven request body for
 * `POST /tracking-status/promote-verified/equipment-project-group`.
 *
 * Carries ONLY the main-plan scope key — the endpoint re-derives the row
 * set server-side from status (`Verified`) + scope (§10 scope binding).
 * Deliberately has NO `page` / `limit` / id-array fields: the whole point
 * is to promote EVERY Verified EquipmentProjectGroup under the plan in one
 * transaction, replacing the FE per-id `Promise.allSettled` storm + the
 * `@Max(200)` paginate-all workaround.
 */
export class PromoteVerifiedEquipmentScopeDto {
  /** Main-plan DevelopmentPlan to scope the promotion to (§10). */
  @IsUUID()
  developmentPlanId: string;
}
