import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ProjectAlignmentMapping } from './entities/project-alignment-mapping.entity';
import {
  projectDimension,
  DimensionMasterRef,
} from './internal/project-dimension.helper';

export interface AlignmentLookupResult {
  strategyId: string;
  tacticId: string;
  planId: string;
  nationalStrategyId: string;
  milestoneId: string;
  sdgId: string;
  provinceStrategyId: string;
  // Pre-projected codes + names so the FE can render the result card
  // without a second round-trip per master.

  /**
   * @deprecated FOR NEW CODE — kept for backward compatibility only.
   * Mirrors `nationalStrategies[0]` as a pure implementation artifact;
   * carries NO business meaning of "primary" / "ordering" / "priority".
   * New code MUST read `nationalStrategies[]` instead.
   * @see docs/tasks/wave-multi-national-strategy-per-alignment/README.md
   *      §Scalar-FK Deprecation Contract
   */
  nationalStrategy: { id: string; code: string | null; nameTh: string };

  /**
   * SOURCE OF TRUTH for ยุทธศาสตร์ชาติ on this alignment row.
   * ORDERED by `sort_order ASC, code ASC`. Length ≥ 1 (the back-compat
   * scalar always occupies index 0).
   * Use this for ALL new read paths. The scalar `nationalStrategy`
   * field is @deprecated and retained only for backward compatibility
   * — see
   * `docs/tasks/wave-multi-national-strategy-per-alignment/README.md`
   * §Scalar-FK Deprecation Contract.
   */
  nationalStrategies: DimensionMasterRef[];

  /**
   * Milestone — stays scalar (no multi-value rows in current data;
   * single-valued by domain). No deprecation tag — this remains the
   * canonical read field.
   */
  milestone: { id: string; code: string | null; nameTh: string };

  /**
   * @deprecated FOR NEW CODE — kept for backward compatibility only.
   * Mirrors `sdgs[0]` as a pure implementation artifact; carries NO
   * business meaning of "primary" / "ordering" / "priority".
   * New code MUST read `sdgs[]` instead.
   * @see docs/tasks/wave-multi-national-strategy-per-alignment/README.md
   *      §Scalar-FK Deprecation Contract
   */
  sdg: { id: string; code: string | null; nameTh: string };

  /**
   * SOURCE OF TRUTH for SDG on this alignment row.
   * ORDERED by `sort_order ASC, code ASC`. Length ≥ 1 (the back-compat
   * scalar always occupies index 0).
   * Use this for ALL new read paths. The scalar `sdg` field is
   * @deprecated and retained only for backward compatibility — see
   * `docs/tasks/wave-multi-national-strategy-per-alignment/README.md`
   * §Scalar-FK Deprecation Contract.
   */
  sdgs: DimensionMasterRef[];

  /**
   * @deprecated FOR NEW CODE — kept for backward compatibility only.
   * Mirrors `provinceStrategies[0]` as a pure implementation artifact;
   * carries NO business meaning of "primary" / "ordering" / "priority".
   * New code MUST read `provinceStrategies[]` instead.
   * @see docs/tasks/wave-multi-national-strategy-per-alignment/README.md
   *      §Scalar-FK Deprecation Contract
   */
  provinceStrategy: { id: string; code: string | null; nameTh: string };

  /**
   * SOURCE OF TRUTH for ยุทธศาสตร์จังหวัด on this alignment row.
   * ORDERED by `sort_order ASC, code ASC`. Length ≥ 1 (the back-compat
   * scalar always occupies index 0).
   * Use this for ALL new read paths. The scalar `provinceStrategy`
   * field is @deprecated and retained only for backward compatibility
   * — see
   * `docs/tasks/wave-multi-national-strategy-per-alignment/README.md`
   * §Scalar-FK Deprecation Contract.
   */
  provinceStrategies: DimensionMasterRef[];

  updatedAt: Date;
  updatedById: string | null;
  updatedByDisplayName: string | null;
}

