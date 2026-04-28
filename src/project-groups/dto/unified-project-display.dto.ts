import { ProjectGroup } from '../entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { Status } from 'src/status/entities/status.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { Budget } from 'src/budget/entities/budget.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';
import { GovernmentAgency } from 'src/government-agencies/entities/government-agency.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { Favorite } from 'src/favorite/entities/favorite.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { AttachmentProjectGroup } from 'src/attachment-project-groups/entities/attachment-project-group.entity';
import { AttachmentRevisedProjectGroup } from 'src/attachment-revised-project-groups/entities/attachment-revised-project-group.entity';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';

/**
 * Interface สำหรับแสดงโครงการแบบ unified
 * รวมทั้งโครงการแม่ (ProjectGroup) และโครงการที่แก้ไข (RevisedProjectGroup)
 */
export interface IUnifiedProjectDisplay {
  id: string;
  title: string;
  objective: string;
  goal: string;
  startLat: number | null;
  startLng: number | null;
  endLat: number | null;
  endLng: number | null;
  /** §16 — nullable under ISSUE_BASED projects */
  indicator: string | null;
  expected: string;
  projectYear: number;
  isDraft?: boolean; // Only for original projects, not revised
  isBooked: boolean;
  bookedAt: Date | null;
  pageNumber: number | null;
  createdAt: Date;
  attachments?: (AttachmentProjectGroup | AttachmentRevisedProjectGroup)[];
  // Type แยกว่ามาจากไหน
  projectType: 'original' | 'revised';

  // ถ้าเป็น revised จะมี reference กลับไปหาโครงการแม่
  originalProjectId?: string;
  projectGroup?: { id: string | undefined } | null;
  developmentPlanRevision?: DevelopmentPlanRevision;
  // W57-DB-01 — entity widened to `string | null`. DTO mirrors that so
  // callers passing `revisedProject.prevProjectId` (now `string | null
  // | undefined`) compile.
  prevProjectId?: string | null;
  prevProjectType?: string;

  changes?: {
    comparedWith: 'original' | 'revised' | null;  // เทียบกับอะไร
    changedFields: string[];  // รายการ field ที่เปลี่ยน เช่น ["title", "objective", "budgets"]
  };

  // Relations — §16 classification is nullable: EXACTLY one of
  // {strategy + tactic + plan + indicator} or {developmentIssue} is populated.
  strategy?: Strategy | null;
  tactic?: Tactic | null;
  plan?: Plan | null;
  /** §16 — populated only on ISSUE_BASED projects */
  developmentIssue?: DevelopmentIssue | null;
  developmentPlan?: DevelopmentPlan;
  createdBy?: WorkHistory;
  responsibleBy?: WorkHistory;
  originAgencyId?: LocalAdministrativeOrganization;
  responsibleAgency?: GovernmentAgency | null;
  amphoe?: Amphoe;
  localAdministrativeOrganization?: LocalAdministrativeOrganization;
  budgets?: Budget[];
  trackingStatus?: TrackingStatus[];
  favorites?: Favorite[];

  // Additional fields for revised projects
  additionalDetail?: string | null;
  oldAdditionDetail?: string | null;

  // Descendant flag: true if another RevisedProjectGroup references this project via prevProjectId
  hasDescendant?: boolean;
}

/**
 * Helper class สำหรับแปลง entity เป็น unified display format
 */
export class UnifiedProjectMapper {
  /**
   * แปลง ProjectGroup เป็น IUnifiedProjectDisplay
   * CLAUDE.md §14 — hasDescendant signals Version Lineage Immutability lock.
   * When true, the UI MUST disable edit and delete actions.
   */
  static fromProjectGroup(
    project: ProjectGroup,
    hasDescendant?: boolean,
  ): IUnifiedProjectDisplay {
    return {
      id: project.id,
      title: project.title,
      objective: project.objective,
      goal: project.goal,
      startLat: project.startLat,
      startLng: project.startLng,
      endLat: project.endLat,
      endLng: project.endLng,
      indicator: project.indicator,
      expected: project.expected,
      projectYear: project.projectYear,
      createdAt: project.createdAt,
      projectType: 'original',
      strategy: project.strategy,
      tactic: project.tactic,
      plan: project.plan,
      developmentIssue: project.developmentIssue,
      developmentPlan: project.developmentPlan,
      createdBy: project.createdBy,
      originAgencyId: project.originAgencyId,
      responsibleAgency: project.responsibleAgency,
      budgets: project.budgets,
      trackingStatus: project.trackingStatus,
      favorites: project.favorites,
      isDraft: project.isDraft,
      isBooked: project.isBooked,
      bookedAt: project.bookedAt,
      pageNumber: project.pageNumber,
      amphoe: project.amphoe,
      localAdministrativeOrganization: project.localAdministrativeOrganization,
      attachments: project.attachments,
      hasDescendant: hasDescendant ?? false,
    };
  }

  /**
   * แปลง RevisedProjectGroup เป็น IUnifiedProjectDisplay
   */
  static fromRevisedProjectGroup(
    revisedProject: RevisedProjectGroup,
    hasDescendant?: boolean,
  ): IUnifiedProjectDisplay {
    return {
      id: revisedProject.id,
      title: revisedProject.title,
      objective: revisedProject.objective,
      goal: revisedProject.goal,
      startLat: revisedProject.startLat,
      startLng: revisedProject.startLng,
      endLat: revisedProject.endLat,
      endLng: revisedProject.endLng,
      indicator: revisedProject.indicator,
      expected: revisedProject.expected,
      projectYear: revisedProject.projectYear,
      createdAt: revisedProject.createdAt,
      attachments: revisedProject.attachments,
      projectType: 'revised',
      projectGroup: revisedProject.projectGroup ? { id: revisedProject.projectGroup.id } : null,

      // Version Information
      developmentPlanRevision: revisedProject.developmentPlanRevision,
      prevProjectId: revisedProject.prevProjectId,
      prevProjectType: revisedProject.prevProjectType,

      strategy: revisedProject.strategy,
      tactic: revisedProject.tactic,
      plan: revisedProject.plan,
      developmentIssue: revisedProject.developmentIssue,
      developmentPlan: revisedProject.developmentPlan ?? revisedProject.developmentPlanRevision?.developmentPlan,
      createdBy: revisedProject.createdBy,
      originAgencyId: revisedProject.originAgencyId,
      responsibleAgency: revisedProject.responsibleAgency,
      amphoe: revisedProject.amphoe,
      localAdministrativeOrganization: revisedProject.localAdministrativeOrganization,
      budgets: revisedProject.budgets,
      trackingStatus: revisedProject.trackingStatus,
      favorites: revisedProject.favorites,
      isBooked: revisedProject.isBooked,
      bookedAt: revisedProject.bookedAt,
      pageNumber: revisedProject.pageNumber,
      additionalDetail: revisedProject.additionalDetail,
      oldAdditionDetail: revisedProject.oldAdditionDetail,
      hasDescendant: hasDescendant ?? false,
    };
  }

  /**
   * แปลง array ของ mixed entities
   */
  static mapMany(
    projects: (ProjectGroup | RevisedProjectGroup)[],
  ): IUnifiedProjectDisplay[] {
    return projects.map((project) => {
      if (project instanceof ProjectGroup) {
        return this.fromProjectGroup(project);
      } else {
        return this.fromRevisedProjectGroup(project);
      }
    });
  }
}
