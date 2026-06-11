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
// Wave wave-print-merge-scale-statuschange / BE-01 (2026-06-04) —
// scope-driven promote-Verified request body.
import { PromoteVerifiedScopeDto } from './dto/promote-verified-scope.dto';
// Wave wave-print-merge-scale-statuschange / BE-02 (2026-06-04) —
// scope-driven promote-Verified request body for RevisedProjectGroup.
import { PromoteVerifiedRevisedScopeDto } from './dto/promote-verified-revised-scope.dto';
// Wave wave-print-merge-scale-statuschange / BE-03 (2026-06-04) —
// scope-driven promote-Verified request body for SupplementProjectGroup.
import { PromoteVerifiedSupplementScopeDto } from './dto/promote-verified-supplement-scope.dto';
// Wave wave-print-merge-scale-statuschange / BE-04 (2026-06-04) —
// scope-driven promote-Verified request bodies for EquipmentProjectGroup
// (EPG) and RevisedEquipmentProjectGroup (RELPG).
import { PromoteVerifiedEquipmentScopeDto } from './dto/promote-verified-equipment-scope.dto';
import { PromoteVerifiedRevisedEquipmentScopeDto } from './dto/promote-verified-revised-equipment-scope.dto';
// Wave wave-supplement-equipment-por03 — promote-verified SEPG (2026-06-10).
// Scope-driven promote-Verified request body for
// SupplementEquipmentProjectGroup (the 6th §12.1 member).
import { PromoteVerifiedSupplementEquipmentScopeDto } from './dto/promote-verified-supplement-equipment-scope.dto';
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

  /**
   * Wave wave-supplement-equipment-por03 — BE-B2 (2026-06-08).
   * Tracking-status write endpoint for SupplementEquipmentProjectGroup
   * (ครุภัณฑ์ ผ.03 under เล่มเพิ่มเติม). Handles owner Pull_Back, owner
   * resubmission, and staff workflow transitions (Pending → Verified,
   * Verified → Pending_Approval, Pending_Approval → Approved,
   * * → Returned_For_Revision, * → Rejected). Mirrors
   * `create-by-equipment-project-group`; the SEPG id may be supplied via
   * either `supplementEquipmentProjectGroupId` (preferred) or `projectId`.
   */
  @Post('create-by-supplement-equipment-project-group')
  createBySupplementEquipmentProjectGroup(
    @Body() dto: CreateTrackingStatusDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(
      'Request to create tracking status by supplement equipment project group',
    );
    return this.trackingStatusService.createBySupplementEquipmentProjectGroup(
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

  /**
   * Wave wave-print-merge-scale-statuschange / BE-01 (2026-06-04).
   *
   * Scope-driven staff promotion: move EVERY main-plan ProjectGroup
   * whose latest status is `Verified` under the supplied
   * `developmentPlanId` (agency vs authority/coordinate origin) to
   * `Pending_Approval` in ONE transaction. Returns `{ movedCount }`.
   *
   * Replaces the FE-driven `POST /tracking-status/bulk` array move on the
   * agency + coordinate review pages. The body carries ONLY scope keys —
   * NO id list, NO page/limit. The row set is re-derived server-side from
   * the same list-finder predicate (§10). Staff-only (§3 / §4.1); §17.4
   * baseline NOT fired; §18 cascade NOT triggered.
   */
  @Post('promote-verified/project-group')
  promoteVerifiedProjectGroup(
    @Body() dto: PromoteVerifiedScopeDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(
      `Request to promote Verified→Pending_Approval (plan=${dto.developmentPlanId}, origin=${dto.origin ?? 'agency'})`,
    );
    return this.trackingStatusService.promoteVerifiedProjectGroupsByScope(
      dto,
      req.user.userId,
    );
  }

  /**
   * BE-02 (Wave wave-print-merge-scale-statuschange, 2026-06-04) —
   * scope-driven promote-Verified for RevisedProjectGroup (edit + change).
   *
   * Scope-driven staff promotion: move EVERY RevisedProjectGroup whose
   * latest status is `Verified` under the supplied
   * `developmentPlanId` + `developmentPlanRevisionId` (+ optional
   * `revisionType` edit/change discriminator) to `Pending_Approval` in ONE
   * transaction. Returns `{ movedCount }`.
   *
   * Replaces the FE-driven `POST /tracking-status/bulk/revised-project-group`
   * array move on the staff verify pages 3 (edit) and 4 (change). The body
   * carries ONLY scope keys — NO id list, NO page/limit. The row set is
   * re-derived server-side from the same edit/change verify list-finder
   * predicate (§9 / §10). Staff-only (§3 / §4.1, RPG area responsibility =
   * `responsibleAgency`); §17.4 baseline NOT fired; §18 cascade NOT
   * triggered.
   */
  @Post('promote-verified/revised-project-group')
  promoteVerifiedRevisedProjectGroup(
    @Body() dto: PromoteVerifiedRevisedScopeDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(
      `Request to promote Verified→Pending_Approval RPGs (plan=${dto.developmentPlanId}, revision=${dto.developmentPlanRevisionId}, revisionType=${dto.revisionType ?? 'both'})`,
    );
    return this.trackingStatusService.promoteVerifiedRevisedProjectGroupsByScope(
      dto,
      req.user.userId,
    );
  }

  /**
   * BE-03 (Wave wave-print-merge-scale-statuschange, 2026-06-04) —
   * scope-driven promote-Verified for SupplementProjectGroup.
   *
   * Promotes EVERY SPG whose latest status is `Verified` under the supplied
   * (developmentPlanId + developmentPlanSupplementId) scope to
   * `Pending_Approval` in ONE transaction and returns `{ movedCount }`.
   *
   * PRIMARY correctness fix: the page-based bulk endpoint
   * (`POST /tracking-status/bulk/supplement-project-group`) HARD-CAPS at 200
   * (`BULK_TOO_LARGE`) and rolls back the whole batch, so a supplement round
   * with >200 verified SPGs moves ZERO rows on page 5. This endpoint is a
   * SET operation, not a page — NO row cap. The capped endpoint is retained.
   *
   * Selection reuses the verified-supplement list finder
   * (`findByStatusForStaff`); per-row transition reuses the shared SPG
   * staff-transition helper. Staff-only (§3 / §4.1); §15.4 supplement book
   * lock honored before any move; §17.4 baseline NOT fired; §18 cascade NOT
   * triggered.
   */
  @Post('promote-verified/supplement-project-group')
  promoteVerifiedSupplementProjectGroup(
    @Body() dto: PromoteVerifiedSupplementScopeDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(
      `Request to promote Verified→Pending_Approval SPGs (plan=${dto.developmentPlanId}, supplement=${dto.developmentPlanSupplementId})`,
    );
    return this.trackingStatusService.promoteVerifiedSupplementProjectGroupsByScope(
      dto,
      req.user.userId,
    );
  }

  /**
   * Wave wave-supplement-equipment-por03 (2026-06-10) — scope-driven
   * promote-Verified for SupplementEquipmentProjectGroup (SEPG, ครุภัณฑ์
   * ผ.03 ของเล่มเพิ่มเติม). The 6th member of the §12.1 "Scope-Based Verified
   * Promotion Endpoints" family, and the equipment sibling of the SPG
   * promote above — so the supplement staff "พิมพ์เล่มร่าง" action can move
   * BOTH the supplement project (SPG) AND the supplement equipment (SEPG)
   * sets `Verified → Pending_Approval`, exactly like the change-print page
   * already promotes both RPG and RELPG.
   *
   * Promotes EVERY SEPG whose latest status is `Verified` under the supplied
   * `developmentPlanSupplementId` (§12.1 supplement-book scope key) to
   * `Pending_Approval` in ONE transaction and returns `{ movedCount }`. SET
   * operation — no row cap, no id list, no page / limit.
   *
   * Staff-only (§3 / §4.1 — NOT agency-gated per §5.3, the agency-only rule
   * is authoring-scoped); AGENCY-based area responsibility for `staff`
   * (admin / super-admin bypass); §12 audit per row; §15.4 supplement book
   * lock honored before any move; §17.4 baseline NOT fired (Verified →
   * Pending_Approval is not authoring); §18 cascade NOT triggered.
   */
  @Post('promote-verified/supplement-equipment-project-group')
  promoteVerifiedSupplementEquipmentProjectGroup(
    @Body() dto: PromoteVerifiedSupplementEquipmentScopeDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(
      `Request to promote Verified→Pending_Approval SEPGs (supplement=${dto.developmentPlanSupplementId})`,
    );
    return this.trackingStatusService.promoteVerifiedSupplementEquipmentByScope(
      dto,
      req.user.userId,
    );
  }

  /**
   * BE-04 (Wave wave-print-merge-scale-statuschange, 2026-06-04) —
   * scope-driven promote-Verified for EquipmentProjectGroup (ผ.03, page 1).
   *
   * Promotes EVERY EPG whose latest status is `Verified` under the supplied
   * `developmentPlanId` (§10 main-plan scope) to `Pending_Approval` in ONE
   * transaction and returns `{ movedCount }`. Replaces the FE per-id
   * `Promise.allSettled` storm — SET operation, no row cap, no id list.
   *
   * Staff-only (§3 / §4.1 — NOT agency-gated per §5.3); amphoe-based area
   * responsibility for `staff` (admin / super-admin bypass); §12 audit per
   * row; §14.4 forward transition (no lineage descendant guard); §17.4
   * baseline NOT fired (Verified → Pending_Approval is not authoring); §18
   * cascade NOT triggered.
   */
  @Post('promote-verified/equipment-project-group')
  promoteVerifiedEquipmentProjectGroup(
    @Body() dto: PromoteVerifiedEquipmentScopeDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(
      `Request to promote Verified→Pending_Approval EPGs (plan=${dto.developmentPlanId})`,
    );
    return this.trackingStatusService.promoteVerifiedEquipmentByScope(
      dto,
      req.user.userId,
    );
  }

  /**
   * BE-04 (Wave wave-print-merge-scale-statuschange, 2026-06-04) —
   * scope-driven promote-Verified for RevisedEquipmentProjectGroup
   * (ผ.03 revision/change, pages 3/4).
   *
   * Promotes EVERY RELPG whose latest status is `Verified` under the
   * supplied `developmentPlanRevisionId` (§10 DPR scope) to
   * `Pending_Approval` in ONE transaction and returns `{ movedCount }`.
   * Replaces the FE per-id `Promise.allSettled` storm + the `@Max(200)`
   * paginate-all loop on pages 1/3/4 — SET operation, no row cap, no id
   * list.
   *
   * Staff-only (§3 / §4.1 — NOT agency-gated per §5.3); agency-based area
   * responsibility for `staff` (admin / super-admin bypass); §12 audit per
   * row; §14.4 forward transition (no lineage descendant guard); §17.4
   * baseline NOT fired; §18 cascade NOT triggered.
   */
  @Post('promote-verified/revised-equipment-project-group')
  promoteVerifiedRevisedEquipmentProjectGroup(
    @Body() dto: PromoteVerifiedRevisedEquipmentScopeDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(
      `Request to promote Verified→Pending_Approval RELPGs (revision=${dto.developmentPlanRevisionId})`,
    );
    return this.trackingStatusService.promoteVerifiedRelpgByScope(
      dto,
      req.user.userId,
    );
  }

  /**
   * scope-driven APPROVE for RevisedEquipmentProjectGroup — moves EVERY
   * `Pending_Approval` RELPG under the supplied `developmentPlanRevisionId`
   * to `Approved` in ONE transaction (the equipment half of the
   * "อนุมัติทั้งหมด" action on the ready-to-approved pages). Sibling of
   * promote-verified; same scope-key-only contract (§12.1), no id list.
   */
  @Post('approve-pending-approval/revised-equipment-project-group')
  approvePendingApprovalRevisedEquipmentProjectGroup(
    @Body() dto: PromoteVerifiedRevisedEquipmentScopeDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(
      `Request to approve Pending_Approval→Approved RELPGs (revision=${dto.developmentPlanRevisionId})`,
    );
    return this.trackingStatusService.approvePendingApprovalRelpgByScope(
      dto,
      req.user.userId,
    );
  }

  /**
   * Wave wave-supplement-equipment-por03 (2026-06-10) — scope-driven APPROVE
   * for SupplementEquipmentProjectGroup (SEPG, ครุภัณฑ์ ผ.03 ของเล่มเพิ่มเติม).
   * The equipment half of the supplement "อนุมัติทั้งหมด" Stage-3 action —
   * the APPROVE sibling of the SEPG promote-verified endpoint above, and the
   * SEPG analog of the RELPG approve-by-scope.
   *
   * Moves EVERY SEPG whose latest status is `Pending_Approval` under the
   * supplied `developmentPlanSupplementId` (§12.1 supplement-book scope key)
   * to `Approved` in ONE transaction and returns `{ movedCount }`. SET
   * operation — no row cap, no id list, no page / limit.
   *
   * Staff-only (§3 / §4.1 — NOT agency-gated per §5.3, the agency-only rule
   * is authoring-scoped); AGENCY-based area responsibility for `staff`
   * (admin / super-admin bypass); §12 audit per row; §15.4 supplement book
   * lock honored before any move; §17.4 baseline NOT fired (Pending_Approval
   * → Approved is not authoring); §18 cascade NOT triggered.
   */
  @Post('approve-pending-approval/supplement-equipment-project-group')
  approvePendingApprovalSupplementEquipmentProjectGroup(
    @Body() dto: PromoteVerifiedSupplementEquipmentScopeDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(
      `Request to approve Pending_Approval→Approved SEPGs (supplement=${dto.developmentPlanSupplementId})`,
    );
    return this.trackingStatusService.approvePendingApprovalSupplementEquipmentByScope(
      dto,
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

  /**
   * Wave wave-supplement-equipment-por03 — BE-B2 (2026-06-08). Staff-led
   * rollback for SupplementEquipmentProjectGroup. Mirrors the SPG
   * rollback endpoint; AGENCY-based responsibility is enforced inside the
   * service. The `clearResponsibleAgency` flag is silently ignored
   * (SEPG is agency-only by construction; §7.2/§7.3 LAO-origin clearing
   * is unreachable).
   */
  @Post(
    'rollback/supplement-equipment-project-group/:supplementEquipmentProjectGroupId',
  )
  rollbackStatusSupplementEquipmentProjectGroup(
    @Param('supplementEquipmentProjectGroupId', ParseUUIDPipe)
    supplementEquipmentProjectGroupId: string,
    @Body() body: { clearResponsibleAgency?: boolean },
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(
      `Request to pull back supplement equipment project group: ${supplementEquipmentProjectGroupId}`,
    );
    return this.trackingStatusService.rollbackSupplementEquipmentProjectGroupStatus(
      supplementEquipmentProjectGroupId,
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
