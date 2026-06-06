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
import { WorkStatusApprovedGuard } from 'src/auth/work-status-approved.guard';
import { RolesGuard } from 'src/auth/roles.guard';
import { Roles } from 'src/auth/roles.decorator';
import { EXEC_READ } from 'src/auth/role-groups';

import { UnifiedEquipmentService } from './unified-equipment.service';
import { ListUnifiedEquipmentQueryDto } from './dto/list-unified-equipment-query.dto';
import type { UnifiedEquipmentRow } from './types/unified-equipment-row';

/**
 * Wave Unified Equipment Tab — BE-01.
 *
 * Read-only HTTP surface for the unified equipment projection
 * (EPG + RELPG, latest-version-aware via §14.2 HEAD-of-lineage). The
 * equipment analog of `UnifiedProjectsController.ownerList`.
 *
 *   GET /v1/unified-equipment/owner-list
 *      Merged EPG (เล่มหลัก, head rows) + RELPG (เล่มแก้ไข, head rows),
 *      plan-scoped, newest-first. Any authenticated, approved caller may
 *      read (no `@Roles` on this route).
 *
 *   GET /v1/unified-equipment/executive-list
 *      System-wide projection — excludes the W67 in-flight statuses
 *      (Ready / Pull_Back / Returned_For_Revision) and tags each row with
 *      `executiveStatusGroup`. Gated by `@Roles(...EXEC_READ)` — the SAME
 *      authority as `unified-projects/executive-list` (staff / admin /
 *      super-admin / c-level), NOT the owner gate.
 *
 * Guard chain (mirrors `UnifiedProjectsController`):
 *   JwtAuthGuard → RolesGuard → WorkStatusApprovedGuard
 *
 * `RolesGuard` no-ops on routes without `@Roles` metadata, so `owner-list`
 * stays open to any approved caller; only `executive-list` carries the
 * `EXEC_READ` requirement.
 *
 * `AgencyOnlyGuard` is INTENTIONALLY NOT mounted — per §5.3 the
 * agency-only rule is a WRITE gate; equipment READS are unrestricted
 * (LAO callers may view the owner surface). The executive surface is
 * gated by role, NOT by classification.
 *
 * CLAUDE.md references:
 *   - §5.3  reads unrestricted; agency-only is a write gate.
 *   - §12   audit — read-only; zero `tracking_status` writes.
 *   - §17.2 / §17.11 — advisory, no role exemption.
 *   - §W67  executive view status groups (4-group rollup).
 */
@Controller({
  path: 'unified-equipment',
  version: '1',
})
@UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
export class UnifiedEquipmentController {
  constructor(private readonly service: UnifiedEquipmentService) {}

  /**
   * GET /v1/unified-equipment/owner-list
   *
   * Query:
   *   - `developmentPlanId?: UUID` — §10 plan-scope filter (the FE always
   *      passes the active/latest plan).
   *   - `mineOnly?: boolean` — §4 owner-scope filter.
   */
  @Get('owner-list')
  ownerList(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('developmentPlanId', new ParseUUIDPipe({ optional: true }))
    developmentPlanId: string | undefined,
    @Query('mineOnly') mineOnlyRaw?: string,
  ): Promise<UnifiedEquipmentRow[]> {
    const query: ListUnifiedEquipmentQueryDto = {
      developmentPlanId,
      mineOnly: mineOnlyRaw === 'true' || mineOnlyRaw === '1',
    };
    return this.service.ownerList(req.user.userId, query);
  }

  /**
   * GET /v1/unified-equipment/executive-list
   *
   * Query:
   *   - `developmentPlanId?: UUID` — §10 plan-scope filter.
   *
   * System-wide EPG + RELPG head rows, excluding the W67 in-flight
   * statuses (Ready / Pull_Back / Returned_For_Revision), each tagged with
   * a non-null `executiveStatusGroup`. Roles: `EXEC_READ` — staff + admin
   * + super-admin + c-level (matches `UnifiedProjectsController`).
   *
   * No `mineOnly` / owner filter on this path — executive read is
   * system-wide by definition (§4.1 workflow authority, not ownership).
   */
  @Get('executive-list')
  @Roles(...EXEC_READ)
  executiveList(
    @Query('developmentPlanId', new ParseUUIDPipe({ optional: true }))
    developmentPlanId: string | undefined,
  ): Promise<UnifiedEquipmentRow[]> {
    return this.service.executiveList({ developmentPlanId });
  }
}
