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
import { ReplacePlanMappingsDto } from './dto/replace-plan-mappings.dto';
import { StrategicMappingService } from './strategic-mapping.service';

/**
 * Routes (user-locked 2026-05-18 — `/v1/strategic-graph/...` namespace):
 *   POST /v1/strategic-graph/mapping/:type  — BE-04 inter-master replace
 *     (admin + super-admin).
 *   GET  /v1/strategic-graph/mapping/:type?sourceId=  — BE-04 inter-master
 *     read (any authenticated user).
 *   POST /v1/strategic-graph/plans/:id/mappings  — BE-05 composite plan
 *     mapping replace across 4 dimensions (admin + super-admin).
 *   GET  /v1/strategic-graph/plans/:id/mappings  — BE-05 composite plan
 *     mapping read (any authenticated user).
 *
 * Valid inter-master `:type`:
 *   - sdg-national-strategy
 *   - milestone-sdg
 *   - province-strategy-sdg
 *   - province-strategy-national-strategy
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

  // BE-05 — composite plan-mapping replace
  @Post('plans/:id/mappings')
  replacePlanMappings(
    @Param('id') planId: string,
    @Body() dto: ReplacePlanMappingsDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.replacePlanMappings(planId, dto, req.user.userId);
  }

  // BE-05 — composite plan-mapping read
  @Get('plans/:id/mappings')
  getPlanMappings(@Param('id') planId: string) {
    return this.service.getPlanMappings(planId);
  }

  // BE-06 — multi-dimension plan filter
  //   GET /v1/strategic-graph/plans
  //     ?sdgIds=uuid1,uuid2
  //     &nationalStrategyIds=uuid3
  //     &milestoneIds=uuid4,uuid5
  //     &provinceStrategyIds=uuid6
  // AND across dimensions; IN within (comma-separated). Empty / absent
  // params skip that dimension. Any authenticated user.
  @Get('plans')
  filterPlans(
    @Query('sdgIds') sdgIds?: string,
    @Query('nationalStrategyIds') nationalStrategyIds?: string,
    @Query('milestoneIds') milestoneIds?: string,
    @Query('provinceStrategyIds') provinceStrategyIds?: string,
  ) {
    const parse = (csv?: string): string[] =>
      csv
        ? csv
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    return this.service.filterPlans({
      sdgIds: parse(sdgIds),
      nationalStrategyIds: parse(nationalStrategyIds),
      milestoneIds: parse(milestoneIds),
      provinceStrategyIds: parse(provinceStrategyIds),
    });
  }
}
