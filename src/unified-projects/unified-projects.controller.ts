/**
 * SUPP_AGG_BE_01 — Public HTTP surface for the unified-projects
 * projection (PG + RPG + SPG). Two read-only routes:
 *
 *   GET /v1/unified-projects/owner-list
 *      Caller's classification-scoped projection. LAO callers receive
 *      no `supplement` rows per §1 + §5.
 *
 *   GET /v1/unified-projects/executive-list
 *      System-wide projection. Excludes the W67 in-flight statuses
 *      (`Ready` / `Pull_Back` / `Returned_For_Revision`).
 *
 * Guard chain (mirrors `AiExecutiveChatController` BE-04 canon):
 *   JwtAuthGuard → [RolesGuard] → WorkStatusApprovedGuard
 *
 * The executive route additionally composes `@Roles(...EXEC_READ)` so
 * only staff-lead + c-level callers reach the system-wide projection.
 * The owner route omits `@Roles(...)` — any authenticated caller with
 * an approved WorkHistory can read THEIR OWN scoped projection.
 *
 * CLAUDE.md references:
 *   - §4.1  Ownership vs Workflow Authority — owner-list returns the
 *     caller-scoped projection; executive-list is staff-controlled.
 *   - §12   Audit Rule — read-only; zero `tracking_status` writes.
 *   - §17.2 / §17.11 — advisory, no role exemption.
 */
import {
  Controller,
  Get,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { RolesGuard } from 'src/auth/roles.guard';
import { WorkStatusApprovedGuard } from 'src/auth/work-status-approved.guard';
import { Roles } from 'src/auth/roles.decorator';
import { EXEC_READ, STAFF_LEAD } from 'src/auth/role-groups';

import {
  parseCountOnly,
  type UnifiedProjectsCountEnvelope,
} from './dto/list-unified-projects.dto';
import { UnifiedProjectsService } from './unified-projects.service';
import type { EnrichedUnifiedProject } from './types/enriched-unified-project';

@Controller({
  path: 'unified-projects',
  version: '1',
})
@UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
export class UnifiedProjectsController {
  constructor(private readonly service: UnifiedProjectsService) {}

  /**
   * GET /v1/unified-projects/owner-list
   *
   * Query:
   *   - `developmentPlanId?: UUID` — optional plan-scope filter.
   *   - `countOnly?: boolean` — when `true`, return the W67 4-group
   *      rollup envelope instead of the row list.
   *
   * §1 classification gate is applied in the service layer.
   */
  @Get('owner-list')
  ownerList(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('developmentPlanId', new ParseUUIDPipe({ optional: true }))
    developmentPlanId: string | undefined,
    @Query('countOnly') countOnlyRaw?: string,
  ): Promise<EnrichedUnifiedProject[] | UnifiedProjectsCountEnvelope> {
    return this.service.ownerList(req.user.userId, {
      developmentPlanId,
      countOnly: parseCountOnly(countOnlyRaw),
    });
  }

  /**
   * GET /v1/unified-projects/executive-list
   *
   * Query:
   *   - `developmentPlanId?: UUID` — optional plan-scope filter.
   *   - `countOnly?: boolean` — when `true`, return the W67 4-group
   *      rollup envelope instead of the row list.
   *
   * Excludes the W67 in-flight statuses (Ready / Pull_Back /
   * Returned_For_Revision). Roles: EXEC_READ — staff + admin +
   * super-admin + c-level (matches `AiExecutiveChatController`).
   */
  @Get('executive-list')
  @Roles(...EXEC_READ)
  executiveList(
    @Query('developmentPlanId', new ParseUUIDPipe({ optional: true }))
    developmentPlanId: string | undefined,
    @Query('countOnly') countOnlyRaw?: string,
  ): Promise<EnrichedUnifiedProject[] | UnifiedProjectsCountEnvelope> {
    return this.service.executiveList({
      developmentPlanId,
      countOnly: parseCountOnly(countOnlyRaw),
    });
  }

  /**
   * GET /v1/unified-projects/staff-list
   *
   * Staff-workspace, AREA-SCOPED analog of `executive-list`. Response
   * shape is BYTE-IDENTICAL to `executive-list` (`EnrichedUnifiedProject[]`
   * or the W67 count envelope) so the FE shared list component renders
   * both via one adapter.
   *
   * Query:
   *   - `developmentPlanId?: UUID` — §10 plan-scope filter.
   *   - `countOnly?: boolean` — W67 4-group rollup envelope instead of
   *      the row list.
   *
   * Area scope (§1 / §3 / §4.1) is resolved in the service layer from
   * the caller's current WorkHistory responsibilities (same mechanism
   * as `StaffHomeService`): `staff` see ONLY their responsible amphoes
   * (PG) + agencies (RPG/SPG); `admin` / `super-admin` bypass to
   * system-wide; plain `staff` with zero responsibilities fail-closed
   * to `[]`.
   *
   * Roles: STAFF_LEAD — staff + admin + super-admin (NOT `EXEC_READ`;
   * `c-level` is an executive read role, not a staff workspace role).
   *
   * §17.2 / §18.13 — strictly advisory, read-side aggregator: zero
   * `tracking_status` / AI / notification writes.
   */
  @Get('staff-list')
  @Roles(...STAFF_LEAD)
  staffList(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('developmentPlanId', new ParseUUIDPipe({ optional: true }))
    developmentPlanId: string | undefined,
    @Query('countOnly') countOnlyRaw?: string,
  ): Promise<EnrichedUnifiedProject[] | UnifiedProjectsCountEnvelope> {
    return this.service.staffList(req.user.userId, {
      developmentPlanId,
      countOnly: parseCountOnly(countOnlyRaw),
    });
  }
}
