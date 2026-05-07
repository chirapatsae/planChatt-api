import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkHistory } from '../work-history/entities/work-history.entity';

/**
 * WorkStatusApprovedGuard — enforces CLAUDE.md §2 Work Status Rule on
 * endpoints that need a live DB check.
 *
 * Per §2: a user may perform workflow actions ONLY when
 *   `workHistory.workStatus.name = 'approved'` (case-insensitive)
 * on the user's CURRENT (`isCurrent = true`) WorkHistory row.
 *
 * Composition contract:
 *   - MUST be combined with `JwtAuthGuard` (which populates `req.user.userId`).
 *   - Typically composed with `RolesGuard` for endpoints that need both
 *     role gate + workStatus gate, e.g.
 *       `@UseGuards(JwtAuthGuard, RolesGuard, WorkStatusApprovedGuard)`
 *     The order matters only insofar as `JwtAuthGuard` must run first;
 *     `RolesGuard` and this guard are independent and may run in either
 *     order, but the canonical convention is RolesGuard BEFORE this guard
 *     (cheap token-claim check before DB read).
 *
 * Module wiring:
 *   - The consuming controller's module MUST import
 *     `TypeOrmModule.forFeature([WorkHistory])` so the repository can be
 *     injected. See BE-01 report for the migration list (BE-02 / BE-03 /
 *     BE-04 will wire this where needed).
 *
 * Today's only consumer (pre-migration) is the bespoke `ExecutiveRoleGuard`
 * which performs both checks inline. Phase 3b decomposes that into
 * `RolesGuard` + this guard.
 *
 * Error contract:
 *   - 401 UNAUTHENTICATED — no `req.user.userId` (JwtAuthGuard misordering)
 *   - 403 WORK_STATUS_NOT_APPROVED — current WorkHistory missing or
 *     workStatus.name !== 'approved'
 */
@Injectable()
export class WorkStatusApprovedGuard implements CanActivate {
  constructor(
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ user?: { userId?: string } }>();

    const userId = request?.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('UNAUTHENTICATED');
    }

    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: ['workStatus'],
    });

    const workStatusName = workHistory?.workStatus?.name?.toLowerCase() ?? '';

    if (workStatusName !== 'approved') {
      throw new ForbiddenException('WORK_STATUS_NOT_APPROVED');
    }

    return true;
  }
}
