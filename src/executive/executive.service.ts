import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateExecutiveDto } from './dto/create-executive.dto';
import { UpdateExecutiveDto } from './dto/update-executive.dto';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { STATUS_NAMES } from 'src/common/status-names';
import { EXECUTIVE_EXCLUDED_STATUS_NAMES } from 'src/ai-executive-chat/aggregation/constants/executive-status-groups';

/**
 * Wave 43 — Team Dashboard scope extension.
 *
 * The dashboard historically aggregated staff workload across `ProjectGroup`
 * (main plan) only. Wave 43 adds optional aggregation of
 * `RevisedProjectGroup` (edit + change) and `SupplementProjectGroup` under
 * the same per-staff responsibility partition.
 *
 * Contract (see docs/tasks/TEAM_DASHBOARD_SCOPE_EXTEND_BACKEND.md):
 *   - `scope=main` → payload is byte-identical to the pre-Wave-43 shape.
 *     No `scope`, no `byScope`, no `sourceType` fields.
 *   - Any other scope (`all | revision | supplement`) → union aggregation
 *     with `scope` echoed at top-level AND `byScope` breakdown. Per-project
 *     items under agency / amphoe buckets carry a `sourceType` discriminator
 *     of `'main' | 'revision-edit' | 'revision-change' | 'supplement'`.
 */
export const TEAM_DASHBOARD_SCOPES = [
  'main',
  'revision-edit',
  'revision-change',
  'supplement',
] as const;
export type TeamDashboardScope = (typeof TEAM_DASHBOARD_SCOPES)[number];

type SourceType = 'main' | 'revision-edit' | 'revision-change' | 'supplement';

/**
 * Per-source counter bundle used inside `byScope`. Kept orthogonal to the
 * legacy top-level totals so that N3 snapshot tests can assert
 * byte-identical behavior on `scope=main`.
 */
interface SourceCounters {
  projectGroupCount: number;
  approveCount: number;
  inProgressCount: number;
}

const EMPTY_COUNTERS = (): SourceCounters => ({
  projectGroupCount: 0,
  approveCount: 0,
  inProgressCount: 0,
});

@Injectable()
export class ExecutiveService {
  private readonly logger = new Logger(ExecutiveService.name);

  constructor(
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,
    @InjectRepository(ProjectGroup)
    private readonly projectGroupRepo: Repository<ProjectGroup>,
    @InjectRepository(DevelopmentPlan)
    private readonly developmentPlanRepo: Repository<DevelopmentPlan>,
    @InjectRepository(RevisedProjectGroup)
    private readonly revisedProjectGroupRepo: Repository<RevisedProjectGroup>,
    @InjectRepository(SupplementProjectGroup)
    private readonly supplementProjectGroupRepo: Repository<SupplementProjectGroup>,
  ) { }

  create(createExecutiveDto: CreateExecutiveDto) {
    return 'This action adds a new executive';
  }

  findAll() {
    return `This action returns all executive`;
  }

  findOne(id: number) {
    return `This action returns a #${id} executive`;
  }

  update(id: number, updateExecutiveDto: UpdateExecutiveDto) {
    return `This action updates a #${id} executive`;
  }

  remove(id: number) {
    return `This action removes a #${id} executive`;
  }

  /**
   * Dispatch entry point. Resolves auth / work-history / role gate once,
   * then delegates to the scope-specific aggregator.
   *
   * `scope=main` takes the legacy code path verbatim — this is the
   * byte-identical regression guarantee for N3.
   */
  async getTeamDashboard(userId: string, scope: TeamDashboardScope = 'main') {
    if (scope === 'main') {
      return this.getTeamDashboardMainLegacy(userId);
    }
    return this.getTeamDashboardUnion(userId, scope);
  }

