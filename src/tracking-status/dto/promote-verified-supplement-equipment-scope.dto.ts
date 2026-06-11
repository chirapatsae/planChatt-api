import { IsOptional, IsUUID } from 'class-validator';

/**
 * Wave wave-supplement-equipment-por03 — promote-verified SEPG (2026-06-10).
 *
 * Request DTO for the scope-driven promote-verified endpoint at
 * `POST /api/v1/tracking-status/promote-verified/supplement-equipment-project-group`.
 *
 * SEPG (ครุภัณฑ์ ผ.03 ของเล่มเพิ่มเติม) is the 6th member of the §12.1
 * "Scope-Based Verified Promotion Endpoints" family. It is the equipment
 * sibling of `PromoteVerifiedSupplementScopeDto` (SPG): the supplement
 * staff "พิมพ์เล่มร่าง" action moves BOTH the supplement project (SPG) AND
 * the supplement equipment (SEPG) sets `Verified → Pending_Approval`,
 * exactly like the change-print page promotes both RPG and RELPG.
 *
 * SCOPE KEYS ONLY. This is a SET operation, not a page: every
 * `SupplementEquipmentProjectGroup` whose latest status is `Verified`
 * under the supplied `developmentPlanSupplementId` scope is promoted to
 * `Pending_Approval` in ONE transaction. There is therefore NO `page` /
 * `limit` and NO id-array — the endpoint re-derives the row set
 * server-side from status (`Verified`) + scope (§10 scope binding).
 *
 * Scope key is `developmentPlanSupplementId` (§12.1 — the supplement-book
 * scope key for supplement-parented rows). `developmentPlanId` is accepted
 * as an OPTIONAL hint for symmetry with the SPG DTO but is not load-bearing
 * — the row set is bound to the supplement, not the plan.
 *
 * Source of truth: CLAUDE.md §3 / §4.1 (staff authority, ownership not the
 * gate), §5.3 (SEPG is agency-origin authoring but staff transitions are
 * NOT agency-gated), §10 (scope binding to the supplied supplement, never
 * a global open round), §12 (one TrackingStatus per row), §15.4 (honor the
 * supplement book lock).
 */
export class PromoteVerifiedSupplementEquipmentScopeDto {
  @IsUUID('4', {
    message: 'developmentPlanSupplementId ต้องเป็น UUID',
  })
  developmentPlanSupplementId: string;

  @IsOptional()
  @IsUUID('4', { message: 'developmentPlanId ต้องเป็น UUID' })
  developmentPlanId?: string;
}
