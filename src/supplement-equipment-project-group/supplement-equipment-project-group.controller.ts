import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { SupplementEquipmentProjectGroupService } from './supplement-equipment-project-group.service';
import { CreateSupplementEquipmentProjectGroupDto } from './dto/create-supplement-equipment-project-group.dto';
import { UpdateSupplementEquipmentProjectGroupDto } from './dto/update-supplement-equipment-project-group.dto';
import { ListSupplementEquipmentProjectGroupsQueryDto } from './dto/list-supplement-equipment-project-groups-query.dto';

import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { WorkStatusApprovedGuard } from 'src/auth/work-status-approved.guard';
import { AgencyOnlyGuard } from 'src/common/guards/agency-only.guard';

/**
 * Wave wave-supplement-equipment-por03 — BE-B1 (2026-06-08).
 *
 * Supplement-equipment item (ครุภัณฑ์ ผ.03 under เล่มเพิ่มเติม) REST
 * surface. Mirrors `EquipmentProjectGroupController`.
 *
 * Auth composition:
 *   - All endpoints require JWT + workStatus=approved.
 *   - WRITE endpoints (POST / PATCH / DELETE) additionally mount
 *     `AgencyOnlyGuard` (§1 classification, §5.3 Q-AGENCY). The service
 *     re-asserts `isAgencyWorkHistory` as Layer-2 defense-in-depth.
 *   - READ endpoints (GET) intentionally OMIT `AgencyOnlyGuard` — LAO
 *     users may view supplement-equipment items (§5.3 read-unrestricted).
 *
 * Workflow transitions (Pending → Verified → ...) flow through
 * `TrackingStatusService` (BE-B2) and are NOT exposed here.
 */
@Controller({
  path: 'supplement-equipment-project-group',
  version: '1',
})
@UseGuards(JwtAuthGuard, WorkStatusApprovedGuard)
export class SupplementEquipmentProjectGroupController {
  constructor(
    private readonly service: SupplementEquipmentProjectGroupService,
  ) {}

  // ──────────────────────────────────────────────────────────────────
  //  WRITE — agency-only
  // ──────────────────────────────────────────────────────────────────

  @Post()
  @UseGuards(AgencyOnlyGuard)
  async create(
    @Body() dto: CreateSupplementEquipmentProjectGroupDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.create(dto, req.user.userId);
  }

  @Patch(':id')
  @UseGuards(AgencyOnlyGuard)
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSupplementEquipmentProjectGroupDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.update(id, dto, req.user.userId);
  }

  @Delete(':id')
  @UseGuards(AgencyOnlyGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ): Promise<void> {
    await this.service.softRemove(id, req.user.userId);
  }

  // ──────────────────────────────────────────────────────────────────
  //  READ — LAO users allowed
  // ──────────────────────────────────────────────────────────────────

  @Get()
  async findAll(
    @Query() query: ListSupplementEquipmentProjectGroupsQueryDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.findAll(query, req.user.userId);
  }

  @Get('mine')
  async findMine(
    @Query() query: ListSupplementEquipmentProjectGroupsQueryDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.findAll(
      { ...query, mineOnly: true },
      req.user.userId,
    );
  }

  /**
   * Wave wave-supplement-equipment-por03 — counts-by-status (2026-06-09).
   *
   * Owner-scoped per-status count envelope. Mirrors
   * `EquipmentProjectGroupController.getCountsByStatus`.
   *
   * Response (FROZEN):
   *   `{ ready, pending, verified, returnedForRevision, pullBack }`
   *
   * Authority:
   *   - agency-classified callers — live counts (§4 owner-scope)
   *   - LAO / non-agency callers — all-zero envelope at HTTP 200
   *     (NOT 403). `AgencyOnlyGuard` is INTENTIONALLY NOT mounted — the
   *     classification gate lives inside the service so the sidebar
   *     fetch never errors for LAO users. Mirrors EPG precedent.
   *   - §17.11 no role bypass — super-admin LAO also gets zeros.
   *
   * §17.2 advisory-only — counts MUST NOT gate any workflow.
   * §17.3 audit separation — READ-ONLY; no `TrackingStatus` writes.
   *
   * MUST be declared above `@Get(':id')` to win route resolution.
   */
  @Get('counts-by-status')
  async getCountsByStatus(
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.getCountsByStatus(req.user.userId);
  }

  @Get(':id')
  async findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.findOne(id);
  }
}
