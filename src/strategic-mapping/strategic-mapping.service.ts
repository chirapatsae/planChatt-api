import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  EntityTarget,
  ObjectLiteral,
  Repository,
} from 'typeorm';

import { Sdg } from 'src/sdg/entities/sdg.entity';
import { NationalStrategy } from 'src/national-strategy/entities/national-strategy.entity';
import { Milestone } from 'src/milestone/entities/milestone.entity';
import { ProvinceStrategy } from 'src/province-strategy/entities/province-strategy.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { handleException } from 'src/util/handleException';

import { SdgNationalStrategy } from './entities/sdg-national-strategy.entity';
import { MilestoneSdg } from './entities/milestone-sdg.entity';
import { ProvinceStrategySdg } from './entities/province-strategy-sdg.entity';
import { ProvinceStrategyNationalStrategy } from './entities/province-strategy-national-strategy.entity';
import { PlanSdg } from './entities/plan-sdg.entity';
import { PlanNationalStrategy } from './entities/plan-national-strategy.entity';
import { PlanMilestone } from './entities/plan-milestone.entity';
import { PlanProvinceStrategy } from './entities/plan-province-strategy.entity';
import { ReplacePlanMappingsDto } from './dto/replace-plan-mappings.dto';

/**
 * Strategic Graph BE-04 — Inter-master mapping replace API.
 *
 * Routes (mounted by `StrategicMappingController`):
 *   POST /v1/strategic-graph/mapping/:type  (write — replace mode, admin)
 *   GET  /v1/strategic-graph/mapping/:type?sourceId=  (read — any auth)
 *
 * Four `:type` values are dispatched via `TYPE_DISPATCH`:
 *   - sdg-national-strategy
 *   - milestone-sdg
 *   - province-strategy-sdg
 *   - province-strategy-national-strategy
 *
 * Authority (umbrella §12 + locked decisions):
 *   - Reads: any authenticated user (controller-level JwtAuthGuard).
 *   - Writes: admin + super-admin only (enforced inside the service via
 *     `assertAdminOrSuperAdmin`, mirroring `SdgService` pattern).
 *
 * Audit (umbrella §12):
 *   - Each junction row carries `updated_at` (auto via @UpdateDateColumn)
 *     and `updated_by` (set to caller's user id).
 *   - These are config rows — NO §12 TrackingStatus interaction.
 *
 * Replace-mode algorithm:
 *   1. Validate source row exists in its master table.
 *   2. Validate every target row exists (batch query with `In(...)`).
 *   3. In a single SQL transaction: DELETE all existing rows for the
 *      source, then INSERT the new set.
 *   4. Deduplicate `targetIds` before insert to avoid surfacing the
 *      `(source_id, target_id)` unique-constraint as a 500 — class-validator
 *      already rejects duplicates via @ArrayUnique, this is belt-and-braces.
 *   5. Empty `targetIds = []` is valid → clears all mappings for the source.
 */

type MappingTypeKey =
  | 'sdg-national-strategy'
  | 'milestone-sdg'
  | 'province-strategy-sdg'
  | 'province-strategy-national-strategy';

interface DispatchConfig {
  entity: EntityTarget<ObjectLiteral>;
  sourceCol: string;
  targetCol: string;
  sourceMaster: EntityTarget<ObjectLiteral>;
  targetMaster: EntityTarget<ObjectLiteral>;
  sourceMasterLabel: string;
  targetMasterLabel: string;
}

