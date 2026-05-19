import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ProjectAlignmentMapping } from './entities/project-alignment-mapping.entity';

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
  nationalStrategy: { id: string; code: string | null; nameTh: string };
  milestone: { id: string; code: string | null; nameTh: string };
  sdg: { id: string; code: string | null; nameTh: string };
  provinceStrategy: { id: string; code: string | null; nameTh: string };
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

    return {
      strategyId: row.strategyId,
      tacticId: row.tacticId,
      planId: row.planId,
      nationalStrategyId: row.nationalStrategyId,
      milestoneId: row.milestoneId,
      sdgId: row.sdgId,
      provinceStrategyId: row.provinceStrategyId,
      nationalStrategy: {
        id: row.nationalStrategy.id,
        code: row.nationalStrategy.code ?? null,
        nameTh: row.nationalStrategy.nameTh,
      },
      milestone: {
        id: row.milestone.id,
        code: row.milestone.code ?? null,
        nameTh: row.milestone.nameTh,
      },
      sdg: {
        id: row.sdg.id,
        code: row.sdg.code ?? null,
        nameTh: row.sdg.nameTh,
      },
      provinceStrategy: {
        id: row.provinceStrategy.id,
        code: row.provinceStrategy.code ?? null,
        nameTh: row.provinceStrategy.nameTh,
      },
      updatedAt: row.updatedAt,
      updatedById: row.updatedById,
      updatedByDisplayName,
    };
  }
}
