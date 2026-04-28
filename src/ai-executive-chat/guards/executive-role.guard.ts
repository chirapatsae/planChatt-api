import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

/**
 * ExecutiveRoleGuard — Wave 44 Executive AI Chat access gate.
 *
 * CLAUDE.md references:
 *   - §4.1 Ownership vs Workflow Authority — this guard is a workflow-
 *     authority check (role + workStatus), NOT ownership. Per-conversation
 *     ownership is enforced separately in the service layer (BE-W44-02).
 *   - §2 Work Status Rule — caller MUST have `workStatus.name = 'approved'`
 *     on their current WorkHistory.
 *   - §17.2 Advisory-only — this guard gates ACCESS to the AI chat
 *     endpoint. It does NOT gate any workflow transition.
 *   - §17.11 No role exemption — "no role exemption" applies to quota /
 *     cooldown / staleness policy. Role-based endpoint admission is a
 *     SEPARATE permission check and is unchanged by §17.11.
 *
 * Allowed roles (case-insensitive match on `role.name`):
 *   - `staff`
 *   - `admin`
 *   - `super-admin`
 *   - `c-level`
 *
 * Wave 44 QA verdict (H1) fixed the role whitelist: the canonical
 * executive role in this codebase is `c-level` (see
 * `update-work-history.dto.ts:17 — CLEVEL = 'c-level'`). The FE
 * sidebar menu exposes this entry to `['staff','admin','super-admin',
 * 'c-level']` (see `menuConfig.tsx`), and the BE guard MUST match
 * verbatim or staff-lead users will 403 on a menu item they can see.
 * The literal string `'executive'` is NOT a canonical role value and
 * has been removed.
 *
 * Error contract:
 *   - 401 UNAUTHENTICATED  — no `req.user` (JwtAuthGuard should have run first)
 *   - 403 EXECUTIVE_ROLE_REQUIRED — any other role, missing WorkHistory,
 *     or non-approved workStatus
 *
 * MUST run AFTER `JwtAuthGuard` so `req.user.userId` is populated.
 *
 * Backend enforcement only — CLAUDE.md global rule "NEVER trust UI
 * visibility as access control."
 */
@Injectable()
export class ExecutiveRoleGuard implements CanActivate {
  private static readonly ALLOWED_ROLES = new Set([
    'staff',
    'admin',
    'super-admin',
    'c-level',
  ]);

  constructor(
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<{ user?: { userId?: string } }>();

    const userId = req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('UNAUTHENTICATED');
    }

    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: ['workStatus', 'role'],
    });

    if (!workHistory) {
      throw new ForbiddenException('EXECUTIVE_ROLE_REQUIRED');
    }

    const roleName = workHistory.role?.name?.toLowerCase() ?? '';
    const workStatusName =
      workHistory.workStatus?.name?.toLowerCase() ?? '';

    if (!ExecutiveRoleGuard.ALLOWED_ROLES.has(roleName)) {
      throw new ForbiddenException('EXECUTIVE_ROLE_REQUIRED');
    }

    if (workStatusName !== 'approved') {
      throw new ForbiddenException('EXECUTIVE_ROLE_REQUIRED');
    }

    return true;
  }
}
