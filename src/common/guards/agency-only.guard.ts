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
import { isAgencyWorkHistory } from 'src/project-groups/util/agency-data.util';

/**
 * AgencyOnlyGuard — CLAUDE.md §1 classification gate (agency-only writes).
 *
 * Layer-1 (controller) guard for endpoints that MUST be restricted to
 * `agency`-classified callers. Currently consumed by the Wave Equipment
 * ผ.03 Phase 2 BE-04 surface — every write endpoint on
 * `/v1/equipment-project-group` mounts this guard. The service layer
 * re-asserts the same predicate (`isAgencyWorkHistory`) as Layer-2
 * defense-in-depth, mirroring the dual guard+service §1 check in
 * `RevisedProjectGroupsService.create` (revised-project-group.service.ts
 * lines 2233-2239).
 *
 * Composition contract:
 *   - MUST be combined with `JwtAuthGuard` so `req.user.userId` is set.
 *   - Order: `@UseGuards(JwtAuthGuard, AgencyOnlyGuard)` — JwtAuthGuard
 *     must run first.
 *
 * Error contract:
 *   - 401 UNAUTHENTICATED — no `req.user.userId` (guard ordering bug).
 *   - 403 EQUIPMENT_AGENCY_ONLY — current WorkHistory missing OR caller
 *     is classified as `lao` per §1.
 *
 * Read-only endpoints MUST NOT mount this guard — LAO users retain READ
 * access to equipment items.
 */
@Injectable()
export class AgencyOnlyGuard implements CanActivate {
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
      relations: ['amphoe', 'localAdministrativeOrganization'],
    });

    if (!workHistory || !isAgencyWorkHistory(workHistory)) {
      throw new ForbiddenException({
        code: 'EQUIPMENT_AGENCY_ONLY',
        message: 'ฟีเจอร์ครุภัณฑ์ (ผ.03) ใช้ได้เฉพาะผู้ใช้สังกัด อบจ.',
      });
    }

    return true;
  }
}
