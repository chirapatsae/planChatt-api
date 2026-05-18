import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';

import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';

import { ReplaceMappingDto } from './dto/replace-mapping.dto';
import { StrategicMappingService } from './strategic-mapping.service';

/**
 * Routes (user-locked 2026-05-18 — `/v1/strategic-graph/...` namespace):
 *   POST /v1/strategic-graph/mapping/:type        — inter-master replace
 *     (admin + super-admin).
 *   GET  /v1/strategic-graph/mapping/:type        — inter-master single-source
 *     read (?sourceId=…; any authenticated user).
 *   GET  /v1/strategic-graph/mapping/:type/all    — full matrix snapshot
 *     (any authenticated user).
 *
 * Valid inter-master `:type` (chain order NS→MS→SDG↔PS):
 *   - national-strategy-milestone
 *   - milestone-sdg
 *   - province-strategy-sdg
 *
 * CLEANUP 2026-05-18: removed BE-05 / BE-06 plan-mapping endpoints
 * (POST /plans/:id/mappings, GET /plans/:id/mappings, GET /plans) and
 * the four `plan_*` junction tables — all 0 rows, no UI consumer.
 *
 * Authority is enforced inside the service via `assertAdminOrSuperAdmin`
 * (mirrors `SdgController` / `SdgService`). The controller only gates
 * for authenticated user via `JwtAuthGuard`.
 *
 * §12 — these are config rows; no TrackingStatus interaction.
 * §17.2 — no AI gating; no FormatBadge side-effects.
 */
@Controller({
  path: 'strategic-graph',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class StrategicMappingController {
  private readonly logger = new Logger(StrategicMappingController.name);

  constructor(private readonly service: StrategicMappingService) {}

  // BE-04 — inter-master replace
  @Post('mapping/:type')
  replace(
    @Param('type') type: string,
    @Body() dto: ReplaceMappingDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.replaceMapping(
      type,
      dto.sourceId,
      dto.targetIds,
      req.user.userId,
    );
  }

  // BE-04 — inter-master read
  @Get('mapping/:type')
  get(@Param('type') type: string, @Query('sourceId') sourceId: string) {
    return this.service.getMapping(type, sourceId);
  }

  // BE-MATRIX-01 — full inter-master snapshot (matrix view)
  //   GET /v1/strategic-graph/mapping/:type/all
  // Any authenticated user; invalid :type → 400 via service.resolveConfig.
  @Get('mapping/:type/all')
  getAll(@Param('type') type: string) {
    return this.service.getAllMappings(type);
  }
}
