import { Controller, Get, Logger, Query, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from 'src/auth/auth.guard';

import { ProjectAlignmentMappingService } from './project-alignment-mapping.service';

/**
 * Routes (mounted at `/v1/strategic-graph/alignment`):
 *   GET /v1/strategic-graph/alignment?strategyId=…&tacticId=…&planId=…
 *     → returns the unique alignment row for the triple OR 404
 *
 * Auth: any authenticated user (JwtAuthGuard).
 *
 * §12 — config row; no TrackingStatus interaction.
 * §17.2 — no AI gating.
 */
@Controller({
  path: 'strategic-graph/alignment',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class ProjectAlignmentMappingController {
  private readonly logger = new Logger(
    ProjectAlignmentMappingController.name,
  );

  constructor(
    private readonly service: ProjectAlignmentMappingService,
  ) {}

  @Get()
  lookup(
    @Query('strategyId') strategyId: string,
    @Query('tacticId') tacticId: string,
    @Query('planId') planId: string,
  ) {
    return this.service.lookup(strategyId, tacticId, planId);
  }
}