const TYPE_DISPATCH: Record<MappingTypeKey, DispatchConfig> = {
  'sdg-national-strategy': {
    entity: SdgNationalStrategy,
    sourceCol: 'sdgId',
    targetCol: 'nationalStrategyId',
    sourceMaster: Sdg,
    targetMaster: NationalStrategy,
    sourceMasterLabel: 'Sdg',
    targetMasterLabel: 'NationalStrategy',
  },
  'milestone-sdg': {
    entity: MilestoneSdg,
    sourceCol: 'milestoneId',
    targetCol: 'sdgId',
    sourceMaster: Milestone,
    targetMaster: Sdg,
    sourceMasterLabel: 'Milestone',
    targetMasterLabel: 'Sdg',
  },
  'province-strategy-sdg': {
    entity: ProvinceStrategySdg,
    sourceCol: 'provinceStrategyId',
    targetCol: 'sdgId',
    sourceMaster: ProvinceStrategy,
    targetMaster: Sdg,
    sourceMasterLabel: 'ProvinceStrategy',
    targetMasterLabel: 'Sdg',
  },
  'province-strategy-national-strategy': {
    entity: ProvinceStrategyNationalStrategy,
    sourceCol: 'provinceStrategyId',
    targetCol: 'nationalStrategyId',
    sourceMaster: ProvinceStrategy,
    targetMaster: NationalStrategy,
    sourceMasterLabel: 'ProvinceStrategy',
    targetMasterLabel: 'NationalStrategy',
  },
};

export interface ReplaceMappingResult {
  count: number;
  updatedAt: Date;
  updatedById: string;
}

export interface GetMappingResult {
  sourceId: string;
  targetIds: string[];
  updatedAt: Date | null;
  updatedById: string | null;
}

export interface PlanMappingsResult {
  planId: string;
  sdgIds: string[];
  nationalStrategyIds: string[];
  milestoneIds: string[];
  provinceStrategyIds: string[];
  updatedAt: Date | null;
  updatedById: string | null;
}

interface PlanDimensionConfig {
  entity: EntityTarget<ObjectLiteral>;
  targetCol: string;
  master: EntityTarget<ObjectLiteral>;
  masterLabel: string;
}

const PLAN_DIMENSIONS: {
  sdg: PlanDimensionConfig;
  nationalStrategy: PlanDimensionConfig;
  milestone: PlanDimensionConfig;
  provinceStrategy: PlanDimensionConfig;
} = {
  sdg: {
    entity: PlanSdg,
    targetCol: 'sdgId',
    master: Sdg,
    masterLabel: 'Sdg',
  },
  nationalStrategy: {
    entity: PlanNationalStrategy,
    targetCol: 'nationalStrategyId',
    master: NationalStrategy,
    masterLabel: 'NationalStrategy',
  },
  milestone: {
    entity: PlanMilestone,
    targetCol: 'milestoneId',
    master: Milestone,
    masterLabel: 'Milestone',
  },
  provinceStrategy: {
    entity: PlanProvinceStrategy,
    targetCol: 'provinceStrategyId',
    master: ProvinceStrategy,
    masterLabel: 'ProvinceStrategy',
  },
};

@Injectable()
export class StrategicMappingService {
  private readonly logger = new Logger(StrategicMappingService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,

    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,

    @InjectRepository(Plan)
    private readonly planRepo: Repository<Plan>,
  ) {}

  private resolveConfig(type: string): DispatchConfig {
    const config = TYPE_DISPATCH[type as MappingTypeKey];
    if (!config) {
      throw new BadRequestException(
        `Invalid mapping type '${type}'. Allowed: ${Object.keys(
          TYPE_DISPATCH,
        ).join(', ')}`,
      );
    }
    return config;
  }

