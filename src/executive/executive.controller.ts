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
   * Team Dashboard scope dispatch.
   *
   * Accepts `?scope=main|revision-edit|revision-change|supplement`
   * (default `'main'`).
   *
   * wave-team-dashboard-equipment-folded (2026-06-18) — equipment (ครุภัณฑ์
   * ผ.03) is NOT a separate scope. It is PART of every book and is folded
   * into the matching scope's `responsibleAgency` bucket alongside the ผ.02
   * project rows (tagged with an `equipment-*` sourceType). The former
   * standalone `scope=equipment` value has been REMOVED.
   *
   * Contract:
   *   - `scope=main` → PG + EPG; payload keeps the legacy shape (no top-level
   *     `scope` key) so existing FE consumers are unchanged. PG-only numbers
   *     are byte-identical to the pre-fold output.
   *   - `scope=revision-edit|revision-change|supplement` → ผ.02 + matching
   *     equipment, with `scope` echoed at top-level.
   *
   * Invalid scope values (including the now-removed `equipment`) →
   * 400 BAD_SCOPE (§17.2 advisory, no workflow gating).
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
