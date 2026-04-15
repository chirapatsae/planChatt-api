import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { Budget } from 'src/budget/entities/budget.entity';
import { GeoBoundaryService } from './geo-boundary.service';
import { GenerateProjectDto } from './dto/generate-project.dto';
import {
  CoordinateContextService,
  CoordinateContext,
  InferredAreaType,
} from './coordinate-context.service';
import {
  classifyProjectType,
  ClassifiedProjectType,
} from './utils/project-type-classifier';
import {
  evaluateMismatch,
  CoordinateAdvisory,
} from './utils/mismatch-advisor';

export interface SimilarProject {
  title: string;
  budget?: number;
}

export interface BudgetStats {
  avgBudget: number;
  minBudget: number;
  maxBudget: number;
  count: number;
}

export interface CoordinateContextSummary {
  isInsideBoundary: boolean | null;
  inferredAreaType: InferredAreaType;
  nearbyProjectsCount: number;
  isLikelyEmptyArea: boolean;
  within1km: number;
  within3km: number;
  within10km: number;
  nearestProjectDistanceKm: number | null;
}

export interface AiEnrichedContext {
  amphoeName: string | null;
  laoName: string | null;
  isInsideBoundary: boolean | null;
  areaTypeHint: string | null;
  similarProjects: SimilarProject[];
  budgetStats: BudgetStats | null;
  developmentIssueName: string | null;
  coordinateContext?: CoordinateContextSummary;
  coordinateAdvisory?: CoordinateAdvisory;
  classifiedProjectType?: ClassifiedProjectType | null;
}

@Injectable()
export class AiContextService {
  private readonly logger = new Logger(AiContextService.name);

  constructor(
    @InjectRepository(Amphoe)
    private readonly amphoeRepo: Repository<Amphoe>,
    @InjectRepository(LocalAdministrativeOrganization)
    private readonly laoRepo: Repository<LocalAdministrativeOrganization>,
    @InjectRepository(DevelopmentIssue)
    private readonly developmentIssueRepo: Repository<DevelopmentIssue>,
    @InjectRepository(ProjectGroup)
    private readonly projectGroupRepo: Repository<ProjectGroup>,
    @InjectRepository(Budget)
    private readonly budgetRepo: Repository<Budget>,
    private readonly geoBoundaryService: GeoBoundaryService,
    private readonly coordinateContextService: CoordinateContextService,
  ) {}

