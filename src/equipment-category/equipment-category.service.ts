import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';

import { EquipmentCategory } from './entities/equipment-category.entity';
import { EquipmentCategoryScope } from './entities/equipment-category-scope.entity';
import { CreateEquipmentCategoryDto } from './dto/create-equipment-category.dto';
import { UpdateEquipmentCategoryDto } from './dto/update-equipment-category.dto';
import { ReplaceScopesByTacticDto } from './dto/replace-scopes-by-tactic.dto';
import { ReplaceScopesByCategoryDto } from './dto/replace-scopes-by-category.dto';
import {
  EquipmentCategoryDto,
  EquipmentCategoryScopeDto,
} from './dto/equipment-category.dto';

/**
 * Wave Equipment ผ.03, Phase 1 — BE-01.
 *
 * Owns the reference-data CRUD + cascading-filter lookup for ผ.03
 * equipment categories. No FK into project / plan / tracking tables
 * (CLAUDE.md §10 — reference-data only); admin writes are gated at the
 * controller via `RolesGuard` + `WorkStatusApprovedGuard`.
 *
 * Replace endpoints (`PUT .../scopes/by-{tactic,category}`) run as
 * single transactions — DELETE matching axis rows, then INSERT the new
 * set — matching the strategic-graph master `replaceMapping` pattern.
 *
 * F7 invariant: every `(tacticId, planId)` tuple referenced by a write
 * MUST already exist in `plan_tactics`. Mirrors the DB-01 seed guard.
 */
@Injectable()
export class EquipmentCategoryService {
  private readonly logger = new Logger(EquipmentCategoryService.name);

  constructor(
    @InjectRepository(EquipmentCategory)
    private readonly categoryRepo: Repository<EquipmentCategory>,
    @InjectRepository(EquipmentCategoryScope)
    private readonly scopeRepo: Repository<EquipmentCategoryScope>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  // -------------------------------------------------------------
  //  Read paths
  // -------------------------------------------------------------

  async findAllCategories(): Promise<EquipmentCategoryDto[]> {
    const rows = await this.categoryRepo.find({
      where: { deletedAt: IsNull() },
      order: { sortOrder: 'ASC' },
    });
    return rows.map(this.toCategoryDto);
  }

  /**
   * Cascading filter — given (tacticId, planId), return the categories
   * scoped to that pair. Returns `[]` on no match (NOT 404 — empty
   * result is a legitimate UI signal).
   */
  async findScopedCategories(
    tacticId: string,
    planId: string,
  ): Promise<EquipmentCategoryDto[]> {
    const rows = await this.categoryRepo
      .createQueryBuilder('c')
      .innerJoin(
        EquipmentCategoryScope,
        's',
        's.equipment_category_id = c.id AND s.tactic_id = :tacticId AND s.plan_id = :planId',
        { tacticId, planId },
      )
      .where('c.deleted_at IS NULL')
      .orderBy('c.sort_order', 'ASC')
      .getMany();
    return rows.map(this.toCategoryDto);
  }

  // -------------------------------------------------------------
  //  Admin: category CRUD
  // -------------------------------------------------------------

  async createCategory(
    dto: CreateEquipmentCategoryDto,
  ): Promise<EquipmentCategoryDto> {
    await this.assertCodeUnique(dto.code);
    const entity = this.categoryRepo.create({
      code: dto.code,
      name: dto.name,
      sortOrder: dto.sortOrder ?? dto.code,
    });
    const saved = await this.categoryRepo.save(entity);
    this.logger.log(`Created equipment category code=${saved.code} id=${saved.id}`);
    return this.toCategoryDto(saved);
  }

  async updateCategory(
    id: string,
    dto: UpdateEquipmentCategoryDto,
  ): Promise<EquipmentCategoryDto> {
    const existing = await this.findCategoryOr404(id);
    if (dto.code !== undefined && dto.code !== existing.code) {
      await this.assertCodeUnique(dto.code);
      existing.code = dto.code;
    }
    if (dto.name !== undefined) existing.name = dto.name;
    if (dto.sortOrder !== undefined) existing.sortOrder = dto.sortOrder;
    const saved = await this.categoryRepo.save(existing);
    this.logger.log(`Updated equipment category id=${saved.id}`);
    return this.toCategoryDto(saved);
  }

  async softDeleteCategory(id: string): Promise<void> {
    const existing = await this.findCategoryOr404(id);
    await this.categoryRepo.softRemove(existing);
    this.logger.log(`Soft-deleted equipment category id=${id}`);
    // Note: `equipment_category_scopes` rows survive soft-delete by
    // design. ON DELETE CASCADE on the FK only fires on hard delete
    // (which is not exposed). Restore will bring category + scopes
    // back aligned. See BE-01 report Risks §11.
  }

  async restoreCategory(id: string): Promise<EquipmentCategoryDto> {
    const existing = await this.categoryRepo.findOne({
      where: { id },
      withDeleted: true,
    });
    if (!existing) {
      throw new NotFoundException(`Equipment category not found: ${id}`);
    }
    if (existing.deletedAt === null) {
      return this.toCategoryDto(existing); // idempotent
    }
    existing.deletedAt = null;
    const saved = await this.categoryRepo.save(existing);
    this.logger.log(`Restored equipment category id=${id}`);
    return this.toCategoryDto(saved);
  }

  // -------------------------------------------------------------
  //  Admin: scope replace (transactional)
  // -------------------------------------------------------------

  /**
   * Replace ALL scope rows for one `(tacticId, planId)` pair with the
   * supplied category set. Atomic — wraps DELETE + INSERT in a single
   * transaction.
   */
  async replaceScopesByTactic(
    dto: ReplaceScopesByTacticDto,
  ): Promise<EquipmentCategoryScopeDto[]> {
    await this.assertPlanTacticPairExists(dto.tacticId, dto.planId);
    await this.assertCategoriesExist(dto.equipmentCategoryIds);

    return this.dataSource.transaction(async (em) => {
      await em.delete(EquipmentCategoryScope, {
        tacticId: dto.tacticId,
        planId: dto.planId,
      });

      if (dto.equipmentCategoryIds.length === 0) {
        this.logger.log(
          `Replaced scopes by-tactic (tactic=${dto.tacticId}, plan=${dto.planId}) → cleared`,
        );
        return [];
      }

      const rows = dto.equipmentCategoryIds.map((catId) =>
        em.create(EquipmentCategoryScope, {
          equipmentCategoryId: catId,
          tacticId: dto.tacticId,
          planId: dto.planId,
        }),
      );
      const saved = await em.save(rows);
      this.logger.log(
        `Replaced scopes by-tactic (tactic=${dto.tacticId}, plan=${dto.planId}) → ${saved.length}`,
      );
      return saved.map(this.toScopeDto);
    });
  }

  /**
   * Replace ALL scope rows for one `(equipmentCategoryId, tacticId)`
   * pair with the supplied plan set. Atomic.
   */
  async replaceScopesByCategory(
    dto: ReplaceScopesByCategoryDto,
  ): Promise<EquipmentCategoryScopeDto[]> {
    await this.findCategoryOr404(dto.equipmentCategoryId);
    for (const planId of dto.planIds) {
      await this.assertPlanTacticPairExists(dto.tacticId, planId);
    }

    return this.dataSource.transaction(async (em) => {
      await em.delete(EquipmentCategoryScope, {
        equipmentCategoryId: dto.equipmentCategoryId,
        tacticId: dto.tacticId,
      });

      if (dto.planIds.length === 0) {
        this.logger.log(
          `Replaced scopes by-category (cat=${dto.equipmentCategoryId}, tactic=${dto.tacticId}) → cleared`,
        );
        return [];
      }

      const rows = dto.planIds.map((planId) =>
        em.create(EquipmentCategoryScope, {
          equipmentCategoryId: dto.equipmentCategoryId,
          tacticId: dto.tacticId,
          planId,
        }),
      );
      const saved = await em.save(rows);
      this.logger.log(
        `Replaced scopes by-category (cat=${dto.equipmentCategoryId}, tactic=${dto.tacticId}) → ${saved.length}`,
      );
      return saved.map(this.toScopeDto);
    });
  }

  // -------------------------------------------------------------
  //  Helpers
  // -------------------------------------------------------------

  private async findCategoryOr404(id: string): Promise<EquipmentCategory> {
    const row = await this.categoryRepo.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException(`Equipment category not found: ${id}`);
    }
    return row;
  }

