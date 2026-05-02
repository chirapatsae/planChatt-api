import { IsBoolean, IsIn, IsOptional, IsString, Length } from 'class-validator';

/**
 * W97-API-FORCE-UNLINK — body for
 * POST /admin/notifications/line-bindings/:id/force-unlink.
 *
 * Source of truth: docs/tasks/wave97/W97-API-FORCE-UNLINK.md §3.
 *
 * Validation contract:
 *   - `reasonCategory`  — closed enum; rejected if missing or unknown.
 *   - `reason`          — operator free text 12..200 chars; rejected
 *                         outside that range. Encoded into the audit
 *                         row as `[<category>] <reason>` (W97-MIGRATION
 *                         §3 — there is no dedicated `reason_category`
 *                         column; prefix is the agreed encoding).
 *   - `acknowledgeSelfUnlink` — required to be true ONLY when the actor
 *                         is also the binding's owner (Q12.5
 *                         self-unlink protection). Service-layer check.
 *
 * §17.3 — this DTO has no FK / no project-table reference. §17.11 —
 * field shape is the integrity boundary; super-admin still cannot
 * bypass these checks.
 */
export class ForceUnlinkLineBindingDto {
  @IsIn([
    'left-org',
    'abuse-report',
    'cross-binding-deadlock',
    'user-request',
    'other',
  ])
  reasonCategory:
    | 'left-org'
    | 'abuse-report'
    | 'cross-binding-deadlock'
    | 'user-request'
    | 'other';

  // QA C2 fix: service encodes the audit row reason as `[<category>] <reason>`.
  // The longest category prefix is `[cross-binding-deadlock] ` (25 chars).
  // The DB CHECK on `line_binding_admin_actions.reason` (W97-MIGRATION) caps
  // length at 200, so the user-supplied reason MUST be capped at 200-25 = 175
  // to keep the encoded string within the CHECK bound. Frontend banner copy
  // updated to match.
  @IsString()
  @Length(12, 175, {
    message: 'reason ต้องมีความยาว 12-175 อักขระ',
  })
  reason: string;

  /**
   * Q12.5 — required to be `true` when the target binding belongs to
   * the actor themselves. The service layer compares
   * `binding.userId === actor.userId` and enforces this flag; the DTO
   * accepts it optionally so non-self-unlink calls can omit it.
   */
  @IsOptional()
  @IsBoolean()
  acknowledgeSelfUnlink?: boolean;
}
