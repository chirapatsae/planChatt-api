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
 *      plan-scoped, newest-first.
 *
 * Guard chain (mirrors the equipment READ surface):
 *   JwtAuthGuard → WorkStatusApprovedGuard
 *
 * `AgencyOnlyGuard` is INTENTIONALLY NOT mounted — per §5.3 the
 * agency-only rule is a WRITE gate; equipment READS are unrestricted
 * (LAO callers may view).
 *
 * CLAUDE.md references:
 *   - §5.3  reads unrestricted; agency-only is a write gate.
 *   - §12   audit — read-only; zero `tracking_status` writes.
 *   - §17.2 / §17.11 — advisory, no role exemption.
 */
@Controller({
  path: 'unified-equipment',
  version: '1',
})
@UseGuards(JwtAuthGuard, WorkStatusApprovedGuard)
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
}
