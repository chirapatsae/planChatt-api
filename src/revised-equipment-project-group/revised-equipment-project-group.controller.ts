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
import { Request } from 'express';

import { RevisedEquipmentProjectGroupService } from './revised-equipment-project-group.service';
import { CreateRevisedEquipmentProjectGroupDto } from './dto/create-revised-equipment-project-group.dto';
import { UpdateRevisedEquipmentProjectGroupDto } from './dto/update-revised-equipment-project-group.dto';
import { ListRevisedEquipmentProjectGroupsQueryDto } from './dto/list-revised-equipment-project-groups-query.dto';
import { StaffTransitionRevisedEquipmentProjectGroupDto } from './dto/staff-transition-revised-equipment-project-group.dto';
import { RollbackRevisedEquipmentProjectGroupDto } from './dto/rollback-revised-equipment-project-group.dto';
import { PullBackRevisedEquipmentProjectGroupDto } from './dto/pull-back-revised-equipment-project-group.dto';
import { ChangeDevelopmentPlanRevisionDto } from './dto/change-development-plan-revision.dto';

import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { WorkStatusApprovedGuard } from 'src/auth/work-status-approved.guard';
import { AgencyOnlyGuard } from 'src/common/guards/agency-only.guard';
import { RolesGuard } from 'src/auth/roles.guard';
import { Roles } from 'src/auth/roles.decorator';
import { STAFF_LEAD } from 'src/auth/role-groups';

/**
 * Wave Equipment Revision Management — BE-01 (Phase 3).
 *
 * RELPG (RevisedEquipmentProjectGroup) REST surface — the equipment
 * (ผ.03) revision/change authoring flow.
 *
 * Auth composition:
 *   - All endpoints require JWT + workStatus=approved.
 *   - WRITE endpoints (POST / PATCH / DELETE) additionally mount
 *     `AgencyOnlyGuard` (§3 / §5.3 — revision/change is agency-only).
 *   - READ endpoints (GET) intentionally OMIT `AgencyOnlyGuard` — LAO
 *     users may view RELPG (§5.3 reads unrestricted). The
 *     `counts-by-status` read returns zeros for LAO callers naturally.
 *
 * Staff review transitions (verify / move-to-approval / approve /
 * return-for-revision / rollback) and the status-filtered staff queue
 * finders are exposed here under the BE-02 STAFF sections below. They are
 * role-gated `@Roles(...STAFF_LEAD)` via the controller-wide `RolesGuard`
 * and DELIBERATELY OMIT `AgencyOnlyGuard` — per §4.1 / §5.3 staff workflow
 * transitions are orthogonal to the agency-only authoring gate and are NOT
 * ownership-scoped.
 */
@Controller({
  path: 'revised-equipment-project-group',
  version: '1',
})
// `RolesGuard` is a no-op on routes WITHOUT `@Roles()` metadata (returns
// true), so mounting it controller-wide leaves the user-facing BE-01 routes
// unchanged while activating the staff-lead gate on the BE-02 `@Roles(...)`
// endpoints below. Chain order is JwtAuthGuard → ... → RolesGuard so
// `req.user.role` is populated before RolesGuard reads it.
@UseGuards(JwtAuthGuard, WorkStatusApprovedGuard, RolesGuard)
export class RevisedEquipmentProjectGroupController {
  constructor(
    private readonly service: RevisedEquipmentProjectGroupService,
  ) {}

  // ──────────────────────────────────────────────────────────────────
  //  WRITE — agency-only (§3 / §5.3)
  // ──────────────────────────────────────────────────────────────────

  @Post()
  @UseGuards(AgencyOnlyGuard)
  async create(
    @Body() dto: CreateRevisedEquipmentProjectGroupDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.create(dto, req.user.userId);
  }

  @Post('draft')
  @UseGuards(AgencyOnlyGuard)
  async createDraft(
    @Body() dto: CreateRevisedEquipmentProjectGroupDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.createDraft(dto, req.user.userId);
  }

