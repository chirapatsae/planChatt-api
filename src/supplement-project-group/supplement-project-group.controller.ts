import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Req,
  Logger,
  Query,
} from '@nestjs/common';
import { SupplementProjectGroupService } from './supplement-project-group.service';
import { CreateSupplementProjectGroupDto } from './dto/create-supplement-project-group.dto';
import { UpdateSupplementProjectGroupDto } from './dto/update-supplement-project-group.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { Request } from 'express';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';

@Controller({ path: 'supplement-project-group', version: '1' })
@UseGuards(JwtAuthGuard)
export class SupplementProjectGroupController {
  private readonly logger = new Logger(SupplementProjectGroupController.name);

  constructor(
    private readonly supplementProjectGroupService: SupplementProjectGroupService,
  ) {}

  /**
   * Create handler (`[create] → Pending`). SUPP-1 BE-01 — full workflow
   * guards apply (Q1+Q2 agency gate, scope, §16.5 shape, §17.4
   * baseline). SPG has no draft state (SUPP-1 followup 2026-05-12);
   * the first audit row is written as `Pending` in the same transaction.
   */
  @Post()
  async create(
    @Body() createDto: CreateSupplementProjectGroupDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Creating supplement project group by user ${userId}`);
    return this.supplementProjectGroupService.create(createDto, userId);
  }

  // SUPP-1 followup (2026-05-12): SPG has no draft state. The earlier
  // POST /draft, PATCH /:id/publish, PATCH /:id/draft handlers have
  // been removed; create goes directly to `Pending` via POST /.

  @Get()
  async findAll(@Query('supplementId') supplementId?: string) {
    if (supplementId) {
      return this.supplementProjectGroupService.findBySupplement(supplementId);
    }
    this.logger.log('Fetching all supplement project groups');
    return this.supplementProjectGroupService.findAll();
  }

  /**
   * SUPP-1 BE-03 — Owner "my SPGs" endpoint.
   *
   * Returns SPGs owned by the calling user's current WorkHistory.
   * Gated by `SupplementScopeService.assertSupplementOwnerScope`
   * (Q1 + Q2). LAO callers receive 403
   * `LAO_NOT_ALLOWED_ON_SUPPLEMENT` — by design, LAO has no SPGs to
   * list.
   *
   * Optional filters: `?statusId=<uuid>` OR `?statusName=<name>`.
   *
   * MUST be declared above `GET /:id` to win route resolution.
   */
  @Get('me')
  async findMine(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('statusId') statusId?: string,
    @Query('statusName') statusName?: string,
  ) {
    const userId = req.user?.userId;
    this.logger.log(
      `Fetching own supplement project groups user=${userId} statusId=${statusId ?? '-'} statusName=${statusName ?? '-'}`,
    );
    return this.supplementProjectGroupService.findMine(userId, {
      statusId,
      statusName,
    });
  }

  /**
   * SUPP-1 BE-03 — Staff review queue endpoint.
   *
   * Returns SPGs in {`Pending`, `Verified`, `Pending_Approval`} filtered
   * by `WorkHistoryGovernmentAgencyResponsibility` (Q3 — AGENCY-BASED,
   * RPG pattern). `admin` / `super-admin` / `c-level` bypass the
   * responsibility filter; plain `user` role is rejected with 403.
   *
   * MUST be declared above `GET /:id` to win route resolution.
   */
  @Get('pending-review')
  async findPendingReview(
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(
      `Fetching supplement project groups pending review user=${userId}`,
    );
    return this.supplementProjectGroupService.findPendingReview(userId);
  }

  @Get(':id')
  async findOne(
    @Param('id') id: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Fetching supplement project group with id: ${id}`);
    return this.supplementProjectGroupService.findOne(id, userId);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() updateDto: UpdateSupplementProjectGroupDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Updating supplement project group with id: ${id}`);
    return this.supplementProjectGroupService.update(id, updateDto, userId);
  }

  /**
   * SUPP-1 BE-01 — Soft-remove an SPG (audit-preserving). The hard
   * `repo.delete` path is gone; existing callers receive a soft-delete
   * with the same response shape so the AdditionalBook admin UI
   * continues to work without change.
   */
  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Removing supplement project group with id: ${id}`);
    return this.supplementProjectGroupService.remove(id, userId);
  }
}
