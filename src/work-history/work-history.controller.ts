import {
  Controller,
  ForbiddenException,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseUUIDPipe,
  UseGuards,
  Request,
  Query,
  Req,
} from '@nestjs/common';
import { WorkHistoryService } from './work-history.service';
import { CreateWorkHistoryDto } from './dto/create-work-history.dto';
import { UpdateWorkHistoryDto } from './dto/update-work-history.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { Role } from 'src/auth/roles.enum';
import { Roles } from 'src/auth/roles.decorator';
import { RolesGuard } from 'src/auth/roles.guard';
import { ADMIN_OR_ABOVE } from 'src/auth/role-groups';

/**
 * SEC-01 P0 — admin / super-admin gate for WorkHistory mutation endpoints.
 *
 * WorkHistory carries `role` and `workStatus` — the two highest-trust
 * fields in the system — so any authenticated-only mutation is a
 * one-shot privilege-escalation primitive (see SEC-01 §6 abuse path).
 * `staff` is intentionally excluded: staff workflow authority per
 * CLAUDE.md §4.1 is project-scoped, not identity-scoped, and granting
 * WH-mutation to staff would let a single field officer elevate any
 * user (including themselves) to super-admin.
 *
 * BE-02 (auth-roles-guard-unification Phase 2 pilot): the prior inline
 * `assertAdmin` / `assertSuperAdmin` helpers and the local
 * `WH_ADMIN_ROLES` / `WH_SUPER_ADMIN_ROLES` constants have been replaced
 * by the canonical `@Roles(...)` + `RolesGuard` pattern from
 * `src/auth/`. The mode-branched DELETE keeps an inline super-admin
 * check (SEC-01 Required Fix #6 / §7.8 Option A) because the decorator
 * model cannot express two role floors on a single endpoint; that
 * check now compares against `Role.SUPER_ADMIN` enum (no string drift).
 */

@Controller({
  path: 'work-history',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class WorkHistoryController {
  constructor(private readonly workHistoryService: WorkHistoryService) {}

  @Get()
  findAll(@Query('status') status: string, @Query('role') role: string) {
    return this.workHistoryService.findAll(status, role);
  }

  @Get('/pending')
  findPendingWorkHistory() {
    return this.workHistoryService.findPendingWorkHistory();
  }

  // @Post('/notify-staff-pending')
  // notifyStaffPending(
  //   @Body('userId', ParseUUIDPipe) userId: string,
  // ) {
  //   return this.workHistoryService.notifyStaffPending(userId);
  // }

  @Get('/by-agency/:id')
  findAllByAgencyId(@Param('id') id: string, @Query('role') role: string) {
    return this.workHistoryService.findAllByGovernmentAgencyId(id, role);
  }
  @Get('/by-lao/:id')
  findAllByLaoId(@Param('id') id: string, @Query('role') role: string) {
    return this.workHistoryService.findAllByLocalAdministrativeOrganizationId(
      id,
      role,
    );
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.workHistoryService.findOne(id);
  }

  /**
   * SEC-01 P0 (S2) — admin / super-admin only.
   *
   * Signup-flow investigation: AuthService.handleOAuthLogin
   * (`backend/src/auth/auth.service.ts`) is the only first-WorkHistory
   * creation path on login and it does NOT call this endpoint — it only
   * creates the User row and lets WorkHistory be assigned later by an
   * admin. Therefore gating POST /work-history behind admin / super-admin
   * does NOT break the signup flow. If a future signup feature ever needs
   * to seed WorkHistory server-side, it MUST hard-code role='user' +
   * workStatus='pending' inside a dedicated unauthenticated route per
   * SEC-01 §3 S2 — NEVER reuse this endpoint.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN_OR_ABOVE)
  @Post()
  create(
    @Body() dto: CreateWorkHistoryDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.workHistoryService.create(dto, req.user.userId);
  }

  /**
   * SEC-01 P0 (S1) — admin / super-admin only. Without this gate any
   * authenticated user could PATCH their own WorkHistory to
   * role=super-admin + workStatus=approved and become super-admin on
   * next login (token re-issue at OAuth login time).
   *
   * BE-01 P0-1 — the underlying service call no longer mutates in place;
   * it appends a new row inside a transaction.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN_OR_ABOVE)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkHistoryDto,
    @Request() req: Request & { user: JwtPayloadUser },
  ) {
    return this.workHistoryService.update(id, dto, req.user.userId);
  }

  /**
   * SEC-01 P0 (S3) — admin / super-admin for soft delete; super-admin
   * only for hard delete. Hard delete is gated tighter because it
   * physically removes the snapshot row that other tables (project_groups
   * .created_by, etc.) FK against — admin discipline must accompany the
   * action.
   *
   * Mode-branched DELETE: per SEC-01 Required Fix #6 / task §7.8 Option A
   * the canonical `@Roles(...ADMIN_OR_ABOVE)` decorator covers the
   * baseline (soft-delete) floor, and the `mode === 'hard'` branch keeps
   * an inline super-admin check using `Role.SUPER_ADMIN` enum (no string
   * literal — eliminates drift).
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN_OR_ABOVE)
  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Query('mode') mode: 'soft' | 'hard' = 'soft',
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    if (mode === 'hard') {
      const callerRole = req?.user?.role;
      if (callerRole !== Role.SUPER_ADMIN) {
        throw new ForbiddenException('FORBIDDEN_ROLE');
      }
      return this.workHistoryService.remove(id);
    }
    return this.workHistoryService.softRemove(id);
  }

  /**
   * SEC-01 P0 (S4a) — admin / super-admin only. Pairs with BE-01 P0-3
   * (S4b fix) which prevents restore from creating a second isCurrent
   * row.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN_OR_ABOVE)
  @Patch(':id/restore')
  restore(@Param('id') id: string) {
    return this.workHistoryService.restore(id);
  }
}
