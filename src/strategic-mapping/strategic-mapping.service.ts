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
import { User } from 'src/users/entities/user.entity';
import { handleException } from 'src/util/handleException';

import { MilestoneSdg } from './entities/milestone-sdg.entity';
import { ProvinceStrategySdg } from './entities/province-strategy-sdg.entity';
import { NationalStrategyMilestone } from './entities/national-strategy-milestone.entity';

/**
 * Strategic Graph BE-04 — Inter-master mapping replace API.
 *
 * Routes (mounted by `StrategicMappingController`):
 *   POST /v1/strategic-graph/mapping/:type  (write — replace mode, admin)
 *   GET  /v1/strategic-graph/mapping/:type?sourceId=  (read — any auth)
 *
 * Three `:type` values are dispatched via `TYPE_DISPATCH` (chain order):
 *   - national-strategy-milestone   (chain step 1: NS → MS)
 *   - milestone-sdg                 (chain step 2: MS → SDG)
 *   - province-strategy-sdg         (chain step 3: SDG ↔ PS)
 *
 * Cleanup history (2026-05-18): the original design included three
 * cross-link types (`sdg-national-strategy`, `province-strategy-
 * national-strategy`, `milestone-province-strategy`) plus their
 * junction tables. Per user direction the schema was narrowed to the
 * strict NS→MS→SDG→PS chain. Backup of the dropped rows is preserved
 * at `backups/strategic_cross_links_2026-05-18.sql`.
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
  | 'national-strategy-milestone'
  | 'milestone-sdg'
  | 'province-strategy-sdg';

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
  'national-strategy-milestone': {
    entity: NationalStrategyMilestone,
    sourceCol: 'nationalStrategyId',
    targetCol: 'milestoneId',
    sourceMaster: NationalStrategy,
    targetMaster: Milestone,
    sourceMasterLabel: 'NationalStrategy',
    targetMasterLabel: 'Milestone',
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
};

export interface ReplaceMappingResult {
  count: number;
  /**
   * QA-MATRIX-01 H-1: canonical, deduplicated, sorted-ASC target id set
   * AFTER all writes complete. The matrix FE uses this value as the
   * server-authoritative clamp on its per-row optimistic state — without
   * it, every successful commit visually reverts to empty. Backward
   * compatible: existing callers may ignore the new field.
   */
  targetIds: string[];
  updatedAt: Date;
  updatedById: string;
  /**
   * QA-MATRIX-01 M-1: pre-projected `firstname lastname` for the writer
   * so the audit footer renders a human name instead of a raw UUID.
   * `null` when the user row cannot be resolved (deleted / missing).
   */
  updatedByDisplayName: string | null;
}

export interface GetMappingResult {
  sourceId: string;
  targetIds: string[];
  updatedAt: Date | null;
  updatedById: string | null;
}

export interface MatrixSnapshotRow {
  sourceId: string;
  targetIds: string[];
}

export interface MatrixSnapshotResult {
  type: string;
  rows: MatrixSnapshotRow[];
  updatedAt: Date | null;
  updatedById: string | null;
  /**
   * QA-MATRIX-01 M-1: pre-projected `firstname lastname` matching the
   * row that produced `updatedAt`. `null` when the table is empty or the
   * user row cannot be resolved.
   */
  updatedByDisplayName: string | null;
}

// CLEANUP 2026-05-18: removed PlanMappingsResult / PlanDimensionConfig /
// PLAN_DIMENSIONS — backed `replacePlanMappings` / `getPlanMappings` /
// `filterPlans` (BE-05/BE-06), all dropped along with their orphan
// plan_* junction tables.

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

        // QA-MATRIX-01 H-1 + M-1: canonical sorted targetIds for the FE
        // clamp, plus a pre-projected display name so the audit footer
        // does not render a raw UUID. Single SELECT join — no N+1.
        const canonicalTargetIds = [...dedupedTargetIds].sort();
        const writer = await manager.getRepository(User).findOne({
          where: { id: userId },
          select: { id: true, firstname: true, lastname: true },
        });
        const updatedByDisplayName = writer
          ? `${writer.firstname} ${writer.lastname}`
          : null;

        return {
          count: dedupedTargetIds.length,
          targetIds: canonicalTargetIds,
          updatedAt: now,
          updatedById: userId,
          updatedByDisplayName,
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
   * BE-MATRIX-01 — full inter-master snapshot read.
   *
   * Returns ALL existing (sourceId, targetIds[]) pairs for one of the four
   * inter-master relation types in a single round-trip, shaped for the
   * matrix view (`StrategicGraphMatrixPage`).
   *
   * Contract (task §7.1):
   *   - `rows[]` sorted ascending by `sourceId` (stable).
   *   - `targetIds[]` within each row sorted ascending by `targetId`
   *     (stable). Achieved via the find() `order` clause below.
   *   - Sources with zero mappings are omitted (frontend treats absent
   *     sourceIds as an empty array).
   *   - `updatedAt` is the max `updated_at` across all rows; `updatedById`
   *     is the `updated_by` of that latest row. Both are null when the
   *     table is empty.
   *
   * Authority: any authenticated user (controller-level JwtAuthGuard).
   * §12: pure read; no TrackingStatus interaction. §17.2: no AI gating.
   */
  async getAllMappings(type: string): Promise<MatrixSnapshotResult> {
    try {
      const config = this.resolveConfig(type);
      const repo = this.dataSource.getRepository(config.entity);

      // QA-MATRIX-01 M-1: eager-load `updatedBy` so the audit footer
      // can render `firstname lastname` directly without a second
      // /users/:id call. Single SELECT join — no N+1.
      const all = await repo.find({
        order: {
          [config.sourceCol]: 'ASC',
          [config.targetCol]: 'ASC',
        } as any,
        relations: ['updatedBy'],
      });

      const bySource = new Map<string, string[]>();
      let latestAt: Date | null = null;
      let latestById: string | null = null;
      let latestByDisplayName: string | null = null;
      for (const r of all as any[]) {
        const sid = r[config.sourceCol] as string;
        const tid = r[config.targetCol] as string;
        if (!bySource.has(sid)) bySource.set(sid, []);
        bySource.get(sid)!.push(tid);
        const rUpdatedAt = r.updatedAt as Date | undefined;
        if (rUpdatedAt && (!latestAt || rUpdatedAt > latestAt)) {
          latestAt = rUpdatedAt;
          latestById = (r.updatedById as string | null) ?? null;
          const writer = r.updatedBy as
            | { firstname?: string; lastname?: string }
            | null
            | undefined;
          latestByDisplayName =
            writer && writer.firstname != null && writer.lastname != null
              ? `${writer.firstname} ${writer.lastname}`
              : null;
        }
      }

      const rows: MatrixSnapshotRow[] = Array.from(bySource.entries())
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([sourceId, targetIds]) => ({ sourceId, targetIds }));

      return {
        type,
        rows,
        updatedAt: latestAt,
        updatedById: latestById,
        updatedByDisplayName: latestByDisplayName,
      };
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