  @Patch(':id')
  @UseGuards(AgencyOnlyGuard)
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateRevisedEquipmentProjectGroupDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.update(id, dto, req.user.userId);
  }

  @Patch(':id/submit')
  @UseGuards(AgencyOnlyGuard)
  async submit(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.submit(id, req.user.userId);
  }

  @Patch(':id/pull-back')
  @UseGuards(AgencyOnlyGuard)
  async pullBack(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: PullBackRevisedEquipmentProjectGroupDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.pullBack(id, req.user.userId, dto.comment);
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
  //  STAFF — workflow transitions + rollback (BE-02)
  //
  //  Role-gated `@Roles(...STAFF_LEAD)` (staff / admin / super-admin).
  //  AgencyOnlyGuard is INTENTIONALLY NOT mounted — per §4.1 / §5.3 staff
  //  workflow transitions are orthogonal to the agency-only authoring gate.
  //  Each route carries a literal sub-segment (`verify` / `approve` / …) so
  //  it wins route resolution against `@Patch(':id')` above.
  // ──────────────────────────────────────────────────────────────────

  @Patch(':id/verify')
  @Roles(...STAFF_LEAD)
  async verify(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: StaffTransitionRevisedEquipmentProjectGroupDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.verifyByStaff(id, dto, req.user.userId);
  }

  @Patch(':id/move-to-approval')
  @Roles(...STAFF_LEAD)
  async moveToApproval(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: StaffTransitionRevisedEquipmentProjectGroupDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.moveToApprovalByStaff(id, dto, req.user.userId);
  }

  @Patch(':id/approve')
  @Roles(...STAFF_LEAD)
  async approve(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: StaffTransitionRevisedEquipmentProjectGroupDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.approveByStaff(id, dto, req.user.userId);
  }

  @Patch(':id/return-for-revision')
  @Roles(...STAFF_LEAD)
  async returnForRevision(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: StaffTransitionRevisedEquipmentProjectGroupDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.returnForRevisionByStaff(id, dto, req.user.userId);
  }

  @Patch(':id/rollback')
  @Roles(...STAFF_LEAD)
  async rollback(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RollbackRevisedEquipmentProjectGroupDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.rollbackByStaff(id, dto, req.user.userId);
  }

  /**
   * §4.1 staff round-reassignment — move a RELPG to a DIFFERENT revision
   * round of the SAME plan (fix a wrong edit↔change submission). Mirrors
   * the project equivalent
   * (`@Patch('change/developmentPlanRevision/:id')` on the RPG controller).
   *
   * Staff-lead gated, NO `AgencyOnlyGuard` (§4.1 — staff workflow action,
   * orthogonal to agency-only authoring; same as verify / approve above).
   * Literal sub-segment so it wins route resolution against `@Patch(':id')`.
   */
  @Patch(':id/change-development-plan-revision')
  @Roles(...STAFF_LEAD)
  async changeDevelopmentPlanRevision(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ChangeDevelopmentPlanRevisionDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.changeDevelopmentPlanRevision(
      id,
      dto.developmentPlanRevisionId,
      req.user.userId,
    );
  }

  // ──────────────────────────────────────────────────────────────────
  //  READ — LAO users allowed (§5.3)
  // ──────────────────────────────────────────────────────────────────

  @Get()
  async findAll(
    @Query() query: ListRevisedEquipmentProjectGroupsQueryDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.findAll(query, req.user.userId);
  }

  @Get('mine')
  async findMine(
    @Query() query: ListRevisedEquipmentProjectGroupsQueryDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.findMine(query, req.user.userId);
  }

  /**
   * Wave equipment-revision-pool-lineage-tip-fix — BE-01.
   *
   * Source pool for the revision/change equipment authoring wizard: the
   * Approved RELPG lineage LEAVES (head-of-lineage, NO live
   * `revised_equipment` descendant) under a plan. The wizard merges these
   * with the Approved EPG leaves so a lineage whose head is now an RELPG can
   * be revised again (§14.2/§14.7 Phase 3 — the leaf, never the locked
   * ancestor, never zero rows for a live lineage).
   *
   * Read-only (§17.2). Agency-only is NOT mounted — reads are unrestricted
   * per §5.3; the WRITE/fork path enforces agency-only.
   *
   * MUST be declared ABOVE `@Get(':id')` to win route resolution.
   */
  @Get('sources')
  async findApprovedLineageLeafSources(
    @Query('developmentPlanId') developmentPlanId: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.findApprovedLineageLeafSources(
      developmentPlanId,
      req.user.userId,
    );
  }

  /**
   * §7.10 — owner-scoped per-status counts for FE-03 sidebar badges.
   *
   * `AgencyOnlyGuard` is INTENTIONALLY NOT mounted — the classification
   * gate lives inside the service so the sidebar fetch never errors for
   * LAO callers (they receive all-zero counts). Mirrors the EPG
   * `counts-by-status` precedent.
   *
   * MUST be declared above `@Get(':id')` to win route resolution.
   */
  @Get('counts-by-status')
  async getCountsByStatus(
    @Query('developmentPlanRevisionId') developmentPlanRevisionId: string | undefined,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.getCountsByStatus(
      req.user.userId,
      developmentPlanRevisionId,
    );
  }

  // ──────────────────────────────────────────────────────────────────
  //  STAFF — status-filtered queue finders (BE-02 §7.5)
  //
  //  Role-gated `@Roles(...STAFF_LEAD)`. All literal `staff/*` segments are
  //  declared ABOVE `@Get(':id')` so they win route resolution. Area-scoped
  //  for `staff` role (responsibleAgency filter); admin / super-admin see
  //  all. No AgencyOnlyGuard (§4.1 / §5.3).
  // ──────────────────────────────────────────────────────────────────

  @Get('staff/pending')
  @Roles(...STAFF_LEAD)
  async findStaffPending(
    @Query() query: ListRevisedEquipmentProjectGroupsQueryDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.findStaffPending(query, req.user.userId);
  }

  @Get('staff/verified')
  @Roles(...STAFF_LEAD)
  async findStaffVerified(
    @Query() query: ListRevisedEquipmentProjectGroupsQueryDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.findStaffVerified(query, req.user.userId);
  }

  @Get('staff/pending-approval')
  @Roles(...STAFF_LEAD)
  async findStaffPendingApproval(
    @Query() query: ListRevisedEquipmentProjectGroupsQueryDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.findStaffPendingApproval(query, req.user.userId);
  }

  @Get('staff/approved')
  @Roles(...STAFF_LEAD)
  async findStaffApproved(
    @Query() query: ListRevisedEquipmentProjectGroupsQueryDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.findStaffApproved(query, req.user.userId);
  }

  @Get('staff/returned')
  @Roles(...STAFF_LEAD)
  async findStaffReturned(
    @Query() query: ListRevisedEquipmentProjectGroupsQueryDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.findStaffReturned(query, req.user.userId);
  }

  /**
   * ดูประวัติการแก้ไขทั้งหมดของครุภัณฑ์ (EPG root + RELPG revisions).
   *
   * Equipment-revision lineage chain — the ผ.03 analog of the project
   * `@Get(':id/versions')` route on the RPG controller. Read-only (§17.2),
   * reads unrestricted (§5.3 — NO AgencyOnlyGuard; LAO callers allowed).
   * The `id` may be EITHER an EPG (root) or a RELPG.
   *
   * MUST be declared ABOVE `@Get(':id')` to win NestJS route resolution
   * (same ordering rule as `counts-by-status` / `staff/*`).
   */
  @Get(':id/versions')
  async findAllVersions(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.findAllVersions(id, req.user.userId);
  }

  @Get(':id')
  async findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.findOne(id);
  }
}
