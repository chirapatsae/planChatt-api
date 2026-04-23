import { BadRequestException, Controller, Get, Post, Body, Patch, Param, Delete, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { ExecutiveService, TeamDashboardScope, TEAM_DASHBOARD_SCOPES } from './executive.service';
import { CreateExecutiveDto } from './dto/create-executive.dto';
import { UpdateExecutiveDto } from './dto/update-executive.dto';

@Controller({
  path: 'executive',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class ExecutiveController {
  constructor(private readonly executiveService: ExecutiveService) { }

  /**
   * Wave 43 — Team Dashboard scope extension.
   *
   * Accepts `?scope=all|main|revision|supplement` (default `'all'`).
   *
   * Backward-compatibility contract (see docs/tasks/TEAM_DASHBOARD_SCOPE_EXTEND_BACKEND.md):
   *   - `scope=main` → byte-identical legacy payload (no `scope`, no `byScope`,
   *     no `sourceType` fields injected).
   *   - Missing param → treated as `'all'` per task AC item 1; the response
   *     still contains the legacy top-level keys but also includes `scope`
   *     and `byScope` so FE can render the union view without branching.
   *   - `scope=revision|supplement|all` → union aggregation with per-source
   *     counters in `byScope`.
   *
   * Invalid scope values → 400 BAD_SCOPE (§17.2 advisory, no workflow gating).
   */
  @Get('team-dashboard')
  getTeamDashboard(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('scope') scope?: string,
  ) {
    const normalized = (scope ?? 'main') as TeamDashboardScope;
    if (!TEAM_DASHBOARD_SCOPES.includes(normalized)) {
      throw new BadRequestException('BAD_SCOPE');
    }
    return this.executiveService.getTeamDashboard(req.user.userId, normalized);
  }

  @Post()
  create(@Body() createExecutiveDto: CreateExecutiveDto) {
    return this.executiveService.create(createExecutiveDto);
  }

  @Get()
  findAll() {
    return this.executiveService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.executiveService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateExecutiveDto: UpdateExecutiveDto) {
    return this.executiveService.update(+id, updateExecutiveDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.executiveService.remove(+id);
  }
}
