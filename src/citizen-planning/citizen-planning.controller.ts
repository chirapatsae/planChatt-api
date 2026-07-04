import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';

import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { WorkStatusApprovedGuard } from '../auth/work-status-approved.guard';
import { Roles } from '../auth/roles.decorator';
import { EXEC_READ } from '../auth/role-groups';
import type { JwtPayloadUser } from '../auth/jwt.strategy';

import { CitizenPlanningService } from './citizen-planning.service';
import { CitizenIdeaScoreService } from './citizen-idea-score.service';
import { UpsertPlanningDto } from './dto/upsert-planning.dto';

/**
 * Executive PRIVATE planning surface over the citizen idea stream — the
 * list-tab actions (สถานะพิจารณา / ปักธง / โน้ต) on
 * `/executive/citizen-idea-board`.
 *
 * Guard chain mirrors the canonical executive read surfaces
 * (`CitizenInsightsController`, `AiExecutiveChatController`):
 *
 *   JwtAuthGuard → RolesGuard → WorkStatusApprovedGuard   (+ @Roles(...EXEC_READ))
 *
 * `EXEC_READ` = staff + admin + super-admin + c-level. A citizen token
 * (aud:'citizen') is rejected by `JwtAuthGuard`, so a citizen can never reach
 * these endpoints.
 *
 * §17.2 advisory — nothing here gates a workflow transition or writes
 * `tracking_status`. §17.3 isolation — `citizen_planning_*` only; no project /
 * users / tracking_status touch; actor + idea referenced by UUID (no FK).
 * All access is scoped to the caller's own current WorkHistory (§4 ownership).
 */
@Controller({ path: 'citizen-planning', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)
@Roles(...EXEC_READ)
export class CitizenPlanningController {
  constructor(
    private readonly planning: CitizenPlanningService,
    private readonly scores: CitizenIdeaScoreService,
  ) {}

  private userId(req: Request & { user?: JwtPayloadUser }): string {
    const id = req.user?.userId;
    if (!id) throw new UnauthorizedException('UNAUTHENTICATED');
    return id;
  }

  /** GET /v1/citizen-planning/mine — the caller's whole planning set. */
  @Get('mine')
  listMine(@Req() req: Request & { user?: JwtPayloadUser }) {
    return this.planning.listMine(this.userId(req));
  }

  /**
   * GET /v1/citizen-planning/score-history/:ideaId — B2 trend for the detail
   * sparkline. GLOBAL (not owner-scoped): the score of an idea is the same for
   * every executive. Advisory (§17.2) — pure read, gates nothing.
   */
  @Get('score-history/:ideaId')
  scoreHistory(@Param('ideaId', new ParseUUIDPipe()) ideaId: string) {
    return this.scores.getHistory(ideaId);
  }

  /** PUT /v1/citizen-planning/:ideaId — upsert triage / flag / note. */
  @Put(':ideaId')
  upsert(
    @Req() req: Request & { user?: JwtPayloadUser },
    @Param('ideaId', new ParseUUIDPipe()) ideaId: string,
    @Body() dto: UpsertPlanningDto,
  ) {
    return this.planning.upsert(this.userId(req), ideaId, dto);
  }

  /** DELETE /v1/citizen-planning/:ideaId — clear all planning for one idea. */
  @Delete(':ideaId')
  clear(
    @Req() req: Request & { user?: JwtPayloadUser },
    @Param('ideaId', new ParseUUIDPipe()) ideaId: string,
  ) {
    return this.planning.clear(this.userId(req), ideaId);
  }
}
