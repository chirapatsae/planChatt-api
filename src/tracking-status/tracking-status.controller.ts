import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Logger,
  UseGuards,
  ParseUUIDPipe,
  Query,
  Req,
} from '@nestjs/common';
import { TrackingStatusService } from './tracking-status.service';
import { CreateTrackingStatusDto } from './dto/create-tracking-status.dto';
import { UpdateTrackingStatusDto } from './dto/update-tracking-status.dto';
import { BulkSubmitDto } from './dto/bulk-submit.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';

@Controller({
  path: 'tracking-status',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class TrackingStatusController {
  private readonly logger = new Logger(TrackingStatusController.name);

  constructor(private readonly trackingStatusService: TrackingStatusService) { }

  @Post()
  create(
    @Body() dto: CreateTrackingStatusDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log('Request to create tracking status');
    return this.trackingStatusService.create(dto, req.user.userId);
  }

  @Post('create-by-revised-project-group')
  createByRevisedProjectGroup(
    @Body() dto: CreateTrackingStatusDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log('Request to create tracking status by revised project group');
    return this.trackingStatusService.createByRevisedProjectGroup(dto, req.user.userId);
  }

  /**
   * SUPP-1 / BE-02 — Tracking-status write endpoint for SupplementProjectGroup.
   * Handles owner Pull_Back, owner resubmission, and staff workflow
   * transitions (Pending → Verified, Verified → Pending_Approval,
   * Pending_Approval → Approved, Pending|Verified → Returned_For_Revision).
   * Mirrors `create-by-revised-project-group` shape; the SPG id may be
   * supplied via either `supplementProjectGroupId` (preferred) or `projectId`.
   */
  @Post('create-by-supplement-project-group')
  createBySupplementProjectGroup(
    @Body() dto: CreateTrackingStatusDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(
      'Request to create tracking status by supplement project group',
    );
    return this.trackingStatusService.createBySupplementProjectGroup(
      dto,
      req.user.userId,
    );
  }

  @Post('bulk')
  createMany(
    @Body() dtos: CreateTrackingStatusDto[],
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.trackingStatusService.createMany(dtos, req.user.userId);
  }

  /**
   * W105-BE-PR1 — Owner-scoped bulk Ready → Pending submit for main-plan
   * projects. Replaces the N-parallel `POST /tracking-status/` storm
   * produced by `ReadyToSendPage.tsx`.
   *
   * NOTE: this is INTENTIONALLY a separate route from `POST /bulk` (which
   * is staff-only and accepts arbitrary transitions). DO NOT merge them —
   * permission models, allowed transitions, and partial-success semantics
   * differ. Single-project `POST /tracking-status/` is UNCHANGED.
   *
   * Returns HTTP 200 with `{ results: [...] }` even on partial failure.
   * Per-row error codes are stable strings consumed by the frontend toast.
   */
  @Post('bulk-submit')
  bulkSubmit(
    @Body() dto: BulkSubmitDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(
      `Request to bulk-submit Ready→Pending for ${dto.projectIds?.length ?? 0} projects`,
    );
    return this.trackingStatusService.bulkSubmit(req.user.userId, dto);
  }

  @Post('bulk/revised-project-group')
  createManyRevisedProjectGroup(
    @Body() dtos: CreateTrackingStatusDto[],
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.trackingStatusService.createManyRevisedProjectGroup(dtos, req.user.userId);
  }

  /**
   * SUPP_STAFF_BE_02 — Atomic bulk transition endpoint for
   * SupplementProjectGroup. Sibling of `POST /bulk/revised-project-group`.
   *
   * Stage 2 / Stage 3 of the staff supplement workflow uses this endpoint to
   * promote many SPGs in a single round-trip (typical case:
   * Verified → Pending_Approval before draft-PDF generation).
   *
   * Atomic semantics — any per-row guard failure rolls back ALL rows in the
   * batch (single `dataSource.transaction`). Per-row guards reuse the same
   * scope / responsibility / transition map enforced by
   * `createBySupplementProjectGroup`. Cap = 200 rows (§19.6 / task §7).
   *
   * §17.4 baseline snapshot is NOT fired — staff bulk transitions are NOT
   * authoring surfaces (Wave 11 clarification). §18 cascade is NOT
   * triggered — cascade only fires on book cancel / finalize, never on
   * individual project transitions.
   */
  @Post('bulk/supplement-project-group')
  createManySupplementProjectGroup(
    @Body() dtos: CreateTrackingStatusDto[],
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(
      `Request to bulk-transition ${dtos?.length ?? 0} supplement project group(s)`,
    );
    return this.trackingStatusService.createManySupplementProjectGroup(
      dtos,
      req.user.userId,
    );
  }


  @Get()
  findAll() {
    this.logger.log('Request to fetch all tracking statuses');
    return this.trackingStatusService.findAll();
  }

  @Post('rollback/:projectGroupId')
  rollbackStatus(
    @Param('projectGroupId', ParseUUIDPipe) projectGroupId: string,
    @Body() body: { clearResponsibleAgency?: boolean },
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(`Request to pull back project group: ${projectGroupId}`);
    return this.trackingStatusService.rollbackStatus(projectGroupId, req.user.userId, body?.clearResponsibleAgency);
  }


  @Post('rollback/revised-project-group/:revisionProjectGroupId')
  rollbackStatusRevisedProjectGroup(
    @Param('revisionProjectGroupId', ParseUUIDPipe) revisionProjectGroupId: string,
    @Body() body: { clearResponsibleAgency?: boolean },
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(`Request to pull back revised project group: ${revisionProjectGroupId}`);
    return this.trackingStatusService.rollbackRevisionProjectGroupStatus(revisionProjectGroupId, req.user.userId, body?.clearResponsibleAgency);
  }

  /**
   * SUPP-1 / BE-02 — Staff-led rollback for SupplementProjectGroup.
   * Mirrors the RPG rollback endpoint; agency-based responsibility (Q3)
   * and §14.6 row hard-delete are enforced inside the service.
   */
  @Post('rollback/supplement-project-group/:supplementProjectGroupId')
  rollbackStatusSupplementProjectGroup(
    @Param('supplementProjectGroupId', ParseUUIDPipe)
    supplementProjectGroupId: string,
    @Body() body: { clearResponsibleAgency?: boolean },
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(
      `Request to pull back supplement project group: ${supplementProjectGroupId}`,
    );
    return this.trackingStatusService.rollbackSupplementProjectGroupStatus(
      supplementProjectGroupId,
      req.user.userId,
      body?.clearResponsibleAgency,
    );
  }


  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.log(`Request to fetch tracking status with ID: ${id}`);
    return this.trackingStatusService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTrackingStatusDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(`Request to update tracking status with ID: ${id}`);
    return this.trackingStatusService.update(id, dto, req.user.userId);
  }

  @Delete(':id')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.trackingStatusService.softRemove(id, req.user.userId);
  }

  @Patch(':id/restore')
  restore(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.trackingStatusService.restore(id, req.user.userId);
  }
}