/**
 * ProjectAlignmentMappingService — read-only lookup service.
 *
 * Single endpoint behaviour: given the triple `(strategyId, tacticId,
 * planId)`, return the unique alignment row or 404. Any auth user
 * (BE controller layer JwtAuthGuard).
 *
 * §4.1 — this is a read; ownership is not relevant. Future write
 * endpoints (admin-only) would belong in this same service.
 * §12 — config rows; NO TrackingStatus interaction.
 *
 * Wave multi-national-strategy-per-alignment: the lookup result now
 * carries 3 array projections (`nationalStrategies`, `sdgs`,
 * `provinceStrategies`) alongside the legacy scalar fields. FE
 * compatibility is preserved (scalars remain populated, set to
 * `arrays[0]`).
 */
@Injectable()
export class ProjectAlignmentMappingService {
  private readonly logger = new Logger(ProjectAlignmentMappingService.name);

  constructor(
    @InjectRepository(ProjectAlignmentMapping)
    private readonly repo: Repository<ProjectAlignmentMapping>,
  ) {}

  async lookup(
    strategyId: string,
    tacticId: string,
    planId: string,
  ): Promise<AlignmentLookupResult> {
    if (!strategyId || !tacticId || !planId) {
      throw new BadRequestException(
        'strategyId, tacticId, and planId are all required',
      );
    }

    const row = await this.repo.findOne({
      where: { strategyId, tacticId, planId },
      relations: [
        'nationalStrategy',
        'milestone',
        'sdg',
        'provinceStrategy',
        // Junction back-refs + nested master refs (Wave
        // multi-national-strategy-per-alignment). Required for the 3
        // array projections shipped on this DTO.
        'nationalStrategies',
        'nationalStrategies.nationalStrategy',
        'sdgs',
        'sdgs.sdg',
        'provinceStrategies',
        'provinceStrategies.provinceStrategy',
        'updatedBy',
      ],
    });

    if (!row) {
      throw new NotFoundException(
        `ALIGNMENT_NOT_FOUND: no mapping for strategy=${strategyId} tactic=${tacticId} plan=${planId}`,
      );
    }

    const writer = row.updatedBy;
    const updatedByDisplayName =
      writer && writer.firstname != null && writer.lastname != null
        ? `${writer.firstname} ${writer.lastname}`
        : null;

    // Build the 3 dimension arrays via the shared helper (same
    // primary-first / sortOrder-ASC / dedup-by-id projection used by
    // AlignmentResolverService — Scalar-FK Deprecation Contract §3).
    const nationalStrategies = projectDimension(
      row.nationalStrategy,
      row.nationalStrategies,
      'nationalStrategy',
    );
    const sdgs = projectDimension(row.sdg, row.sdgs, 'sdg');
    const provinceStrategies = projectDimension(
      row.provinceStrategy,
      row.provinceStrategies,
      'provinceStrategy',
    );

    return {
      strategyId: row.strategyId,
      tacticId: row.tacticId,
      planId: row.planId,
      nationalStrategyId: row.nationalStrategyId,
      milestoneId: row.milestoneId,
      sdgId: row.sdgId,
      provinceStrategyId: row.provinceStrategyId,
      // Back-compat scalars — equal to arrays[0]. @deprecated; new
      // code MUST read the array fields instead.
      nationalStrategy: nationalStrategies[0],
      sdg: sdgs[0],
      provinceStrategy: provinceStrategies[0],
      // Source-of-truth arrays.
      nationalStrategies,
      sdgs,
      provinceStrategies,
      // Milestone — stays scalar (single-valued by domain).
      milestone: {
        id: row.milestone.id,
        code: row.milestone.code ?? null,
        nameTh: row.milestone.nameTh,
      },
      updatedAt: row.updatedAt,
      updatedById: row.updatedById,
      updatedByDisplayName,
    };
  }
}
