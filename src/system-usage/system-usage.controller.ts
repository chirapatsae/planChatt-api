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
 * Auth & role gate:
 *   - JwtAuthGuard (Bearer + Secret-Key headers per codebase convention)
 *   - In-controller role gate `assertExecRead` mirrors the W98 pattern
 *     (notifications/admin/notification-alerts.controller.ts). When the
 *     `c-level` role is operationally absent the constant set still
 *     accepts it and the gate degrades gracefully — a non-existent role
 *     value can never appear on `req.user.role`, so the check is a no-op
 *     for unknown roles.
 *   - `inactive-users` and `top-users.csv` are super-admin only (more
 *     sensitive PDPA surface).
 *
 * Access logging:
 *   - Every handler annotated with `@AccessLogged()` produces exactly
 *     one row in `stats_access_log` on a 2xx response.
 *   - Failed (4xx/5xx) responses produce zero rows.
 */

import {
  Controller,
  ForbiddenException,
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

// W107 role gate — mirrors W98 EXEC_READ_ROLES. `c-level` is included by
// design; if the role does not exist in the deployment, no `req.user.role`
// will ever match it and the gate effectively becomes admin + super-admin.
const STATS_READ_ROLES: ReadonlySet<string> = new Set([
  'admin',
  'super-admin',
  'c-level',
]);

const SUPER_ADMIN_ONLY: ReadonlySet<string> = new Set(['super-admin']);

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
  @Get('overview')
  @HttpCode(HttpStatus.OK)
  @AccessLogged()
  async getOverview(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query() q: OverviewQueryDto,
  ) {
    this.assertReadAccess(req.user);
    return this.query.getOverview(q);
  }

  // ---------------------------------------------------------------------------
  // A2. /adoption-funnel — answers the budget-justification question
  //                       (W107 reframe: page is about user-access, not workflow).
  // ---------------------------------------------------------------------------
  @Get('adoption-funnel')
  @HttpCode(HttpStatus.OK)
  @AccessLogged()
  async getAdoptionFunnel(
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.assertReadAccess(req.user);
    return this.query.getAdoptionFunnel();
  }

  // ---------------------------------------------------------------------------
  // B. /timeseries
  // ---------------------------------------------------------------------------
  @Get('timeseries')
  @HttpCode(HttpStatus.OK)
  @AccessLogged()
  async getTimeseries(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query() q: TimeseriesQueryDto,
  ) {
    this.assertReadAccess(req.user);
    return this.query.getTimeseries(q);
  }

  // ---------------------------------------------------------------------------
  // C. /top-users
  // ---------------------------------------------------------------------------
  @Get('top-users')
  @HttpCode(HttpStatus.OK)
  @AccessLogged()
  async getTopUsers(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query() q: TopUsersQueryDto,
  ) {
    this.assertReadAccess(req.user);
    return this.query.getTopUsers(q);
  }

  // ---------------------------------------------------------------------------
  // C-csv. /top-users/csv  (super-admin only)
  // ---------------------------------------------------------------------------
  @Get('top-users/csv')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @AccessLogged()
  async getTopUsersCsv(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query() q: TopUsersQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.assertSuperAdmin(req.user);
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
  @Get('heatmap')
  @HttpCode(HttpStatus.OK)
  @AccessLogged()
  async getHeatmap(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query() q: HeatmapQueryDto,
  ) {
    this.assertReadAccess(req.user);
    return this.query.getHeatmap(q);
  }

  // ---------------------------------------------------------------------------
  // E. /role-distribution
  // ---------------------------------------------------------------------------
  @Get('role-distribution')
  @HttpCode(HttpStatus.OK)
  @AccessLogged()
  async getRoleDistribution(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query() q: RoleDistributionQueryDto,
  ) {
    this.assertReadAccess(req.user);
    return this.query.getRoleDistribution(q);
  }

  // ---------------------------------------------------------------------------
  // F. /inactive-users  (super-admin only)
  // ---------------------------------------------------------------------------
  @Get('inactive-users')
  @HttpCode(HttpStatus.OK)
  @AccessLogged()
  async getInactiveUsers(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query() q: InactiveUsersQueryDto,
  ) {
    this.assertSuperAdmin(req.user);
    return this.query.getInactiveUsers(q);
  }

  // ---------------------------------------------------------------------------
  // Guards
  // ---------------------------------------------------------------------------

  private assertReadAccess(user: JwtPayloadUser): void {
    if (!user || !STATS_READ_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'การเข้าถึงสถิติการใช้งานระบบสงวนสำหรับ admin / super-admin / c-level',
      );
    }
  }

  private assertSuperAdmin(user: JwtPayloadUser): void {
    if (!user || !SUPER_ADMIN_ONLY.has(user.role)) {
      throw new ForbiddenException(
        'การเข้าถึงนี้สงวนสำหรับ super-admin เท่านั้น',
      );
    }
  }
}
