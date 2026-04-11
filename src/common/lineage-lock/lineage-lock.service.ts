import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { PrevProjectType } from 'src/revised-project-group/dto/create-revised-project-group.dto';

/**
 * Lineage type discriminator used by LineageLockService.
 *
 * - 'original' targets a ProjectGroup (main-plan) row. Its descendants are
 *   RevisedProjectGroup rows whose prev_project_type = 'original'.
 * - 'revised' targets a RevisedProjectGroup row. Its descendants are
 *   RevisedProjectGroup rows whose prev_project_type = 'revised'.
 */
export type LineageProjectType = 'original' | 'revised';

/**
 * Canonical error code prefix thrown when a row has a non-deleted descendant
 * and therefore cannot be mutated or deleted (CLAUDE.md §14).
 *
 * Frontend and integration tests rely on this string prefix.
 */
export const PROJECT_HAS_DESCENDANT = 'PROJECT_HAS_DESCENDANT';

/**
 * LineageLockService
 *
 * Single source of truth for the Version Lineage Immutability invariant
 * defined in CLAUDE.md §14. A project row P is locked (non-editable,
 * non-deletable) if and only if there exists any non-soft-deleted
 * RevisedProjectGroup referencing it via (prev_project_id, prev_project_type).
 *
 * The service is stateless, transaction-aware (accepts an EntityManager so it
 * participates in the caller's transaction), and role-agnostic. There is NO
 * staff-lead exemption — per §14.5, all roles obey the lock.
 */
@Injectable()
export class LineageLockService {
  private readonly logger = new Logger(LineageLockService.name);

  /**
   * Returns true when the target row has at least one non-soft-deleted
   * descendant. Uses the existing partial index
   * idx_rpg_prev_project_id ON (prev_project_id) WHERE deleted_at IS NULL.
   */
  async hasNonDeletedDescendant(
    projectId: string,
    projectType: LineageProjectType,
    manager: EntityManager,
  ): Promise<boolean> {
    if (!projectId) return false;

    const enumValue =
      projectType === 'original'
        ? PrevProjectType.ORIGINAL
        : PrevProjectType.REVISION;

    // TypeORM `exists` honours the entity's @DeleteDateColumn by default,
    // so soft-deleted descendants are excluded — matching §14.2 semantics.
    return await manager.exists(RevisedProjectGroup, {
      where: {
        prevProjectId: projectId,
        prevProjectType: enumValue,
      },
    });
  }

  /**
   * Throws ConflictException with the canonical PROJECT_HAS_DESCENDANT error
   * code when the target row has a non-deleted descendant. Must be called
   * BEFORE any repository mutation (§14.9).
   */
  async assertEditable(
    projectId: string,
    projectType: LineageProjectType,
    manager: EntityManager,
  ): Promise<void> {
    const locked = await this.hasNonDeletedDescendant(
      projectId,
      projectType,
      manager,
    );
    if (locked) {
      throw new ConflictException(
        `${PROJECT_HAS_DESCENDANT}: ไม่สามารถแก้ไขโครงการนี้ได้ เนื่องจากมีเวอร์ชันใหม่อ้างอิงอยู่ (CLAUDE.md §14)`,
      );
    }
  }

  /**
   * Throws ConflictException with the canonical PROJECT_HAS_DESCENDANT error
   * code when the target row has a non-deleted descendant. Must be called
   * BEFORE any repository delete / softDelete (§14.9).
   *
   * Kept as a distinct method from assertEditable so either can be relaxed
   * independently in the future without a refactor.
   */
  async assertDeletable(
    projectId: string,
    projectType: LineageProjectType,
    manager: EntityManager,
  ): Promise<void> {
    const locked = await this.hasNonDeletedDescendant(
      projectId,
      projectType,
      manager,
    );
    if (locked) {
      throw new ConflictException(
        `${PROJECT_HAS_DESCENDANT}: ไม่สามารถลบโครงการนี้ได้ เนื่องจากมีเวอร์ชันใหม่อ้างอิงอยู่ (CLAUDE.md §14)`,
      );
    }
  }
}
