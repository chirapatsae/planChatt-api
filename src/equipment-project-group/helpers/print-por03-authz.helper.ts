import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';

import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { EquipmentProjectGroup } from '../entities/equipment-project-group.entity';
import { isAgencyWorkHistory } from 'src/project-groups/util/agency-data.util';

/**
 * Wave Print ผ.03 — BE-02 (2026-05-28).
 *
 * Shared authorization helpers for `POST /v1/pdf/generate-por03`. Lives in
 * the equipment-project-group module so the BE-01 PDF service
 * (`Por03PdfService`) can `import` and re-assert the SAME predicates the
 * `PrintPor03AgencyGuard` enforces at the controller layer — single-source
 * the §5.3 defense-in-depth pattern.
 *
 * # Layered enforcement contract (LOCKED per §5.3)
 *
 *   Layer-1 (NestJS Guard, controller-pre-handler):
 *     - `assertAgencyCaller(workHistory)`   ← runs once
 *
 *   Layer-2 (service, post-row-load):
 *     - `assertAgencyCaller(workHistory)`   ← runs again (re-assertion)
 *     - `assertOwnership(row, callerWorkHistoryId)`  ← per row
 *     - `assertStrategyShape(row)`           ← per row
 *
 * Per the BE-02 task brief: throw on FIRST violation; do not accumulate.
 *
 * # Q1–Q6 locked answers acknowledged (verbatim, README §0, 2026-05-28)
 *
 * - Q1 (cover layout) — no impact on authz layer.
 * - Q2 (STRATEGY_BASED ONLY) — encoded by `assertStrategyShape`.
 * - Q3 (landscape A4) — no impact on authz layer.
 * - Q4 (endpoint `POST /v1/pdf/generate-por03`) — the surface this helper
 *   protects.
 * - Q5 (skip audit) — this helper writes NO audit / tracking-status rows.
 * - Q6 (cooldown owned by BE-01) — this helper does NOT arm cooldown.
 *
 * # No role exemption (§17.11)
 *
 * `assertAgencyCaller` is classification-only (§1). A `super-admin` whose
 * current WorkHistory is classified `lao` is rejected with
 * `EQUIPMENT_AGENCY_ONLY` just like any other LAO caller. Role does NOT
 * widen authority.
 */

/**
 * (a) Agency-only classification check.
 *
 * §1 source of truth: `workHistory.amphoe.id === '3001' &&
 *   workHistory.localAdministrativeOrganization.id === '3001027'`.
 *
 * Delegates to the shared `isAgencyWorkHistory` predicate so the
 * STRATEGY_BASED-only print surface uses the IDENTICAL classification
 * gate as the existing equipment authoring surface
 * (`AgencyOnlyGuard` at `backend/src/common/guards/agency-only.guard.ts`).
 *
 * Throws `403 EQUIPMENT_AGENCY_ONLY` on any non-agency caller (including
 * a LAO super-admin — §17.11 NO BYPASS).
 */
export function assertAgencyCaller(workHistory: WorkHistory): void {
  if (!isAgencyWorkHistory(workHistory)) {
    throw new ForbiddenException({
      code: 'EQUIPMENT_AGENCY_ONLY',
      message: 'เฉพาะผู้ใช้สังกัด อบจ.',
    });
  }
}

/**
 * (b) Per-row owner check.
 *
 * §4 ownership invariant: project ownership is compared against
 * `workHistory.id`, NEVER against `user.id`. The caller-side
 * `callerWorkHistoryId` MUST be sourced from the current
 * (`isCurrent = true`) WorkHistory resolved by the guard / service.
 *
 * Per BE-02 task brief: throw on FIRST violation; do NOT accumulate.
 * Service-layer callers are expected to invoke this once per loaded
 * `EquipmentProjectGroup` row inside the request's row-iteration loop.
 *
 * Throws `403 EQUIPMENT_NOT_OWNED` when the row's creator WorkHistory id
 * does not match the caller's current WorkHistory id.
 */
export function assertOwnership(
  row: Pick<EquipmentProjectGroup, 'id' | 'createdBy'>,
  callerWorkHistoryId: string,
): void {
  const ownerWorkHistoryId = row.createdBy?.id;
  if (!ownerWorkHistoryId || ownerWorkHistoryId !== callerWorkHistoryId) {
    throw new ForbiddenException({
      code: 'EQUIPMENT_NOT_OWNED',
      message: 'ครุภัณฑ์ที่เลือกมีรายการที่ไม่ใช่ของคุณ',
    });
  }
}

/**
 * (c) Per-row STRATEGY_BASED classification shape check (Q2 LOCKED
 * 2026-05-28).
 *
 * Wave Print ผ.03 v1 narrows §16.5 "equipment supports both shapes" to
 * STRATEGY_BASED-only for the print surface. Per Q2:
 *
 *   `strategy_id IS NOT NULL AND tactic_id IS NOT NULL AND
 *    plan_id IS NOT NULL AND development_issue_id IS NULL`
 *
 * The check is intentionally LOUD — do NOT silently skip an ISSUE_BASED
 * row. Loud failure surfaces the contract to any future ISSUE_BASED
 * equipment author immediately (§16.5 invariant is a CHECK constraint
 * at the DB layer, so the row will ALWAYS satisfy exactly-one-shape; a
 * `null` strategy here means the row is ISSUE_BASED).
 *
 * Throws `400 EQUIPMENT_PRINT_REQUIRES_STRATEGY_SHAPE` on violation.
 */
export function assertStrategyShape(
  row: Pick<
    EquipmentProjectGroup,
    'id' | 'strategy' | 'tactic' | 'plan' | 'developmentIssue'
  >,
): void {
  const hasStrategy = row.strategy != null && row.strategy.id != null;
  const hasTactic = row.tactic != null && row.tactic.id != null;
  const hasPlan = row.plan != null && row.plan.id != null;
  const hasIssue =
    row.developmentIssue != null && row.developmentIssue.id != null;

  if (!hasStrategy || !hasTactic || !hasPlan || hasIssue) {
    throw new BadRequestException({
      code: 'EQUIPMENT_PRINT_REQUIRES_STRATEGY_SHAPE',
      message:
        'ผ.03 พิมพ์ได้เฉพาะครุภัณฑ์ที่มีกลยุทธ์และแผนงาน (STRATEGY_BASED)',
    });
  }
}
