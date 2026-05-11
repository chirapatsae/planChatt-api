import { BadRequestException } from '@nestjs/common';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { ProjectGroup } from '../entities/project-group.entity';

/**
 * CLAUDE.md §1 / §5 / §7 — derive the agency-or-LAO context fields the
 * service writes onto a fresh `ProjectGroup` row.
 *
 * Pure function extracted from `ProjectGroupsService.getAgencyData` so the
 * bulk-upload validator + commit path can reuse the exact same logic
 * without depending on the god-service.
 *
 * Returns:
 *   - For agency creators (amphoe.id = '3001' AND lao.id = '3001027'):
 *     `{ responsibleAgency: { id: workHistory.governmentAgencies.id } }`
 *   - For LAO creators (any other lao):
 *     `{ originAgencyId: { id: workHistory.localAdministrativeOrganization.id } }`
 *
 * Throws `BadRequestException` when the WorkHistory does not match either
 * shape (matches the existing single-row error contract verbatim).
 */
export function getAgencyData(workHistory: WorkHistory): Partial<ProjectGroup> {
  // Agency: amphoe.id = 3001 AND lao.id = 3001027 (CLAUDE.md §1)
  if (
    workHistory.amphoe?.id === '3001' &&
    workHistory.governmentAgencies &&
    workHistory.localAdministrativeOrganization?.id === '3001027'
  ) {
    return {
      responsibleAgency: { id: workHistory.governmentAgencies.id } as any,
    };
  }

  // LAO: all others with a valid localAdministrativeOrganization
  if (
    workHistory.localAdministrativeOrganization &&
    workHistory.localAdministrativeOrganization.id !== '3001027'
  ) {
    return {
      originAgencyId: { id: workHistory.localAdministrativeOrganization.id } as any,
    };
  }

  throw new BadRequestException(
    'ไม่พบข้อมูลหน่วยงานที่รับผิดชอบหรือหน่วยงานต้นสังกัด',
  );
}

/**
 * Predicate form of CLAUDE.md §1 user-classification rule. Used by
 * code paths that need to branch on agency-vs-LAO without mutating
 * project data (e.g., phase matching, geo check exemption).
 */
export function isAgencyWorkHistory(workHistory: WorkHistory): boolean {
  return (
    workHistory.amphoe?.id === '3001' &&
    workHistory.localAdministrativeOrganization?.id === '3001027'
  );
}
