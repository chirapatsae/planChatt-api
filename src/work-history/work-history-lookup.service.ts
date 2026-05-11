import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { WorkHistory } from './entities/work-history.entity';

/**
 * WorkHistoryLookupService — CLAUDE.md §1 / §2
 *
 * Tiny shared lookup helper extracted from `ProjectGroupsService` so any
 * service (single-row create/update, bulk upload validator, etc.) can
 * resolve the requester's current/latest WorkHistory and assert their
 * `workStatus = approved` precondition without depending on the
 * god-service.
 *
 * This service performs READ-ONLY lookups against the supplied
 * `EntityManager` and is therefore safe to call inside any caller's
 * transaction.
 *
 * Behavior is identical to the original `ProjectGroupsService.getWorkHistory`
 * + `assertWorkStatusApproved` pair — the relations list, the error
 * messages, and the throw types are preserved verbatim.
 */
@Injectable()
export class WorkHistoryLookupService {
  /**
   * Resolve the supplied user's current/latest WorkHistory inside the
   * caller's transaction. Throws `NotFoundException` when the user has
   * no `isCurrent=true` record.
   */
  async getCurrent(manager: EntityManager, userId: string): Promise<WorkHistory> {
    const workHistory = await manager.findOne(WorkHistory, {
      where: { user: { id: userId }, isCurrent: true },
      relations: [
        'user',
        'localAdministrativeOrganization',
        'governmentAgencies',
        'amphoe',
        'workStatus',
        'role',
      ],
    });
    if (!workHistory) {
      throw new NotFoundException('Work history ID not found');
    }
    return workHistory;
  }

  /**
   * CLAUDE.md §2 — block any workflow action when the user's
   * `workStatus.name` is not `approved`. Pure synchronous check, no DB
   * access. Throws `UnauthorizedException` with the original Thai copy.
   */
  assertWorkStatusApproved(workHistory: WorkHistory): void {
    if (workHistory.workStatus?.name !== 'approved') {
      throw new UnauthorizedException(
        'คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)',
      );
    }
  }
}
