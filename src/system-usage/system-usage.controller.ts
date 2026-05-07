/**
 * W107-BE-PR2 — SystemUsageController
 *
 * Read-only REST surface for the System Usage Statistics page.
 *
 * Source-of-truth:
 *   - docs/tasks/wave107/W107-BE-PR2-STATS-API.md §7
 *   - docs/tasks/wave107/W107-PLAN-SYSTEM-USAGE-STATS.md §8 (chart inventory)
 *   - CLAUDE.md §4.1 (no workflow authority granted),
 *                §17.2 (advisory),
 *                §17.3 (no audit-table writes; access log is OWN table),
 *                §17.11 (no role exemption)
 *
 * Auth & role gate (BE-03 — auth-roles-guard-unification Phase 3):
 *   - JwtAuthGuard (Bearer + Secret-Key headers per codebase convention)
 *   - Canonical `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(...)` per
 *     endpoint. Replaces the pre-BE-03 inline `assertReadAccess` /
 *     `assertSuperAdmin` helpers and the local `STATS_READ_ROLES` /
 *     `SUPER_ADMIN_ONLY` constants.
 *   - Read endpoints use `STATS_READ` (admin / super-admin / c-level).
 *     Per SEC-01 Required Fix #5, this MUST NOT be widened to
 *     `EXEC_READ` (which would add `staff`); the legacy
 *     `STATS_READ_ROLES` constant deliberately excluded `staff`, so the
 *     migration preserves that exclusion byte-for-byte.
 *   - `inactive-users` and `top-users.csv` use `SUPER_ADMIN_ONLY` (more
 *     sensitive PDPA surface).
 *
 * Access logging:
 *   - Every handler annotated with `@AccessLogged()` produces exactly
 *     one row in `stats_access_log` on a 2xx response.
 *   - Failed (4xx/5xx) responses produce zero rows.
 */

import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Header,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { Request, Response } from 'express';

import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { Roles } from 'src/auth/roles.decorator';
import { RolesGuard } from 'src/auth/roles.guard';
import { STATS_READ, SUPER_ADMIN_ONLY } from 'src/auth/role-groups';

import {
  HeatmapQueryDto,
  InactiveUsersQueryDto,
  OverviewQueryDto,
  RoleDistributionQueryDto,
  TimeseriesQueryDto,
  TopUsersQueryDto,
} from './dto/system-usage-query.dto';
import { SystemUsageQueryService } from './services/system-usage-query.service';
import { AccessLogged } from './decorators/access-logged.decorator';
import { AccessLogInterceptor } from './interceptors/access-log.interceptor';

@Controller({ path: 'system-usage', version: '1' })
@UseGuards(JwtAuthGuard)
@UseInterceptors(AccessLogInterceptor)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  }),
)
export class SystemUsageController {
  constructor(private readonly query: SystemUsageQueryService) {}

  // ---------------------------------------------------------------------------
  // A. /overview
  // ---------------------------------------------------------------------------
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...STATS_READ)
  @Get('overview')
  @HttpCode(HttpStatus.OK)
  @AccessLogged()
  async getOverview(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query() q: OverviewQueryDto,
  ) {
    return this.query.getOverview(q);
  }

  // ---------------------------------------------------------------------------
  // A2. /adoption-funnel — answers the budget-justification question
  //                       (W107 reframe: page is about user-access, not workflow).
  // ---------------------------------------------------------------------------
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...STATS_READ)
  @Get('adoption-funnel')
  @HttpCode(HttpStatus.OK)
  @AccessLogged()
  async getAdoptionFunnel() {
    return this.query.getAdoptionFunnel();
  }

  // ---------------------------------------------------------------------------
  // B. /timeseries
  // ---------------------------------------------------------------------------
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...STATS_READ)
  @Get('timeseries')
  @HttpCode(HttpStatus.OK)
  @AccessLogged()
  async getTimeseries(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query() q: TimeseriesQueryDto,
  ) {
    return this.query.getTimeseries(q);
  }

  // ---------------------------------------------------------------------------
  // C. /top-users
  // ---------------------------------------------------------------------------
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...STATS_READ)
  @Get('top-users')
  @HttpCode(HttpStatus.OK)
  @AccessLogged()
  async getTopUsers(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query() q: TopUsersQueryDto,
  ) {
    return this.query.getTopUsers(q);
  }

  // ---------------------------------------------------------------------------
  // C-csv. /top-users/csv  (super-admin only)
  // ---------------------------------------------------------------------------
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  @Get('top-users/csv')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @AccessLogged()
  async getTopUsersCsv(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query() q: TopUsersQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const payload = await this.query.getTopUsers(q);
    const csv = this.query.buildTopUsersCsv(payload);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="system-usage-top-users-${stamp}.csv"`,
    );
    return csv;
  }

  // ---------------------------------------------------------------------------
  // D. /heatmap
  // ---------------------------------------------------------------------------
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...STATS_READ)
  @Get('heatmap')
  @HttpCode(HttpStatus.OK)
  @AccessLogged()
  async getHeatmap(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query() q: HeatmapQueryDto,
  ) {
    return this.query.getHeatmap(q);
  }

  // ---------------------------------------------------------------------------
  // E. /role-distribution
  // ---------------------------------------------------------------------------
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...STATS_READ)
  @Get('role-distribution')
  @HttpCode(HttpStatus.OK)
  @AccessLogged()
  async getRoleDistribution(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query() q: RoleDistributionQueryDto,
  ) {
    return this.query.getRoleDistribution(q);
  }

  // ---------------------------------------------------------------------------
  // F. /inactive-users  (super-admin only)
  // ---------------------------------------------------------------------------
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...SUPER_ADMIN_ONLY)
  @Get('inactive-users')
  @HttpCode(HttpStatus.OK)
  @AccessLogged()
  async getInactiveUsers(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query() q: InactiveUsersQueryDto,
  ) {
    return this.query.getInactiveUsers(q);
  }
}