  async replaceMapping(
    type: string,
    sourceId: string,
    targetIds: string[],
    userId: string,
  ): Promise<ReplaceMappingResult> {
    try {
      await this.assertAdminOrSuperAdmin(userId);
      const config = this.resolveConfig(type);

      // 1. Validate source row exists
      const sourceRepo = this.dataSource.getRepository(config.sourceMaster);
      const sourceExists = await sourceRepo.findOne({
        where: { id: sourceId } as any,
      });
      if (!sourceExists) {
        throw new NotFoundException(
          `${config.sourceMasterLabel} with ID ${sourceId} not found`,
        );
      }

      // 2. Deduplicate target IDs (belt-and-braces; DTO already enforces
      //    @ArrayUnique). Preserves caller order for the insert.
      const dedupedTargetIds = Array.from(new Set(targetIds));

      // 3. Validate all targets exist
      if (dedupedTargetIds.length > 0) {
        const targetRepo = this.dataSource.getRepository(config.targetMaster);
        const found = await targetRepo
          .createQueryBuilder('t')
          .select('t.id', 'id')
          .where('t.id IN (:...ids)', { ids: dedupedTargetIds })
          .getRawMany<{ id: string }>();
        if (found.length !== dedupedTargetIds.length) {
          const foundIds = new Set(found.map((r) => r.id));
          const missing = dedupedTargetIds.filter((id) => !foundIds.has(id));
          throw new BadRequestException(
            `One or more ${config.targetMasterLabel} IDs do not exist: ${missing.join(', ')}`,
          );
        }
      }

      // 4. Transaction: DELETE + INSERT
      return await this.dataSource.transaction(async (manager) => {
        const repo = manager.getRepository(config.entity);

        await repo.delete({ [config.sourceCol]: sourceId } as any);

        const now = new Date();
        if (dedupedTargetIds.length > 0) {
          const rows = dedupedTargetIds.map((tid) => ({
            [config.sourceCol]: sourceId,
            [config.targetCol]: tid,
            updatedById: userId,
          }));
          await repo.insert(rows as any);
        }

        return {
          count: dedupedTargetIds.length,
          updatedAt: now,
          updatedById: userId,
        };
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async getMapping(type: string, sourceId: string): Promise<GetMappingResult> {
    try {
      const config = this.resolveConfig(type);
      if (!sourceId) {
        throw new BadRequestException('sourceId query parameter is required');
      }

      const repo = this.dataSource.getRepository(config.entity);
      const rows = await repo.find({
        where: { [config.sourceCol]: sourceId } as any,
        order: { updatedAt: 'DESC' } as any,
      });

      const targetIds = rows.map((r: any) => r[config.targetCol] as string);
      const updatedAt = rows.length > 0 ? (rows[0] as any).updatedAt : null;
      const updatedById = rows.length > 0 ? (rows[0] as any).updatedById : null;

      return { sourceId, targetIds, updatedAt, updatedById };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * BE-05 — composite plan-mapping replace.
   *
   * Atomically replaces a plan's strategic alignment across the four
   * plan-mapping dimensions (SDG / National Strategy / Milestone /
   * Province Strategy) in a single SQL transaction. Per-dimension
   * semantics:
   *   - Field present in DTO → that dimension is replaced (DELETE then
   *     INSERT).
   *   - Field omitted → that dimension is preserved untouched.
   *   - Field = [] → that dimension is cleared (DELETE only).
   *
   * Pre-validation runs OUTSIDE the transaction (one batch query per
   * supplied dimension) so a target-id mismatch surfaces as 400 before
   * any write begins. Plan existence is checked first → 404.
   *
   * Authority: admin + super-admin via `assertAdminOrSuperAdmin`.
   * §12 — config rows; NO TrackingStatus interaction.
   */
  async replacePlanMappings(
    planId: string,
    dto: ReplacePlanMappingsDto,
    userId: string,
  ): Promise<PlanMappingsResult> {
    try {
      await this.assertAdminOrSuperAdmin(userId);

      // 1. Verify plan exists (varchar PK)
      const plan = await this.planRepo.findOne({ where: { id: planId } });
      if (!plan) {
        throw new NotFoundException(`Plan with ID ${planId} not found`);
      }

      // 2. Pre-validate every supplied target id (one batch query per
      //    provided dimension; skips dimensions that are undefined or
      //    empty).
      const dimensionPayload: Array<{
        key: keyof typeof PLAN_DIMENSIONS;
        ids: string[];
      }> = [];
      if (dto.sdgIds !== undefined) {
        dimensionPayload.push({ key: 'sdg', ids: Array.from(new Set(dto.sdgIds)) });
      }
      if (dto.nationalStrategyIds !== undefined) {
        dimensionPayload.push({
          key: 'nationalStrategy',
          ids: Array.from(new Set(dto.nationalStrategyIds)),
        });
      }
      if (dto.milestoneIds !== undefined) {
        dimensionPayload.push({
          key: 'milestone',
          ids: Array.from(new Set(dto.milestoneIds)),
        });
      }
      if (dto.provinceStrategyIds !== undefined) {
        dimensionPayload.push({
          key: 'provinceStrategy',
          ids: Array.from(new Set(dto.provinceStrategyIds)),
        });
      }

      for (const dim of dimensionPayload) {
        if (dim.ids.length === 0) continue;
        const cfg = PLAN_DIMENSIONS[dim.key];
        const masterRepo = this.dataSource.getRepository(cfg.master);
        const found = await masterRepo
          .createQueryBuilder('t')
          .select('t.id', 'id')
          .where('t.id IN (:...ids)', { ids: dim.ids })
          .getRawMany<{ id: string }>();
        if (found.length !== dim.ids.length) {
          const foundIds = new Set(found.map((r) => r.id));
          const missing = dim.ids.filter((id) => !foundIds.has(id));
          throw new BadRequestException(
            `One or more ${cfg.masterLabel} IDs do not exist: ${missing.join(', ')}`,
          );
        }
      }

      // 3. Transaction: per-dimension DELETE + INSERT
      return await this.dataSource.transaction(async (manager) => {
        for (const dim of dimensionPayload) {
          const cfg = PLAN_DIMENSIONS[dim.key];
          const repo = manager.getRepository(cfg.entity);
          await repo.delete({ planId } as any);
          if (dim.ids.length === 0) continue;
          const rows = dim.ids.map((tid) => ({
            planId,
            [cfg.targetCol]: tid,
            updatedById: userId,
          }));
          await repo.insert(rows as any);
        }
        return this.getPlanMappings(planId, manager);
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * BE-05 — composite plan-mapping read.
   *
   * Returns the four plan-mapping dimensions for the given plan id. If
   * the plan has no rows in a dimension, that array is empty (NOT an
   * error). `updatedAt` / `updatedById` are derived from the most
   * recently updated junction row across all four dimensions; both are
   * `null` when the plan has zero mapping rows.
   *
   * Accepts an optional `EntityManager` so it can be reused inside
   * `replacePlanMappings` post-write to return the freshly-mutated state
   * inside the same transaction.
   */
  async getPlanMappings(
    planId: string,
    manager?: EntityManager,
  ): Promise<PlanMappingsResult> {
    try {
      const repoLike = manager ?? this.dataSource.manager;

      const [sdgRows, nsRows, mileRows, psRows] = await Promise.all([
        repoLike.getRepository(PlanSdg).find({ where: { planId } }),
        repoLike
          .getRepository(PlanNationalStrategy)
          .find({ where: { planId } }),
        repoLike.getRepository(PlanMilestone).find({ where: { planId } }),
        repoLike
          .getRepository(PlanProvinceStrategy)
          .find({ where: { planId } }),
      ]);

      const allRows: Array<{ updatedAt: Date; updatedById: string | null }> = [
        ...sdgRows.map((r) => ({
          updatedAt: r.updatedAt,
          updatedById: r.updatedById,
        })),
        ...nsRows.map((r) => ({
          updatedAt: r.updatedAt,
          updatedById: r.updatedById,
        })),
        ...mileRows.map((r) => ({
          updatedAt: r.updatedAt,
          updatedById: r.updatedById,
        })),
        ...psRows.map((r) => ({
          updatedAt: r.updatedAt,
          updatedById: r.updatedById,
        })),
      ];

      let updatedAt: Date | null = null;
      let updatedById: string | null = null;
      for (const r of allRows) {
        if (!updatedAt || (r.updatedAt && r.updatedAt > updatedAt)) {
          updatedAt = r.updatedAt;
          updatedById = r.updatedById;
        }
      }

      return {
        planId,
        sdgIds: sdgRows.map((r) => r.sdgId),
        nationalStrategyIds: nsRows.map((r) => r.nationalStrategyId),
        milestoneIds: mileRows.map((r) => r.milestoneId),
        provinceStrategyIds: psRows.map((r) => r.provinceStrategyId),
        updatedAt,
        updatedById,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * BE-06 — multi-dimension plan filter.
   *
   * Returns plans satisfying ALL non-empty filter dimensions (AND across
   * dimensions). Within a single dimension, the supplied id list is OR'd
   * (IN). Dimensions absent or empty are NOT filtered.
   *
   * Strategy: EXISTS subqueries — preferred over multi-INNER-JOIN to
   * avoid row multiplication when a plan matches multiple ids inside a
   * dimension. Per-dimension `(plan_id, *_id)` indexes (DB-02/DB-03)
   * make each subquery a single-row probe.
   *
   * Authority: any authenticated user (read endpoint). §12 — no
   * TrackingStatus interaction. §17.2 — no AI gating.
   */
  async filterPlans(filters: {
    sdgIds?: string[];
    nationalStrategyIds?: string[];
    milestoneIds?: string[];
    provinceStrategyIds?: string[];
  }): Promise<Plan[]> {
    try {
      const qb = this.planRepo.createQueryBuilder('plan');

      if (filters.sdgIds?.length) {
        qb.andWhere(
          `EXISTS (SELECT 1 FROM plan_sdg ps WHERE ps.plan_id = plan.id AND ps.sdg_id IN (:...sdgIds))`,
          { sdgIds: filters.sdgIds },
        );
      }
      if (filters.nationalStrategyIds?.length) {
        qb.andWhere(
          `EXISTS (SELECT 1 FROM plan_national_strategy pns WHERE pns.plan_id = plan.id AND pns.national_strategy_id IN (:...nsIds))`,
          { nsIds: filters.nationalStrategyIds },
        );
      }
      if (filters.milestoneIds?.length) {
        qb.andWhere(
          `EXISTS (SELECT 1 FROM plan_milestone pm WHERE pm.plan_id = plan.id AND pm.milestone_id IN (:...msIds))`,
          { msIds: filters.milestoneIds },
        );
      }
      if (filters.provinceStrategyIds?.length) {
        qb.andWhere(
          `EXISTS (SELECT 1 FROM plan_province_strategy pps WHERE pps.plan_id = plan.id AND pps.province_strategy_id IN (:...psIds))`,
          { psIds: filters.provinceStrategyIds },
        );
      }

      qb.orderBy('plan.id', 'ASC');
      return await qb.getMany();
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Authority gate mirrors `SdgService.assertAdminOrSuperAdmin`. Required
   * dimensions per CLAUDE.md PERMISSION MODEL: current/latest WorkHistory,
   * `workStatus = approved`, role IN {admin, super-admin}.
   *
   * NOTE: ownership is NOT checked — mapping replace is admin governance,
   * not an owner-scoped action (§4.1).
   */
  private async assertAdminOrSuperAdmin(
    userId: string,
    manager?: EntityManager,
  ): Promise<WorkHistory> {
    const repoLike = manager
      ? manager.getRepository(WorkHistory)
      : this.workHistoryRepo;
    const workHistory = await repoLike.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: ['workStatus', 'role', 'user'],
    });

    if (!workHistory) {
      throw new NotFoundException('ไม่พบข้อมูล WorkHistory ของผู้ใช้งาน');
    }
    if (workHistory.workStatus?.name?.toLowerCase() !== 'approved') {
      throw new ForbiddenException('สิทธิ์การใช้งานของคุณไม่ใช่ approved');
    }

    const roleName = workHistory.role?.name?.toLowerCase();
    const allowed = ['admin', 'super_admin', 'super-admin'];
    if (!roleName || !allowed.includes(roleName)) {
      throw new ForbiddenException(
        'เฉพาะ admin / super-admin เท่านั้นที่จัดการ Strategic Graph mapping ได้',
      );
    }
    return workHistory;
  }
}
