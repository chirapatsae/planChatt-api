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

import { EquipmentProjectGroupService } from './equipment-project-group.service';
import { CreateEquipmentProjectGroupDto } from './dto/create-equipment-project-group.dto';
import { UpdateEquipmentProjectGroupDto } from './dto/update-equipment-project-group.dto';
import { ListEquipmentProjectGroupsQueryDto } from './dto/list-equipment-project-groups-query.dto';

import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { WorkStatusApprovedGuard } from 'src/auth/work-status-approved.guard';
import { AgencyOnlyGuard } from 'src/common/guards/agency-only.guard';

/**
 * Wave Equipment ผ.03, Phase 2 — BE-04 (2026-05-28).
 *
 * Equipment item (ครุภัณฑ์ ผ.03) REST surface.
 *
 * Auth composition:
 *   - All endpoints require JWT + workStatus=approved.
 *   - WRITE endpoints (POST / PATCH / DELETE) additionally mount
 *     `AgencyOnlyGuard` (§1 classification, Q-AGENCY locked decision).
 *   - READ endpoints (GET) intentionally OMIT `AgencyOnlyGuard` — LAO
 *     users may view equipment items.
 *
 * Workflow transitions (Pending → Verified → ...) flow through
 * `TrackingStatusService` and are NOT exposed here. See BE-04 risks for
 * the equipment-branch flag in tracking-status / rollback / orphan
 * cleanup.
 */
@Controller({
  path: 'equipment-project-group',
  version: '1',
})
@UseGuards(JwtAuthGuard, WorkStatusApprovedGuard)
export class EquipmentProjectGroupController {
  constructor(
    private readonly service: EquipmentProjectGroupService,
  ) {}

  // ──────────────────────────────────────────────────────────────────
  //  WRITE — agency-only
  // ──────────────────────────────────────────────────────────────────

  @Post()
  @UseGuards(AgencyOnlyGuard)
  async create(
    @Body() dto: CreateEquipmentProjectGroupDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.create(dto, req.user.userId);
  }

  @Patch(':id')
  @UseGuards(AgencyOnlyGuard)
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateEquipmentProjectGroupDto,
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
    @Query() query: ListEquipmentProjectGroupsQueryDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.findAll(query, req.user.userId);
  }

  @Get('mine')
  async findMine(
    @Query() query: ListEquipmentProjectGroupsQueryDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.findAll(
      { ...query, mineOnly: true },
      req.user.userId,
    );
  }

  @Get(':id')
  async findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.findOne(id);
  }
}
