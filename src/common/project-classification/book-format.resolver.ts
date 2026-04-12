import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { ReportFormat } from 'src/development-plan/types/report-format.enum';
import { ERROR_MESSAGES } from './constants';

/**
 * BookFormatResolver — CLAUDE.md §16.3 / §16.8
 *
 * Walks the project → plan / revision / supplement chain and returns the
 * parent `DevelopmentPlan.reportFormat`. This is the canonical lookup
 * used by:
 *   - `ProjectClassificationValidator` call sites (every project
 *     create/update path)
 *   - `PdfFormatDispatcher` when deciding which renderer to use
 *   - Frontend (via response fields populated by these services)
 *
 * Transaction-aware: every method accepts an `EntityManager` so the
 * resolver participates in the caller's transaction and reads a
 * consistent snapshot together with the downstream write.
 *
 * Errors: throws `NotFoundException` when any link in the chain cannot
 * be resolved. Callers treat this as a hard failure and propagate.
 */
@Injectable()
export class BookFormatResolver {
  async resolveByPlan(
    id: string,
    manager: EntityManager,
  ): Promise<ReportFormat> {
    const plan = await manager.findOne(DevelopmentPlan, {
      where: { id },
      select: ['id', 'reportFormat'],
    });
    if (!plan) {
      throw new NotFoundException(
        `${ERROR_MESSAGES.PARENT_PLAN_NOT_FOUND}: DevelopmentPlan(${id})`,
      );
    }
    return plan.reportFormat;
  }

  async resolveByRevision(
    id: string,
    manager: EntityManager,
  ): Promise<ReportFormat> {
    const revision = await manager
      .getRepository(DevelopmentPlanRevision)
      .createQueryBuilder('r')
      .leftJoinAndSelect('r.developmentPlan', 'plan')
      .where('r.id = :id', { id })
      .getOne();

    if (!revision || !revision.developmentPlan) {
      throw new NotFoundException(
        `${ERROR_MESSAGES.PARENT_PLAN_NOT_FOUND}: DevelopmentPlanRevision(${id})`,
      );
    }
    return revision.developmentPlan.reportFormat;
  }

  async resolveBySupplement(
    id: string,
    manager: EntityManager,
  ): Promise<ReportFormat> {
    const supplement = await manager
      .getRepository(DevelopmentPlanSupplement)
      .createQueryBuilder('s')
      .leftJoinAndSelect('s.developmentPlan', 'plan')
      .where('s.id = :id', { id })
      .getOne();

    if (!supplement || !supplement.developmentPlan) {
      throw new NotFoundException(
        `${ERROR_MESSAGES.PARENT_PLAN_NOT_FOUND}: DevelopmentPlanSupplement(${id})`,
      );
    }
    return supplement.developmentPlan.reportFormat;
  }

  async resolveByProjectGroup(
    id: string,
    manager: EntityManager,
  ): Promise<ReportFormat> {
    const project = await manager
      .getRepository(ProjectGroup)
      .createQueryBuilder('p')
      .leftJoinAndSelect('p.developmentPlan', 'plan')
      .where('p.id = :id', { id })
      .getOne();

    if (!project || !project.developmentPlan) {
      throw new NotFoundException(
        `${ERROR_MESSAGES.PARENT_PLAN_NOT_FOUND}: ProjectGroup(${id})`,
      );
    }
    return project.developmentPlan.reportFormat;
  }

  async resolveByRevisedProjectGroup(
    id: string,
    manager: EntityManager,
  ): Promise<ReportFormat> {
    const project = await manager
      .getRepository(RevisedProjectGroup)
      .createQueryBuilder('r')
      .leftJoinAndSelect('r.developmentPlanRevision', 'rev')
      .leftJoinAndSelect('rev.developmentPlan', 'plan')
      .where('r.id = :id', { id })
      .getOne();

    if (
      !project ||
      !project.developmentPlanRevision ||
      !project.developmentPlanRevision.developmentPlan
    ) {
      throw new NotFoundException(
        `${ERROR_MESSAGES.PARENT_PLAN_NOT_FOUND}: RevisedProjectGroup(${id})`,
      );
    }
    return project.developmentPlanRevision.developmentPlan.reportFormat;
  }

  async resolveBySupplementProjectGroup(
    id: string,
    manager: EntityManager,
  ): Promise<ReportFormat> {
    const project = await manager
      .getRepository(SupplementProjectGroup)
      .createQueryBuilder('s')
      .leftJoinAndSelect('s.developmentPlanSupplement', 'sup')
      .leftJoinAndSelect('sup.developmentPlan', 'plan')
      .where('s.id = :id', { id })
      .getOne();

    if (
      !project ||
      !project.developmentPlanSupplement ||
      !project.developmentPlanSupplement.developmentPlan
    ) {
      throw new NotFoundException(
        `${ERROR_MESSAGES.PARENT_PLAN_NOT_FOUND}: SupplementProjectGroup(${id})`,
      );
    }
    return project.developmentPlanSupplement.developmentPlan.reportFormat;
  }
}
