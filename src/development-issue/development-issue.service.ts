import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { DevelopmentIssue } from './entities/development-issue.entity';
import { CreateDevelopmentIssueDto } from './dto/create-development-issue.dto';
import { UpdateDevelopmentIssueDto } from './dto/update-development-issue.dto';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { BookLockService } from 'src/common/book-lock/book-lock.service';
import {
  ERROR_CODES,
  ERROR_MESSAGES,
} from 'src/common/project-classification/constants';
import { handleException } from 'src/util/handleException';
import { ReportFormat } from 'src/development-plan/types/report-format.enum';

/**
 * DevelopmentIssueService — CLAUDE.md §16.6
 *
 * Plan-scoped CRUD for `DevelopmentIssue`. All mutating operations are
 * gated by:
 *   - role (staff-lead: staff, admin, super_admin) per §3
 *   - workStatus approved per §2
 *   - §15 book lineage lock (parent plan must be unlocked)
 *
 * Soft-delete is the only removal mechanism (§16.6). A soft-delete is
 * additionally rejected when any non-deleted project (ProjectGroup,
 * RevisedProjectGroup, SupplementProjectGroup) still references the
 * issue — error `DEVELOPMENT_ISSUE_IN_USE`.
 */
@Injectable()
export class DevelopmentIssueService {
  private readonly logger = new Logger(DevelopmentIssueService.name);