  async enrichContext(dto: GenerateProjectDto): Promise<AiEnrichedContext> {
    const result: AiEnrichedContext = {
      amphoeName: null,
      laoName: null,
      isInsideBoundary: null,
      areaTypeHint: null,
      similarProjects: [],
      budgetStats: null,
      developmentIssueName: dto.developmentIssueName || null,
    };

    try {
      // Run independent lookups in parallel
      const [amphoe, lao, developmentIssue] = await Promise.all([
        this.resolveAmphoe(dto.amphoeId),
        this.resolveLao(dto.localAdministrativeOrganizationId),
        this.resolveDevelopmentIssue(dto.developmentIssueId),
      ]);

      if (amphoe) {
        result.amphoeName = amphoe.name;
      }

      if (lao) {
        result.laoName = lao.name;
      }

      if (developmentIssue && !result.developmentIssueName) {
        result.developmentIssueName = developmentIssue.name;
      }

      // Check if coordinates are inside amphoe boundary
      const lat = dto.startLat ? parseFloat(dto.startLat) : NaN;
      const lng = dto.startLng ? parseFloat(dto.startLng) : NaN;
      if (Number.isFinite(lat) && Number.isFinite(lng) && dto.amphoeId) {
        result.isInsideBoundary = this.geoBoundaryService.isPointInsideAmphoe(
          lat,
          lng,
          dto.amphoeId,
        );
      }

      // Area type hint from GeoJSON properties (graceful fallback)
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        result.areaTypeHint = this.getAreaTypeHint(lat, lng);
      }

      // Find similar approved projects and budget stats
      const [similarProjects, budgetStats] = await Promise.all([
        this.findSimilarProjects(dto),
        this.getBudgetStats(dto),
      ]);
      result.similarProjects = similarProjects;
      result.budgetStats = budgetStats;

      // Coordinate context enrichment + mismatch advisory (soft, §13).
      try {
        let coordContext: CoordinateContext | null = null;
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          coordContext =
            await this.coordinateContextService.getCoordinateContext(
              lat,
              lng,
              dto.amphoeId,
            );

          result.coordinateContext = {
            isInsideBoundary: coordContext.isInsideBoundary,
            inferredAreaType: coordContext.inferredAreaType,
            nearbyProjectsCount: coordContext.nearbyProjects.length,
            isLikelyEmptyArea: coordContext.isLikelyEmptyArea,
            within1km: coordContext.densityCounts.within1km,
            within3km: coordContext.densityCounts.within3km,
            within10km: coordContext.densityCounts.within10km,
            nearestProjectDistanceKm: coordContext.nearestProjectDistanceKm,
          };
        }

        // Classify project type from user prompt + classification metadata.
        const classifierText = [
          dto.userPrompt,
          dto.developmentIssueName,
          dto.strategy,
          dto.tactic,
          dto.plan,
        ]
          .filter(Boolean)
          .join(' ');
        const classified = classifierText
          ? classifyProjectType(classifierText)
          : null;
        result.classifiedProjectType = classified;

        // Produce advisory only when we have at least a coordinate context.
        if (coordContext) {
          result.coordinateAdvisory = evaluateMismatch(
            classified,
            coordContext,
          );
        }
      } catch (advisoryError) {
        this.logger.warn(
          `Coordinate advisory enrichment failed: ${advisoryError instanceof Error ? advisoryError.message : advisoryError}`,
        );
        // Graceful degradation — continue without coordinate advisory.
      }
    } catch (error) {
      this.logger.warn(
        `Failed to enrich AI context: ${error instanceof Error ? error.message : error}`,
      );
      // Return partial results - enrichment failure should not block generation
    }

    return result;
  }

  private async resolveAmphoe(amphoeId?: string): Promise<Amphoe | null> {
    if (!amphoeId) return null;
    const amphoe = await this.amphoeRepo.findOne({ where: { id: amphoeId } });
    return amphoe || null;
  }

  private async resolveLao(
    laoId?: string,
  ): Promise<LocalAdministrativeOrganization | null> {
    if (!laoId) return null;
    const lao = await this.laoRepo.findOne({ where: { id: laoId } });
    return lao || null;
  }

  private async resolveDevelopmentIssue(
    issueId?: string,
  ): Promise<DevelopmentIssue | null> {
    if (!issueId) return null;
    const issue = await this.developmentIssueRepo.findOne({
      where: { id: issueId },
    });
    return issue || null;
  }

  /**
   * Find similar approved projects in the same amphoe with matching
   * classification (strategy or development issue).
   * Uses TypeORM QueryBuilder per DB agent recommendation.
   */
  private async findSimilarProjects(
    dto: GenerateProjectDto,
  ): Promise<SimilarProject[]> {
    if (!dto.amphoeId) return [];

    try {
      const qb = this.projectGroupRepo
        .createQueryBuilder('pg')
        .select(['pg.id', 'pg.title'])
        .innerJoin('pg.trackingStatus', 'ts')
        .innerJoin('ts.statusId', 'st')
        .where('pg.amphoe = :amphoeId', { amphoeId: dto.amphoeId })
        .andWhere('ts.isLatest = :isLatest', { isLatest: true })
        .andWhere('st.name = :statusName', { statusName: 'Approved' })
        .andWhere('pg.deletedAt IS NULL');

      if (dto.reportFormat === 'ISSUE_BASED' && dto.developmentIssueId) {
        qb.andWhere('pg.developmentIssue = :issueId', {
          issueId: dto.developmentIssueId,
        });
      } else if (dto.strategy) {
        // For STRATEGY_BASED, join on strategy name match
        qb.innerJoin('pg.strategy', 'strat').andWhere(
          'strat.name = :strategyName',
          { strategyName: dto.strategy },
        );
      }

      qb.orderBy('pg.createdAt', 'DESC').limit(5);

      const projects = await qb.getMany();
      return projects.map((p) => ({ title: p.title }));
    } catch (error) {
      this.logger.warn(
        `Failed to find similar projects: ${error instanceof Error ? error.message : error}`,
      );
      return [];
    }
  }

  /**
   * Compute budget statistics from similar approved projects.
   * Queries the budget table joined with project_groups and tracking_status.
   */
  private async getBudgetStats(
    dto: GenerateProjectDto,
  ): Promise<BudgetStats | null> {
    if (!dto.amphoeId) return null;

    try {
      const qb = this.budgetRepo
        .createQueryBuilder('b')
        .select('AVG(b.quantity)', 'avgBudget')
        .addSelect('MIN(b.quantity)', 'minBudget')
        .addSelect('MAX(b.quantity)', 'maxBudget')
        .addSelect('COUNT(DISTINCT pg.id)', 'count')
        .innerJoin('b.projectGroupId', 'pg')
        .innerJoin('pg.trackingStatus', 'ts')
        .innerJoin('ts.statusId', 'st')
        .where('pg.amphoe = :amphoeId', { amphoeId: dto.amphoeId })
        .andWhere('ts.isLatest = :isLatest', { isLatest: true })
        .andWhere('st.name = :statusName', { statusName: 'Approved' })
        .andWhere('pg.deletedAt IS NULL');

      if (dto.reportFormat === 'ISSUE_BASED' && dto.developmentIssueId) {
        qb.andWhere('pg.developmentIssue = :issueId', {
          issueId: dto.developmentIssueId,
        });
      } else if (dto.strategy) {
        qb.innerJoin('pg.strategy', 'strat').andWhere(
          'strat.name = :strategyName',
          { strategyName: dto.strategy },
        );
      }

      const raw = await qb.getRawOne();

      if (!raw || !raw.count || Number(raw.count) === 0) {
        return null;
      }

      return {
        avgBudget: Math.round(Number(raw.avgBudget) || 0),
        minBudget: Math.round(Number(raw.minBudget) || 0),
        maxBudget: Math.round(Number(raw.maxBudget) || 0),
        count: Number(raw.count),
      };
    } catch (error) {
      this.logger.warn(
        `Failed to get budget stats: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  /**
   * Determine area type hint from coordinates.
   * Current GeoJSON may not contain area-type properties --
   * this is a best-effort hint with graceful fallback.
   */
  private getAreaTypeHint(_lat: number, _lng: number): string | null {
    // Current GeoJSON does not contain area-type metadata.
    // Return null to indicate unknown; AI prompt will omit this line.
    // Future enhancement: query land-use layer or GeoJSON properties
    // for area classification (urban/agricultural/forest/water/mountain).
    return null;
  }
}