  /**
   * LEGACY PATH — pre-Wave-43 behavior, byte-identical.
   *
   * Kept as a private method so the public entry point can dispatch on
   * scope without branching inside the aggregation. DO NOT modify the
   * output shape of this method — N3 snapshot asserts equality with the
   * pre-Wave-43 response.
   */
  private async getTeamDashboardMainLegacy(userId: string) {
    // 1. Get Current User's WorkHistory to determine scope
    const currentUserWH = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: ['localAdministrativeOrganization', 'governmentAgencies', 'role'],
    });

    if (!currentUserWH) {
      throw new NotFoundException('Work history not found for current user');
    }
    if (currentUserWH.role.name !== 'staff' && currentUserWH.role.name !== "admin" && currentUserWH.role.name !== 'super-admin') {
      throw new UnauthorizedException("You are not authorized to access this feature");
    }
    const developmentPlan = await this.developmentPlanRepo.findOne({
      where: ({
        isLatest: true,
        isBooked: false
      })
    })

    const [staffRole, staffCount] = await this.workHistoryRepo
      .createQueryBuilder('wh')
      .leftJoinAndSelect('wh.user', 'user')
      .leftJoinAndSelect('wh.role', 'role')
      .leftJoinAndSelect('wh.localAdministrativeOrganization', 'lao')
      .leftJoinAndSelect('wh.amphoe', 'amphoes')
      .leftJoinAndSelect('wh.governmentAgencies', 'ga')

      // ✅ join responsibility amphoe
      .leftJoinAndSelect('wh.workHistoryResponsibleAmphoe', 'wha')
      .leftJoinAndSelect('wha.amphoe', 'amphoe')
      .leftJoinAndSelect('wh.workHistoryResponsibleGovernmentAgency', 'whga')
      .leftJoinAndSelect('whga.governmentAgency', 'governmentAgency')

      // amphoe count
      .loadRelationCountAndMap(
        'wh.amphoeCount',
        'wh.workHistoryResponsibleAmphoe'
      )

      // 🔥 LAO count inside amphoe
      .loadRelationCountAndMap(
        'amphoe.laoCount',
        'amphoe.localAdministrativeOrganization'
      )

      // agency count
      .loadRelationCountAndMap(
        'wh.agencyCount',
        'wh.workHistoryResponsibleGovernmentAgency'
      )

      // Project Count & List for Amphoe
      .leftJoinAndSelect(
        'amphoe.projectGroups',
        'amphoeProjects',
        'amphoeProjects.origin_agency_id IS NOT NULL AND amphoeProjects.isDraft = :isDraft AND amphoeProjects.development_plan_id = :devPlanId AND amphoeProjects.isBooked = :isBooked AND amphoeProjects.deletedAt IS NULL'
      )
      .leftJoinAndSelect('amphoeProjects.trackingStatus', 'apTs', 'apTs.isLatest = :isLatest')
      .leftJoinAndSelect('apTs.statusId', 'apStatus')
      .leftJoinAndSelect('amphoeProjects.createdBy', 'apCreatedBy')
      .leftJoinAndSelect('apCreatedBy.user', 'apUser')

      // Project Count & List for Government Agency
      .leftJoinAndSelect(
        'governmentAgency.responsibleAgencyProjectGroup',
        'gaProjects',
        'gaProjects.origin_agency_id IS NULL AND gaProjects.isDraft = :isDraft AND gaProjects.development_plan_id = :devPlanId AND gaProjects.isBooked = :isBooked AND gaProjects.deletedAt IS NULL'
      )
      .leftJoinAndSelect('gaProjects.trackingStatus', 'gaTs', 'gaTs.isLatest = :isLatest')
      .leftJoinAndSelect('gaTs.statusId', 'gaStatus')
      .leftJoinAndSelect('gaProjects.createdBy', 'gaCreatedBy')
      .leftJoinAndSelect('gaCreatedBy.user', 'gaUser')

      .where('role.name = :role', { role: 'staff' })
      .andWhere('wh.isCurrent = true')
      .setParameters({ isDraft: false, devPlanId: developmentPlan?.id, isLatest: true, isBooked: false })

      .getManyAndCount();

    const staffWithTotalLao = staffRole.map(staff => {
      // Calculate Status Counts for Amphoe Responsibility
      if (staff.workHistoryResponsibleAmphoe) {
        staff.workHistoryResponsibleAmphoe.forEach(item => {
          if (item.amphoe) {
            const counts = {
              Pending: 0,
              Rejected: 0,
              [STATUS_NAMES.RETURNED_FOR_REVISION]: 0,
              Approved: 0,
              Pending_Approval: 0,
              Verified: 0
            };
            const aging = {
              Pending: { total: 0, count: 0, details: [] },
              Rejected: { total: 0, count: 0, details: [] },
              [STATUS_NAMES.RETURNED_FOR_REVISION]: { total: 0, count: 0, details: [] },
              Approved: { total: 0, count: 0, details: [] },
              Pending_Approval: { total: 0, count: 0, details: [] },
              Verified: { total: 0, count: 0, details: [] }
            };

            const allProjects = item.amphoe.projectGroups || [];
            // Wave 24 — dual-set split:
            //   tileProjects        — drops Ready only; preserves
            //                         Returned_For_Revision so the per-staff
            //                         "รอแก้ไข" tile keeps populating per
            //                         FIX_EXECUTIVE_STATUS_COUNTS_RETURNED_FOR_REVISION.
            //   executiveProjects   — drops Ready + Pull_Back +
            //                         Returned_For_Revision per §3 W67;
            //                         drives the FE-shipped projectGroups
            //                         array and the projectCount on the
            //                         amphoe bucket.
            const tileProjects = allProjects.filter(p => {
              const latest = p.trackingStatus?.find(t => t.isLatest);
              return latest && latest.statusId && latest.statusId.name !== 'Ready';
            });
            const executiveProjects = allProjects.filter(p => {
              const latest = p.trackingStatus?.find(t => t.isLatest);
              return (
                latest &&
                latest.statusId &&
                !(EXECUTIVE_EXCLUDED_STATUS_NAMES as readonly string[]).includes(
                  latest.statusId.name,
                )
              );
            });

            tileProjects.forEach(p => {
              const latest = p.trackingStatus?.find(t => t.isLatest);
              if (latest && latest.statusId) {
                const statusName = latest.statusId.name;
                if (counts[statusName] !== undefined) {
                  counts[statusName]++;

                  // Aging
                  const diffTime = Math.abs(new Date().getTime() - new Date(latest.createAt).getTime());
                  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                  aging[statusName].total += diffDays;
                  aging[statusName].count++;

                  // Add Detail
                  aging[statusName].details.push({
                    id: p.id,
                    title: p.title,
                    aging: diffDays,
                    user: staff.user ? `${staff.user.prefix || ''} ${staff.user.firstname} ${staff.user.lastname}`.trim() : 'Unknown'
                  });
                }
              }
            });

            // Assign counts to amphoe (dynamically)
            // statusCounts/statusAging are populated from tileProjects above
            // so the Returned_For_Revision tile is preserved. The shipped
            // projectGroups array and projectCount use executiveProjects to
            // honor §3 W67.
            (item.amphoe as any).statusCounts = counts;
            (item.amphoe as any).projectCount = executiveProjects.length;
            (item.amphoe as any).projectGroups = executiveProjects;
            (item.amphoe as any).statusAging = Object.keys(aging).reduce((acc, key) => {
              acc[key] = {
                avgTime: aging[key].count > 0 ? (aging[key].total / aging[key].count).toFixed(2) : 0,
                details: aging[key].details
              };
              return acc;
            }, {});
          }
        });
      }

      // Calculate Status Counts for Government Agency Responsibility
      if (staff.workHistoryResponsibleGovernmentAgency) {
        staff.workHistoryResponsibleGovernmentAgency.forEach(item => {
          if (item.governmentAgency) {
            const counts = {
              Pending: 0,
              Rejected: 0,
              [STATUS_NAMES.RETURNED_FOR_REVISION]: 0,
              Approved: 0,
              Pending_Approval: 0,
              Verified: 0
            };
            const aging = {
              Pending: { total: 0, count: 0, details: [] },
              Rejected: { total: 0, count: 0, details: [] },
              [STATUS_NAMES.RETURNED_FOR_REVISION]: { total: 0, count: 0, details: [] },
              Approved: { total: 0, count: 0, details: [] },
              Pending_Approval: { total: 0, count: 0, details: [] },
              Verified: { total: 0, count: 0, details: [] }
            };

            const allProjects = item.governmentAgency.responsibleAgencyProjectGroup || [];
            // Wave 24 — same dual-set split as the amphoe block above.
            const tileProjects = allProjects.filter(p => {
              const latest = p.trackingStatus?.find(t => t.isLatest);
              return latest && latest.statusId && latest.statusId.name !== 'Ready';
            });
            const executiveProjects = allProjects.filter(p => {
              const latest = p.trackingStatus?.find(t => t.isLatest);
              return (
                latest &&
                latest.statusId &&
                !(EXECUTIVE_EXCLUDED_STATUS_NAMES as readonly string[]).includes(
                  latest.statusId.name,
                )
              );
            });

            tileProjects.forEach(p => {
              const latest = p.trackingStatus?.find(t => t.isLatest);
              if (latest && latest.statusId) {
                const statusName = latest.statusId.name;
                if (counts[statusName] !== undefined) {
                  counts[statusName]++;

                  // Aging
                  const diffTime = Math.abs(new Date().getTime() - new Date(latest.createAt).getTime());
                  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                  aging[statusName].total += diffDays;
                  aging[statusName].count++;

                  // Add Detail
                  aging[statusName].details.push({
                    id: p.id,
                    title: p.title,
                    aging: diffDays,
                    user: staff.user ? staff.user : 'Unknown'
                  });
                }
              }
            });

            // Assign counts to agency (dynamically)
            // tileProjects drives statusCounts/statusAging (preserves
            // Returned_For_Revision tile); executiveProjects drives the
            // FE-shipped projectGroups + projectCount per §3 W67.
            (item.governmentAgency as any).statusCounts = counts;
            (item.governmentAgency as any).projectCount = executiveProjects.length;
            (item.governmentAgency as any).responsibleAgencyProjectGroup = executiveProjects;
            (item.governmentAgency as any).statusAging = Object.keys(aging).reduce((acc, key) => {
              acc[key] = {
                avgTime: aging[key].count > 0 ? (aging[key].total / aging[key].count).toFixed(2) : 0,
                details: aging[key].details
              };
              return acc;
            }, {});
          }
        });
      }


      const totalLao = staff.workHistoryResponsibleAmphoe
        ?.reduce((sum, item) => {
          return sum + (item.amphoe?.laoCount || 0);
        }, 0) || 0;

      return {
        ...staff,
        totalLaoCount: totalLao
      };
    });
    let type: string = 'origin';



    const projectGroupCount = await this.projectGroupRepo
      .createQueryBuilder('pg')
      .innerJoin('pg.trackingStatus', 'ts')
      .innerJoin('ts.statusId', 'status')
      .where('pg.developmentPlan = :id', {
        id: developmentPlan?.id
      })
      // Wave 24 — §3 W67: exclude Ready / Pull_Back / Returned_For_Revision
      // from the executive-wide totals.
      .andWhere('status.name NOT IN (:...excludedStatusNames)', {
        excludedStatusNames: [...EXECUTIVE_EXCLUDED_STATUS_NAMES],
      })
      .andWhere('ts.isLatest = :isLatest', { isLatest: true })
      .andWhere('pg.isDraft = :isDraft', { isDraft: false })
      .getCount();

    const projectGroupApproveCount = await this.projectGroupRepo
      .createQueryBuilder('pg')
      .innerJoin('pg.trackingStatus', 'ts')
      .innerJoin('ts.statusId', 'status')
      .where('pg.developmentPlan = :id', {
        id: developmentPlan?.id
      })
      .andWhere('status.name = :status', {
        status: 'Approved'
      })
      .andWhere('ts.isLatest = :isLatest', { isLatest: true })
      .andWhere('pg.isDraft = :isDraft', { isDraft: false })
      .getCount();

    const projectGroupInprogressCount = await this.projectGroupRepo
      .createQueryBuilder('pg')
      .innerJoin('pg.trackingStatus', 'ts')
      .innerJoin('ts.statusId', 'status')
      .where('pg.developmentPlan = :id', {
        id: developmentPlan?.id
      })
      // Wave 24 — exclude Approved + executive-excluded states (§3 W67).
      .andWhere('status.name NOT IN (:...excludeStatuses)', {
        excludeStatuses: ['Approved', ...EXECUTIVE_EXCLUDED_STATUS_NAMES],
      })
      .andWhere('ts.isLatest = :isLatest', { isLatest: true })
      .andWhere('pg.isDraft = :isDraft', { isDraft: false })
      .getCount();



    // 2. Determine Staff Scope
    const query = this.workHistoryRepo.createQueryBuilder('wh')
      .leftJoinAndSelect('wh.user', 'user')
      .leftJoinAndSelect('wh.role', 'role')
      .leftJoinAndSelect('wh.localAdministrativeOrganization', 'lao')
      .leftJoinAndSelect('wh.governmentAgencies', 'agency')
      .where('wh.isCurrent = :isCurrent', { isCurrent: true })
      .andWhere('role.name = :roleName', { roleName: 'staff' });

    if (currentUserWH.localAdministrativeOrganization) {
      query.andWhere('wh.localAdministrativeOrganization.id = :laoId', { laoId: currentUserWH.localAdministrativeOrganization.id });
    } else if (currentUserWH.governmentAgencies) {
      query.andWhere('wh.governmentAgencies.id = :agencyId', { agencyId: currentUserWH.governmentAgencies.id });
    } else if (currentUserWH.role.name !== 'super-admin') {
      // If not super-admin and no agency, maybe return empty or self?
      // For now, let's restricted to self if no agency? Or allow all if super-admin.
      // logic: if not super admin, restrict to self if no org found (unlikely for executive)
      query.andWhere('wh.id = :whId', { whId: currentUserWH.id });
    }

    // 5. Construct Response
    return {
      staffWithTotalLao,
      staffCount,
      projectGroupCount,
      projectGroupApproveCount,
      projectGroupInprogressCount,
      type,
      developmentPlan,
    };
  }

  /**
   * Wave 43 — Union aggregator for non-`main` scopes.
   *
   * Strategy:
   *   1. Run the legacy path to get staff rows with main-plan decoration.
   *      For `scope=all` we keep the decoration as-is. For `scope=revision`
   *      / `scope=supplement` we zero out the main-scope project arrays
   *      and statusCounts/statusAging before re-populating them.
   *   2. Fetch RPG / SPG rows keyed by the agency ids already loaded onto
   *      each staff row and decorate the `responsibleAgency` bucket.
   *   3. Recompute statusCounts / statusAging per agency based on the
   *      active source set, tagging each project with `sourceType`.
   *   4. Compute per-source global counters for `byScope`.
   */
  private async getTeamDashboardUnion(userId: string, scope: TeamDashboardScope) {
    const legacy = await this.getTeamDashboardMainLegacy(userId);
    const developmentPlan: DevelopmentPlan | null = legacy.developmentPlan as any;

    // Post-dispatch refactor: the 'all' scope was removed per user request —
    // each scope is now pure (main / revision-edit / revision-change /
    // supplement). The `main` path still short-circuits to the legacy
    // byte-identical method at the top of `getTeamDashboard`, so by the
    // time we land here scope is one of the three non-main variants.
    const includeMain = false;
    const includeRevisionEdit = scope === 'revision-edit';
    const includeRevisionChange = scope === 'revision-change';
    const includeRevision = includeRevisionEdit || includeRevisionChange;
    const includeSupplement = scope === 'supplement';

    // Collect all agency ids and amphoe ids already loaded on the staff rows.
    const staffRows: any[] = legacy.staffWithTotalLao as any[];
    const agencyIdSet = new Set<string>();
    for (const staff of staffRows) {
      const agencyLinks = staff.workHistoryResponsibleGovernmentAgency || [];
      for (const link of agencyLinks) {
        if (link.governmentAgency?.id != null) {
          agencyIdSet.add(String(link.governmentAgency.id));
        }
      }
    }

    // Load RPG / SPG projects for the agencies-of-interest.
    const revisionRowsByAgency = includeRevision
      ? await this.loadRevisedProjectGroupsByAgency(
          developmentPlan?.id ?? null,
          Array.from(agencyIdSet),
        )
      : new Map<string, any[]>();
    const supplementRowsByAgency = includeSupplement
      ? await this.loadSupplementProjectGroupsByAgency(
          developmentPlan?.id ?? null,
          Array.from(agencyIdSet),
        )
      : new Map<string, any[]>();

    // Re-decorate each staff row: for non-main-including scopes we must
    // reset the main-plan arrays on the agency bucket so that status counts
    // reflect only the active source set.
    for (const staff of staffRows) {
      const agencyLinks = staff.workHistoryResponsibleGovernmentAgency || [];
      for (const link of agencyLinks) {
        if (!link.governmentAgency) continue;
        const agency = link.governmentAgency as any;
        const agencyId = String(agency.id);

        // Collect per-source project arrays. Tag each with sourceType.
        const mainProjects: any[] = includeMain
          ? (agency.responsibleAgencyProjectGroup || []).map((p: any) => ({
              ...p,
              sourceType: 'main' as SourceType,
            }))
          : [];

        const revisionProjects: any[] = (revisionRowsByAgency.get(agencyId) || [])
          .filter((p: any) => {
            // Scope-specific filter: when user picked
            // `revision-edit`, drop change-type rows; and vice versa.
            if (includeRevisionEdit && includeRevisionChange) return true;
            if (includeRevisionEdit) return p.__revisionType !== 'change';
            if (includeRevisionChange) return p.__revisionType === 'change';
            return false;
          })
          .map((p: any) => ({
            ...p,
            sourceType:
              p.__revisionType === 'change'
                ? ('revision-change' as SourceType)
                : ('revision-edit' as SourceType),
          }));

        const supplementProjects: any[] = (supplementRowsByAgency.get(agencyId) || []).map(
          (p: any) => ({ ...p, sourceType: 'supplement' as SourceType }),
        );

        const mergedProjects = [
          ...mainProjects,
          ...revisionProjects,
          ...supplementProjects,
        ];

        // Wave 24 — same dual-split as the legacy aggregator (Patches C/D):
        //   tile      → drops Ready only; preserves Returned_For_Revision
        //                tile per FIX_EXECUTIVE_STATUS_COUNTS_RETURNED_FOR_REVISION.
        //   executive → drops Ready / Pull_Back / Returned_For_Revision per
        //                §3 W67; drives FE-shipped array + projectCount.
        const tileProjects = mergedProjects.filter((p: any) => {
          const latest = p.trackingStatus?.find((t: any) => t.isLatest);
          return latest && latest.statusId && latest.statusId.name !== 'Ready';
        });
        const executiveProjects = mergedProjects.filter((p: any) => {
          const latest = p.trackingStatus?.find((t: any) => t.isLatest);
          return (
            latest &&
            latest.statusId &&
            !(EXECUTIVE_EXCLUDED_STATUS_NAMES as readonly string[]).includes(
              latest.statusId.name,
            )
          );
        });

        const { counts, aging } = this.buildStatusBuckets(tileProjects, staff);

        agency.responsibleAgencyProjectGroup = executiveProjects;
        agency.projectCount = executiveProjects.length;
        agency.statusCounts = counts;
        agency.statusAging = aging;
      }

      // For scope=all the amphoe (main-plan-only bucket) is preserved.
      // For scope=revision/supplement, amphoe bucket has no revision/supplement
      // analog — responsibility partition §7 puts those on responsibleAgency.
      // We still leave the existing amphoe decoration so the FE can render
      // an empty-state when the user filters to a non-main scope.
      if (!includeMain && staff.workHistoryResponsibleAmphoe) {
        for (const item of staff.workHistoryResponsibleAmphoe) {
          if (!item.amphoe) continue;
          const amphoe = item.amphoe as any;
          amphoe.projectGroups = [];
          amphoe.projectCount = 0;
          const { counts, aging } = this.buildStatusBuckets([], staff);
          amphoe.statusCounts = counts;
          amphoe.statusAging = aging;
        }
      }
    }

    // Top-level totals reflect only the active scope (each scope is
    // now pure — no union). Counts are derived from the already-filtered
    // `responsibleAgencyProjectGroup` arrays that were rewritten in the
    // loop above.
    let scopeProjectGroupCount = 0;
    let scopeApproveCount = 0;
    let scopeInprogressCount = 0;
    for (const staff of staffRows) {
      const agencyLinks = staff.workHistoryResponsibleGovernmentAgency || [];
      for (const link of agencyLinks) {
        const agency = link.governmentAgency as any;
        if (!agency) continue;
        const counts = agency.statusCounts || {};
        scopeProjectGroupCount += agency.projectCount || 0;
        scopeApproveCount += counts.approve || 0;
        scopeInprogressCount +=
          (counts.pending || 0) +
          (counts.verified || 0) +
          (counts.pendingApproval || 0);
      }
    }

    return {
      ...legacy,
      projectGroupCount: scopeProjectGroupCount,
      projectGroupApproveCount: scopeApproveCount,
      projectGroupInprogressCount: scopeInprogressCount,
      scope,
    };
  }

  /**
   * Helper: compute statusCounts + statusAging for an arbitrary project
   * list. Reuses the exact same key set and shape as the legacy
   * aggregator so the FE consumer is unchanged.
   */
  private buildStatusBuckets(projects: any[], staff: any) {
    const counts: Record<string, number> = {
      Pending: 0,
      Rejected: 0,
      [STATUS_NAMES.RETURNED_FOR_REVISION]: 0,
      Approved: 0,
      Pending_Approval: 0,
      Verified: 0,
    };
    const aging: Record<string, { total: number; count: number; details: any[] }> = {
      Pending: { total: 0, count: 0, details: [] },
      Rejected: { total: 0, count: 0, details: [] },
      [STATUS_NAMES.RETURNED_FOR_REVISION]: { total: 0, count: 0, details: [] },
      Approved: { total: 0, count: 0, details: [] },
      Pending_Approval: { total: 0, count: 0, details: [] },
      Verified: { total: 0, count: 0, details: [] },
    };

    for (const p of projects) {
      const latest = p.trackingStatus?.find((t: any) => t.isLatest);
      if (!latest || !latest.statusId) continue;
      const statusName = latest.statusId.name;
      if (counts[statusName] === undefined) continue;
      if (statusName === 'Ready') continue;
      counts[statusName]++;
      const diffTime = Math.abs(
        new Date().getTime() - new Date(latest.createAt).getTime(),
      );
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      aging[statusName].total += diffDays;
      aging[statusName].count++;
      aging[statusName].details.push({
        id: p.id,
        title: p.title,
        aging: diffDays,
        sourceType: p.sourceType,
        user: staff?.user ? staff.user : 'Unknown',
      });
    }

    const agingShaped = Object.keys(aging).reduce((acc: any, key) => {
      acc[key] = {
        avgTime: aging[key].count > 0
          ? (aging[key].total / aging[key].count).toFixed(2)
          : 0,
        details: aging[key].details,
      };
      return acc;
    }, {});

    return { counts, aging: agingShaped };
  }

  /**
   * Load `RevisedProjectGroup` rows for a set of agency ids, filtered by
   * the development-plan chain: the revision's `developmentPlanRevision`
   * must chain back to the supplied `developmentPlanId`.
   *
   * §14 / §15: `deleted_at IS NULL` honored on both RPG and its parent
   * revision. `ts.isLatest = true` and `status.name != 'Ready'` mirror the
   * legacy main-plan filter.
   *
   * §7 partition: agency id is `responsible_agency_id`.
   *
   * Each row is tagged with `__revisionType` ('edit' | 'change') derived
   * from `revisionType.name` to support the `revision-edit` /
   * `revision-change` source discriminator.
   */
  private async loadRevisedProjectGroupsByAgency(
    developmentPlanId: string | null,
    agencyIds: string[],
  ): Promise<Map<string, any[]>> {
    const result = new Map<string, any[]>();
    if (!developmentPlanId || agencyIds.length === 0) return result;

    const rows = await this.revisedProjectGroupRepo
      .createQueryBuilder('rpg')
      .leftJoinAndSelect('rpg.developmentPlanRevision', 'dpr')
      .leftJoinAndSelect('dpr.revisionType', 'rt')
      .leftJoinAndSelect('rpg.responsibleAgency', 'ra')
      .leftJoinAndSelect('rpg.trackingStatus', 'ts', 'ts.isLatest = :isLatest', { isLatest: true })
      .leftJoinAndSelect('ts.statusId', 'status')
      .where('dpr.developmentPlan = :planId', { planId: developmentPlanId })
      .andWhere('rpg.deletedAt IS NULL')
      .andWhere('dpr.deletedAt IS NULL')
      .andWhere('ra.id IN (:...agencyIds)', { agencyIds })
      .andWhere('status.name != :readyStatus', { readyStatus: 'Ready' })
      .getMany();

    for (const row of rows) {
      if (!row.responsibleAgency) continue;
      const agencyId = String(row.responsibleAgency.id);
      const arr = result.get(agencyId) ?? [];
      const typeName = (row as any).developmentPlanRevision?.revisionType?.name ?? '';
      // Thai vocab: 'แก้ไข' = edit, 'เปลี่ยนแปลง' = change
      const revisionType: 'edit' | 'change' = typeName === 'เปลี่ยนแปลง' ? 'change' : 'edit';
      arr.push({ ...row, __revisionType: revisionType });
      result.set(agencyId, arr);
    }
    return result;
  }

  /**
   * Load `SupplementProjectGroup` rows for a set of agency ids, filtered
   * by the development-plan chain via `developmentPlanSupplement`.
   *
   * Same §14/§15 `deleted_at IS NULL` + `ts.isLatest = true` discipline.
   * §7 partition: `responsible_agency_id`.
   */
  private async loadSupplementProjectGroupsByAgency(
    developmentPlanId: string | null,
    agencyIds: string[],
  ): Promise<Map<string, any[]>> {
    const result = new Map<string, any[]>();
    if (!developmentPlanId || agencyIds.length === 0) return result;

    const rows = await this.supplementProjectGroupRepo
      .createQueryBuilder('spg')
      .leftJoinAndSelect('spg.developmentPlanSupplement', 'dps')
      .leftJoinAndSelect('spg.responsibleAgency', 'ra')
      .leftJoinAndSelect('spg.trackingStatus', 'ts', 'ts.isLatest = :isLatest', { isLatest: true })
      .leftJoinAndSelect('ts.statusId', 'status')
      .where('dps.developmentPlan = :planId', { planId: developmentPlanId })
      .andWhere('spg.deletedAt IS NULL')
      .andWhere('dps.deletedAt IS NULL')
      .andWhere('spg.isDraft = :isDraft', { isDraft: false })
      .andWhere('ra.id IN (:...agencyIds)', { agencyIds })
      .andWhere('status.name != :readyStatus', { readyStatus: 'Ready' })
      .getMany();

    for (const row of rows) {
      if (!row.responsibleAgency) continue;
      const agencyId = String(row.responsibleAgency.id);
      const arr = result.get(agencyId) ?? [];
      arr.push(row);
      result.set(agencyId, arr);
    }
    return result;
  }

  /**
   * Per-source global counters (for `byScope.main`). Mirrors the three
   * legacy counters so that `scope=all` preserves feature parity.
   */
  private async countProjectGroup(developmentPlanId: string | null): Promise<SourceCounters> {
    if (!developmentPlanId) return EMPTY_COUNTERS();
    const base = () =>
      this.projectGroupRepo
        .createQueryBuilder('pg')
        .innerJoin('pg.trackingStatus', 'ts')
        .innerJoin('ts.statusId', 'status')
        .where('pg.developmentPlan = :id', { id: developmentPlanId })
        .andWhere('ts.isLatest = :isLatest', { isLatest: true })
        .andWhere('pg.isDraft = :isDraft', { isDraft: false });

    const [projectGroupCount, approveCount, inProgressCount] = await Promise.all([
      base().andWhere('status.name != :readyStatus', { readyStatus: 'Ready' }).getCount(),
      base().andWhere('status.name = :status', { status: 'Approved' }).getCount(),
      base()
        .andWhere('status.name NOT IN (:...excludeStatuses)', {
          excludeStatuses: ['Approved', 'Ready'],
        })
        .getCount(),
    ]);
    return { projectGroupCount, approveCount, inProgressCount };
  }

  private async countRevisedProjectGroup(
    developmentPlanId: string | null,
  ): Promise<SourceCounters> {
    if (!developmentPlanId) return EMPTY_COUNTERS();
    const base = () =>
      this.revisedProjectGroupRepo
        .createQueryBuilder('rpg')
        .leftJoin('rpg.developmentPlanRevision', 'dpr')
        .innerJoin('rpg.trackingStatus', 'ts')
        .innerJoin('ts.statusId', 'status')
        .where('dpr.developmentPlan = :id', { id: developmentPlanId })
        .andWhere('rpg.deletedAt IS NULL')
        .andWhere('dpr.deletedAt IS NULL')
        .andWhere('ts.isLatest = :isLatest', { isLatest: true });

    const [projectGroupCount, approveCount, inProgressCount] = await Promise.all([
      base().andWhere('status.name != :readyStatus', { readyStatus: 'Ready' }).getCount(),
      base().andWhere('status.name = :status', { status: 'Approved' }).getCount(),
      base()
        .andWhere('status.name NOT IN (:...excludeStatuses)', {
          excludeStatuses: ['Approved', 'Ready'],
        })
        .getCount(),
    ]);
    return { projectGroupCount, approveCount, inProgressCount };
  }

  private async countSupplementProjectGroup(
    developmentPlanId: string | null,
  ): Promise<SourceCounters> {
    if (!developmentPlanId) return EMPTY_COUNTERS();
    const base = () =>
      this.supplementProjectGroupRepo
        .createQueryBuilder('spg')
        .leftJoin('spg.developmentPlanSupplement', 'dps')
        .innerJoin('spg.trackingStatus', 'ts')
        .innerJoin('ts.statusId', 'status')
        .where('dps.developmentPlan = :id', { id: developmentPlanId })
        .andWhere('spg.deletedAt IS NULL')
        .andWhere('dps.deletedAt IS NULL')
        .andWhere('spg.isDraft = :isDraft', { isDraft: false })
        .andWhere('ts.isLatest = :isLatest', { isLatest: true });

    const [projectGroupCount, approveCount, inProgressCount] = await Promise.all([
      base().andWhere('status.name != :readyStatus', { readyStatus: 'Ready' }).getCount(),
      base().andWhere('status.name = :status', { status: 'Approved' }).getCount(),
      base()
        .andWhere('status.name NOT IN (:...excludeStatuses)', {
          excludeStatuses: ['Approved', 'Ready'],
        })
        .getCount(),
    ]);
    return { projectGroupCount, approveCount, inProgressCount };
  }
}