  constructor(
    @InjectRepository(DevelopmentIssue)
    private readonly developmentIssueRepository: Repository<DevelopmentIssue>,

    @InjectRepository(DevelopmentPlan)
    private readonly developmentPlanRepository: Repository<DevelopmentPlan>,

    @InjectRepository(WorkHistory)
    private readonly workHistoryRepository: Repository<WorkHistory>,

    private readonly dataSource: DataSource,
    private readonly bookLockService: BookLockService,
  ) {}

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  async create(dto: CreateDevelopmentIssueDto, userId: string) {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const workHistory = await this.assertStaffLead(manager, userId);

        const plan = await manager.findOne(DevelopmentPlan, {
          where: { id: dto.developmentPlanId },
        });
        if (!plan) {
          throw new NotFoundException(
            `${ERROR_MESSAGES.PARENT_PLAN_NOT_FOUND}: DevelopmentPlan(${dto.developmentPlanId})`,
          );
        }

        // CLAUDE.md §16.6 — new issues blocked when the parent plan is
        // §15-locked (has a non-soft-deleted revision or supplement).
        await this.bookLockService.assertEditable(
          plan.id,
          'development_plan',
          manager,
        );

        if (plan.reportFormat !== ReportFormat.ISSUE_BASED) {
          // A STRATEGY_BASED plan has no semantic place for issues.
          // Reject up front so a mis-clicked dialog does not pollute the
          // table with orphan rows. This is belt-and-braces to the
          // frontend which hides the admin dialog for STRATEGY_BASED
          // plans entirely.
          throw new ForbiddenException(
            `${ERROR_CODES.PROJECT_CLASSIFICATION_SHAPE_MISMATCH}: ${ERROR_MESSAGES.PROJECT_CLASSIFICATION_SHAPE_MISMATCH}`,
          );
        }

        const issue = manager.create(DevelopmentIssue, {
          developmentPlan: { id: plan.id } as DevelopmentPlan,
          name: dto.name.trim(),
          sortOrder: dto.sortOrder ?? 0,
          createdBy: { id: workHistory.id } as WorkHistory,
        });

        return await manager.save(DevelopmentIssue, issue);
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAllByPlan(planId: string): Promise<DevelopmentIssue[]> {
    try {
      return await this.developmentIssueRepository.find({
        where: {
          developmentPlan: { id: planId },
          deletedAt: IsNull(),
        },
        order: { sortOrder: 'ASC', createdAt: 'ASC' },
      });
    } catch (error) {
      handleException(this.logger, error);
      return [];
    }
  }

  async update(id: string, dto: UpdateDevelopmentIssueDto, userId: string) {
    try {
      return await this.dataSource.transaction(async (manager) => {
        await this.assertStaffLead(manager, userId);

        const issue = await manager.findOne(DevelopmentIssue, {
          where: { id },
          relations: ['developmentPlan'],
        });
        if (!issue) {
          throw new NotFoundException(
            `${ERROR_CODES.DEVELOPMENT_ISSUE_NOT_FOUND}: ${ERROR_MESSAGES.DEVELOPMENT_ISSUE_NOT_FOUND}`,
          );
        }

        // CLAUDE.md §16.6 — parent plan lock gate.
        await this.bookLockService.assertEditable(
          issue.developmentPlan.id,
          'development_plan',
          manager,
        );

        if (dto.name !== undefined) issue.name = dto.name.trim();
        if (dto.sortOrder !== undefined) issue.sortOrder = dto.sortOrder;

        return await manager.save(DevelopmentIssue, issue);
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async softRemove(id: string, userId: string) {
    try {
      return await this.dataSource.transaction(async (manager) => {
        await this.assertStaffLead(manager, userId);

        const issue = await manager.findOne(DevelopmentIssue, {
          where: { id },
          relations: ['developmentPlan'],
        });
        if (!issue) {
          throw new NotFoundException(
            `${ERROR_CODES.DEVELOPMENT_ISSUE_NOT_FOUND}: ${ERROR_MESSAGES.DEVELOPMENT_ISSUE_NOT_FOUND}`,
          );
        }

        await this.bookLockService.assertEditable(
          issue.developmentPlan.id,
          'development_plan',
          manager,
        );

        // CLAUDE.md §16.6 — reject if any active project still
        // references the issue. We scan all three project tables.
        await this.assertNoActiveReferences(id, manager);

        await manager.softRemove(DevelopmentIssue, issue);
        return { message: 'ลบประเด็นการพัฒนาสำเร็จ' };
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  // -------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------

  /**
   * Loads the current WorkHistory, asserts workStatus=approved, and
   * asserts role is staff-lead (staff | admin | super_admin) per
   * CLAUDE.md §3 / staff-lead definition.
   */
  private async assertStaffLead(
    manager: EntityManager,
    userId: string,
  ): Promise<WorkHistory> {
    const workHistory = await manager.findOne(WorkHistory, {
      where: { user: { id: userId } },
      relations: ['workStatus', 'role', 'user'],
    });

    if (!workHistory) {
      throw new NotFoundException('ไม่พบข้อมูล WorkHistory ของผู้ใช้งาน');
    }
    if (workHistory.workStatus?.name?.toLowerCase() !== 'approved') {
      throw new ForbiddenException('สิทธิ์การใช้งานของคุณไม่ใช่ approved');
    }

    const roleName = workHistory.role?.name?.toLowerCase();
    const allowed = ['staff', 'admin', 'super_admin', 'super-admin'];
    if (!roleName || !allowed.includes(roleName)) {
      throw new ForbiddenException(
        'เฉพาะเจ้าหน้าที่ (staff / admin / super-admin) เท่านั้นที่แก้ไขประเด็นการพัฒนาได้',
      );
    }

    return workHistory;
  }

  /**
   * Rejects if any non-deleted project (ProjectGroup, RevisedProjectGroup,
   * SupplementProjectGroup) still references this issue. Runs inside the
   * caller's transaction for snapshot isolation.
   */
  private async assertNoActiveReferences(
    issueId: string,
    manager: EntityManager,
  ): Promise<void> {
    const [pg, rpg, spg] = await Promise.all([
      manager.exists(ProjectGroup, {
        where: { developmentIssue: { id: issueId } },
      }),
      manager.exists(RevisedProjectGroup, {
        where: { developmentIssue: { id: issueId } },
      }),
      manager.exists(SupplementProjectGroup, {
        where: { developmentIssue: { id: issueId } },
      }),
    ]);

    if (pg || rpg || spg) {
      throw new ConflictException(
        `${ERROR_CODES.DEVELOPMENT_ISSUE_IN_USE}: ${ERROR_MESSAGES.DEVELOPMENT_ISSUE_IN_USE}`,
      );
    }
  }
}