  private async assertCodeUnique(code: number): Promise<void> {
    const dup = await this.categoryRepo.findOne({
      where: { code },
      withDeleted: true,
    });
    if (dup) {
      throw new ConflictException('EQUIPMENT_CATEGORY_CODE_DUPLICATE');
    }
  }

  private async assertCategoriesExist(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const rows = await this.categoryRepo
      .createQueryBuilder('c')
      .select(['c.id'])
      .where('c.id IN (:...ids)', { ids })
      .andWhere('c.deleted_at IS NULL')
      .getMany();
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) {
      throw new BadRequestException(
        `EQUIPMENT_CATEGORY_NOT_FOUND: ${missing.join(', ')}`,
      );
    }
  }

  /**
   * F7 invariant guard — every (tacticId, planId) referenced by a
   * scope write MUST exist in `plan_tactics`. Mirrors the DB-01 seed
   * EXISTS check verbatim.
   */
  private async assertPlanTacticPairExists(
    tacticId: string,
    planId: string,
  ): Promise<void> {
    const result = await this.dataSource.query(
      `SELECT 1 FROM plan_tactics WHERE tactic_id = $1 AND plan_id = $2 LIMIT 1`,
      [tacticId, planId],
    );
    if (!result || result.length === 0) {
      throw new BadRequestException(
        `PLAN_TACTIC_PAIR_INVALID: tacticId=${tacticId}, planId=${planId}`,
      );
    }
  }

  private toCategoryDto(row: EquipmentCategory): EquipmentCategoryDto {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    };
  }

  private toScopeDto(row: EquipmentCategoryScope): EquipmentCategoryScopeDto {
    return {
      id: row.id,
      equipmentCategoryId: row.equipmentCategoryId,
      tacticId: row.tacticId,
      planId: row.planId,
    };
  }
}
