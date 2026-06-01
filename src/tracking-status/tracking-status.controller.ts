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
// Wave wave-orphan-cleanup-history / BE-01 (2026-06-01).
// Owner-scoped read-side aggregator over §18-cascade `tracking_status`
// rows (FROZEN reason patterns per §18.6). Sanctioned by §18.13.
import { OrphanCleanupHistoryQueryDto } from './dto/orphan-cleanup-history.dto';
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

  /**
   * Wave Equipment ผ.03 Phase 2 — BE-04b (2026-05-28).
   * Tracking-status write endpoint for EquipmentProjectGroup.
   * Handles owner Pull_Back, owner resubmission, and staff workflow
   * transitions (Pending → Verified, Verified → Pending_Approval,
   * Pending_Approval → Approved, * → Returned_For_Revision, * → Rejected).
   * Mirrors `create-by-supplement-project-group` shape; the equipment id
   * may be supplied via either `equipmentProjectGroupId` (preferred) or
   * `projectId` (legacy mirror).
   */
  @Post('create-by-equipment-project-group')
  createByEquipmentProjectGroup(
    @Body() dto: CreateTrackingStatusDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(
      'Request to create tracking status by equipment project group',
    );
    return this.trackingStatusService.createByEquipmentProjectGroup(
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

  /**
   * Wave wave-orphan-cleanup-history / BE-01 (2026-06-01).
   *
   * Owner-scoped history of §18 orphan-cleanup cascade events affecting
   * the caller's projects (PG / RPG / SPG / Equipment). Strictly
   * advisory (§17.2) — read-only over EXISTING `tracking_status` rows;
   * no writes, no notifications, no workflow gating.
   *
   * Sanctioned read surface per CLAUDE.md §18.13 — read-side aggregator
   * allowance over the FROZEN §18.6 reason templates. Distinct from the
   * admin-only `/v1/book-cleanup/preview` which is staff-scoped (§18.3
   * authority).
   */
  @Get('orphan-cleanup-history')
  getOrphanCleanupHistory(
    @Query() query: OrphanCleanupHistoryQueryDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(
      `Request orphan-cleanup history (page=${query.page ?? 1}, limit=${query.limit ?? 20}, kind=${query.kind ?? 'all'})`,
    );
    return this.trackingStatusService.getOrphanCleanupHistory(
      req.user.userId,
      query,
    );
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

  /**
   * Wave Equipment ผ.03 Phase 2 — BE-04b (2026-05-28).
   * Staff-led rollback for EquipmentProjectGroup. Mirrors the PG
   * rollback endpoint; amphoe-based responsibility is enforced inside
   * the service. The `clearResponsibleAgency` flag is silently ignored
   * (equipment is agency-only by construction; §7.2/§7.3 LAO-origin
   * clearing is unreachable).
   */
  @Post('rollback/equipment-project-group/:equipmentProjectGroupId')
  rollbackStatusEquipmentProjectGroup(
    @Param('equipmentProjectGroupId', ParseUUIDPipe)
    equipmentProjectGroupId: string,
    @Body() body: { clearResponsibleAgency?: boolean },
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(
      `Request to pull back equipment project group: ${equipmentProjectGroupId}`,
    );
    return this.trackingStatusService.rollbackEquipmentProjectGroupStatus(
      equipmentProjectGroupId,
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
