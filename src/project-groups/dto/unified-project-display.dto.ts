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
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';
import { Favorite } from 'src/favorite/entities/favorite.entity';

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
  indicator: string;
  expected: string;
  projectYear: number;
  isDraft: boolean;
  createdAt: Date;
  
  // Type แยกว่ามาจากไหน
  projectType: 'original' | 'revised';
  
  // ถ้าเป็น revised จะมี reference กลับไปหาโครงการแม่
  originalProjectId?: string;
  
  // Version Information (สำหรับ revised projects)
  revisionNumber?: number;        // เลข revision (1, 2, 3, ...)
  revisionTypeName?: string;      // ชื่อประเภท ("แก้ไข" หรือ "เปลี่ยนแปลง")
  revisionDisplayName?: string;   // ชื่อแสดงผล (เช่น "Revision #2 - แก้ไข")
  
  // Comparison with previous version (สำหรับ versions endpoint)
  changes?: {
    comparedWith: 'original' | 'previous-revision' | null;  // เทียบกับอะไร
    changedFields: string[];  // รายการ field ที่เปลี่ยน เช่น ["title", "objective", "budgets"]
  };
  
  // Relations
  strategy?: Strategy;
  tactic?: Tactic;
  plan?: Plan;
  budgetPlan?: BudgetPlan;
  createdBy?: WorkHistory;
  responsibleBy?: WorkHistory;
  originAgencyId?: LocalAdministrativeOrganization;
  responsibleAgency?: GovernmentAgency;
  budgets?: Budget[];
  trackingStatus?: TrackingStatus[];
  favorites?: Favorite[];
  
  // Additional fields for revised projects
  additionalDetail?: string | null;
  
  // Original entities (for internal use if needed)
  _originalEntity?: ProjectGroup | RevisedProjectGroup;
}

/**
 * Helper class สำหรับแปลง entity เป็น unified display format
 */
export class UnifiedProjectMapper {
  /**
   * แปลง ProjectGroup เป็น IUnifiedProjectDisplay
   */
  static fromProjectGroup(project: ProjectGroup): IUnifiedProjectDisplay {
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
      isDraft: project.isDraft,
      createdAt: project.createdAt,
      projectType: 'original',
      strategy: project.strategy,
      tactic: project.tactic,
      plan: project.plan,
      budgetPlan: project.budgetPlan,
      createdBy: project.createdBy,
      originAgencyId: project.originAgencyId,
      responsibleAgency: project.responsibleAgency,
      budgets: project.budgets,
      trackingStatus: project.trackingStatus,
      favorites: project.favorites,
      _originalEntity: project,
    };
  }

  /**
   * แปลง RevisedProjectGroup เป็น IUnifiedProjectDisplay
   */
  static fromRevisedProjectGroup(
    revisedProject: RevisedProjectGroup,
  ): IUnifiedProjectDisplay {
    const revision = revisedProject.developmentPlanRevision;
    const revisionNumber = revision?.revisionNumber;
    const revisionTypeName = revision?.revisionType?.name;
    
    // สร้าง display name (เช่น "Revision #2 - แก้ไข")
    let revisionDisplayName: string | undefined;
    if (revisionNumber !== undefined && revisionTypeName) {
      revisionDisplayName = `Revision #${revisionNumber} - ${revisionTypeName}`;
    }

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
      isDraft: revisedProject.isDraft,
      createdAt: revisedProject.createdAt,
      projectType: 'revised',
      originalProjectId: revisedProject.projectGroup?.id,
      
      // Version Information
      revisionNumber,
      revisionTypeName,
      revisionDisplayName,
      
      strategy: revisedProject.strategy,
      tactic: revisedProject.tactic,
      plan: revisedProject.plan,
      budgetPlan: revisedProject.developmentPlanRevision?.budgetPlan,
      createdBy: revisedProject.createdBy,
      originAgencyId: revisedProject.originAgencyId,
      responsibleAgency: revisedProject.responsibleAgency,
      budgets: revisedProject.budgets,
      trackingStatus: revisedProject.trackingStatus,
      additionalDetail: revisedProject.additionalDetail,
      _originalEntity: revisedProject,
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
