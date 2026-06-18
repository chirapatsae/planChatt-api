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
// Equipment sub-types (ครุภัณฑ์ ผ.03) — DB-01 / BE-01,
// wave-team-dashboard-equipment-coverage. EPG (main plan),
// RELPG (equipment revision/change), SEPG (supplement equipment).
import { EquipmentProjectGroup } from 'src/equipment-project-group/entities/equipment-project-group.entity';
import { RevisedEquipmentProjectGroup } from 'src/revised-equipment-project-group/entities/revised-equipment-project-group.entity';
import { SupplementEquipmentProjectGroup } from 'src/supplement-equipment-project-group/entities/supplement-equipment-project-group.entity';
import { STATUS_NAMES } from 'src/common/status-names';
import { EXECUTIVE_EXCLUDED_STATUS_NAMES } from 'src/ai-executive-chat/aggregation/constants/executive-status-groups';

/**
 * Team Dashboard scope aggregation.
 *
 * The dashboard partitions staff workload across the four book scopes —
 * `main`, `revision-edit`, `revision-change`, `supplement` — under the same
 * per-staff responsibility partition (§7).
 *
 * wave-team-dashboard-equipment-folded (2026-06-18) — equipment (ครุภัณฑ์
 * ผ.03) is PART of every book, like projects (โครงการ); it is NOT a separate
 * book-type. Each scope therefore FOLDS its matching equipment sub-type into
 * the same `responsibleAgency` bucket alongside the ผ.02 project rows:
 *   - `main`            → ProjectGroup (PG)            + EquipmentProjectGroup (EPG)
 *   - `revision-edit`   → RevisedProjectGroup (edit)   + RELPG (edit)
 *   - `revision-change` → RevisedProjectGroup (change) + RELPG (change)
 *   - `supplement`      → SupplementProjectGroup (SPG) + SEPG
 * Each project / equipment row carries a `sourceType` discriminator of
 * `'main' | 'revision-edit' | 'revision-change' | 'supplement' |
 * 'equipment-main' | 'equipment-revision-edit' | 'equipment-revision-change'
 * | 'equipment-supplement'`. The former standalone `equipment` scope (which
 * lumped ALL equipment across ALL book types into one tab) has been REMOVED.
 *
 * Contract:
 *   - `scope=main` → keeps the legacy payload shape (no top-level `scope`
 *     key). PG-only numbers are byte-identical to the pre-fold output.
 *   - non-main scopes → `scope` echoed at top-level.
 *
 * §5.3 — equipment is agency-origin only, so it lands only in the agency
 * bucket; the amphoe (LAO) bucket never carries equipment. §17.2 READ-ONLY.
 * §16.5 shape-agnostic — status from `tracking_status` only.
 */
export const TEAM_DASHBOARD_SCOPES = [
  // Equipment (ครุภัณฑ์ ผ.03) is NOT a separate book-type — it is PART of
  // every book (like projects). Each scope therefore FOLDS its matching
  // equipment sub-type into the same per-staff responsibleAgency bucket
  // (wave-team-dashboard-equipment-folded, 2026-06-18):
  //   main            → ProjectGroup (PG)            + EquipmentProjectGroup (EPG)
  //   revision-edit   → RevisedProjectGroup (edit)   + RevisedEquipmentProjectGroup (RELPG, edit)
  //   revision-change → RevisedProjectGroup (change) + RevisedEquipmentProjectGroup (RELPG, change)
  //   supplement      → SupplementProjectGroup (SPG) + SupplementEquipmentProjectGroup (SEPG)
  // The former standalone 'equipment' scope (which lumped ALL equipment
  // across ALL book types into one tab) has been REMOVED.
  'main',
  'revision-edit',
  'revision-change',
  'supplement',
] as const;
export type TeamDashboardScope = (typeof TEAM_DASHBOARD_SCOPES)[number];

type SourceType =
  | 'main'
  | 'revision-edit'
  | 'revision-change'
  | 'supplement'
  // Equipment sourceType discriminators — folded into the matching ผ.02 scope.
  | 'equipment-main'
  | 'equipment-revision-edit'
  | 'equipment-revision-change'
  | 'equipment-supplement';

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
    @InjectRepository(EquipmentProjectGroup)
    private readonly equipmentProjectGroupRepo: Repository<EquipmentProjectGroup>,
    @InjectRepository(RevisedEquipmentProjectGroup)
    private readonly revisedEquipmentProjectGroupRepo: Repository<RevisedEquipmentProjectGroup>,
    @InjectRepository(SupplementEquipmentProjectGroup)
    private readonly supplementEquipmentProjectGroupRepo: Repository<SupplementEquipmentProjectGroup>,
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
   * `scope=main` folds PG + EPG into the agency bucket
   * (wave-team-dashboard-equipment-folded). The PG-only numbers remain
   * byte-identical to the pre-fold legacy output (see
   * `getTeamDashboardMain` no-regression note).
   */
  async getTeamDashboard(userId: string, scope: TeamDashboardScope = 'main') {
    if (scope === 'main') {
      return this.getTeamDashboardMain(userId);
    }
    return this.getTeamDashboardUnion(userId, scope);
  }

  /**
   * LEGACY PG-only aggregator — pre-Wave-43 behavior.
   *
   * This method is the shared building block consumed by BOTH the main
   * scope (`getTeamDashboardMain`) and the union scopes
   * (`getTeamDashboardUnion`). It produces:
   *   - the per-staff amphoe (LAO main PG) bucket — used verbatim by the
   *     main scope (byte-identical to pre-Wave-43)
   *   - the per-staff agency (agency-origin main PG) bucket — used verbatim
   *     by the main scope WHEN no equipment is present, and re-decorated
   *     with EPG folded in by `getTeamDashboardMain`
   *   - the PG-only top-level totals (`projectGroupCount` etc.)
   *
   * DO NOT modify the amphoe-bucket decoration or the top-level PG counts —
   * the main scope relies on them being byte-identical. The agency-bucket
   * decoration is re-derived from raw PG rows by `getTeamDashboardMain` so
   * EPG can be merged without losing the PG set.
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
            // wave-team-dashboard-equipment-folded — stash the RAW
            // agency-origin main PG list (before the dual-split collapses it)
            // so `getTeamDashboardMain` can re-derive the agency bucket from
            // the exact same row set, merging EPG in without losing any PG.
            (item.governmentAgency as any).__rawMainProjectGroups = allProjects;
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
   * Main scope (wave-team-dashboard-equipment-folded, 2026-06-18).
   *
   * Folds the main-plan equipment (`EquipmentProjectGroup`, EPG) INTO the
   * per-staff `responsibleAgency` bucket ALONGSIDE the main-plan
   * `ProjectGroup` (PG). EPG is agency-origin only (§5.3), so only the
   * agency bucket gains equipment — the amphoe (LAO) bucket is left exactly
   * as the legacy method decorated it.
   *
   * NO-REGRESSION GUARANTEE (PG-only): with ZERO equipment present, this
   * method produces numbers identical to the pre-fold legacy output, because
   *   1. the amphoe bucket + top-level PG counts are taken verbatim from
   *      `getTeamDashboardMainLegacy` (untouched);
   *   2. the agency bucket is re-derived from the EXACT SAME raw
   *      agency-origin PG array the legacy loop iterated. The legacy method
   *      stashes that array on `agency.__rawMainProjectGroups` BEFORE it
   *      collapses the bucket; we read it back here, merge EPG in, then run
   *      the SAME dual-split (tile drops Ready; executive drops
   *      EXECUTIVE_EXCLUDED) + the SAME `buildStatusBuckets` shape the legacy
   *      loop used. With no EPG, the combined list IS the legacy PG list, so
   *      statusCounts / statusAging / projectCount /
   *      responsibleAgencyProjectGroup come out identical to legacy. This
   *      reuses the legacy data source (the WorkHistory join) verbatim — it
   *      does NOT introduce a second PG query.
   *
   * §17.2 READ-ONLY — pure reads, no `.save()` / tracking_status insert /
   * ai_* write. §16.5 shape-agnostic — status from tracking_status only.
   */
  private async getTeamDashboardMain(userId: string) {
    const legacy = await this.getTeamDashboardMainLegacy(userId);
    const developmentPlan: DevelopmentPlan | null = legacy.developmentPlan as any;

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
    const agencyIds = Array.from(agencyIdSet);

    // Main-plan equipment rows (EPG) for the agencies-of-interest, keyed by
    // responsibleAgency id. The PG side is read back from the stashed raw
    // legacy array per agency below.
    const epgRowsByAgency = await this.loadEquipmentProjectGroupsByAgency(
      developmentPlan?.id ?? null,
      agencyIds,
    );

    for (const staff of staffRows) {
      const agencyLinks = staff.workHistoryResponsibleGovernmentAgency || [];
      for (const link of agencyLinks) {
        if (!link.governmentAgency) continue;
        const agency = link.governmentAgency as any;
        const agencyId = String(agency.id);

        const mainProjects: any[] = (agency.__rawMainProjectGroups || []).map(
          (p: any) => ({ ...p, sourceType: 'main' as SourceType }),
        );
        const epgProjects: any[] = (epgRowsByAgency.get(agencyId) || []).map(
          (p: any) => ({ ...p, sourceType: 'equipment-main' as SourceType }),
        );

        const mergedProjects = [...mainProjects, ...epgProjects];

        // Same dual-split as the legacy aggregator:
        //   tile      → drops Ready only (preserves Returned_For_Revision tile).
        //   executive → drops EXECUTIVE_EXCLUDED (§3 W67); drives the
        //               FE-shipped array + projectCount.
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
        // Drop the internal stash so it never leaks into the response.
        delete agency.__rawMainProjectGroups;
      }
      // Amphoe (LAO main PG) bucket is left exactly as legacy decorated it —
      // EPG is agency-origin only (§5.3), so there is no equipment to fold in.
    }

    // Top-level PG-only totals are carried through from the legacy method
    // unchanged (the PG-only no-regression contract). The main payload does
    // NOT echo a `scope` key — preserving the historical byte-identical
    // contract the FE uses to detect the main scope. The behavioral change
    // is carried entirely by the equipment rows now tagged `equipment-main`
    // inside the agency bucket.
    return legacy;
  }

  /**
   * Union aggregator for non-`main` scopes (revision-edit / revision-change
   * / supplement).
   *
   * wave-team-dashboard-equipment-folded (2026-06-18) — each scope now FOLDS
   * its matching equipment sub-type into the SAME per-staff
   * `responsibleAgency` bucket alongside the ผ.02 project rows:
   *   revision-edit   → RevisedProjectGroup (edit)   + RELPG (edit)
   *   revision-change → RevisedProjectGroup (change) + RELPG (change)
   *   supplement      → SupplementProjectGroup       + SEPG
   *
   * Strategy:
   *   1. Run the legacy path to get staff rows (for the amphoe bucket + the
   *      agency id set + the top-level PG counts that are then overwritten).
   *   2. Fetch the scope's ผ.02 rows (RPG / SPG) AND the matching equipment
   *      rows (RELPG / SEPG) keyed by the agency ids loaded on each staff row.
   *   3. Merge ผ.02 + equipment into one list per agency, tag each row with
   *      its `sourceType`, recompute statusCounts / statusAging via the same
   *      dual-split + `buildStatusBuckets` shape.
   *
   * §5.3 — RPG / SPG / RELPG / SEPG are all agency-origin, so the amphoe
   * (LAO) bucket is always emptied. §17.2 READ-ONLY — pure reads.
   * §16.5 shape-agnostic — status from tracking_status only.
   */
  private async getTeamDashboardUnion(userId: string, scope: TeamDashboardScope) {
    const legacy = await this.getTeamDashboardMainLegacy(userId);
    const developmentPlan: DevelopmentPlan | null = legacy.developmentPlan as any;

    // Each scope is pure (revision-edit / revision-change / supplement). The
    // `main` path is handled by `getTeamDashboardMain` at the top of
    // `getTeamDashboard`, so by the time we land here scope is one of the
    // three non-main variants.
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
    const agencyIds = Array.from(agencyIdSet);

    // Load the scope's ผ.02 rows (RPG / SPG) for the agencies-of-interest.
    const revisionRowsByAgency = includeRevision
      ? await this.loadRevisedProjectGroupsByAgency(
          developmentPlan?.id ?? null,
          agencyIds,
        )
      : new Map<string, any[]>();
    const supplementRowsByAgency = includeSupplement
      ? await this.loadSupplementProjectGroupsByAgency(
          developmentPlan?.id ?? null,
          agencyIds,
        )
      : new Map<string, any[]>();

    // wave-team-dashboard-equipment-folded — load the MATCHING equipment
    // sub-type for the active scope: RELPG for the revision scopes, SEPG for
    // the supplement scope. These are folded INTO `mergedProjects` alongside
    // the ผ.02 rows below.
    const revisionEquipmentRowsByAgency = includeRevision
      ? await this.loadRevisedEquipmentProjectGroupsByAgency(
          developmentPlan?.id ?? null,
          agencyIds,
        )
      : new Map<string, any[]>();
    const supplementEquipmentRowsByAgency = includeSupplement
      ? await this.loadSupplementEquipmentProjectGroupsByAgency(
          developmentPlan?.id ?? null,
          agencyIds,
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

        // Scope-specific edit-vs-change filter, shared by ผ.02 revision rows
        // and RELPG equipment rows.
        const revisionTypeMatches = (p: any): boolean => {
          if (includeRevisionEdit && includeRevisionChange) return true;
          if (includeRevisionEdit) return p.__revisionType !== 'change';
          if (includeRevisionChange) return p.__revisionType === 'change';
          return false;
        };

        const revisionProjects: any[] = (revisionRowsByAgency.get(agencyId) || [])
          .filter(revisionTypeMatches)
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

        // wave-team-dashboard-equipment-folded — matching equipment rows,
        // tagged with the equipment-* sourceType, folded in alongside the
        // ผ.02 rows. RELPG honors the same edit-vs-change scope filter.
        const revisionEquipmentProjects: any[] = (
          revisionEquipmentRowsByAgency.get(agencyId) || []
        )
          .filter(revisionTypeMatches)
          .map((p: any) => ({
            ...p,
            sourceType:
              p.__revisionType === 'change'
                ? ('equipment-revision-change' as SourceType)
                : ('equipment-revision-edit' as SourceType),
          }));

        const supplementEquipmentProjects: any[] = (
          supplementEquipmentRowsByAgency.get(agencyId) || []
        ).map((p: any) => ({ ...p, sourceType: 'equipment-supplement' as SourceType }));

        const mergedProjects = [
          ...revisionProjects,
          ...supplementProjects,
          ...revisionEquipmentProjects,
          ...supplementEquipmentProjects,
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

      // Non-main scopes (revision-edit / revision-change / supplement) have
      // no amphoe (LAO) analog — RPG / SPG / RELPG / SEPG are all
      // agency-origin, so the §7 partition puts them on responsibleAgency.
      // Empty the amphoe bucket so the FE renders a clean empty-state.
      if (staff.workHistoryResponsibleAmphoe) {
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
    // loop above. Dedupe agencies by id so an agency linked under more than
    // one staff is counted ONCE (an agency object is shared across staff).
    let scopeProjectGroupCount = 0;
    let scopeApproveCount = 0;
    let scopeInprogressCount = 0;
    const countedAgencyIds = new Set<string>();
    for (const staff of staffRows) {
      const agencyLinks = staff.workHistoryResponsibleGovernmentAgency || [];
      for (const link of agencyLinks) {
        const agency = link.governmentAgency as any;
        if (!agency) continue;
        const agencyId = String(agency.id);
        if (countedAgencyIds.has(agencyId)) continue;
        countedAgencyIds.add(agencyId);
        const counts = agency.statusCounts || {};
        scopeProjectGroupCount += agency.projectCount || 0;
        // buildStatusBuckets emits CAPITALIZED status keys (Approved / Pending
        // / Verified / Pending_Approval) — read those, not lowercase aliases.
        scopeApproveCount += counts.Approved || 0;
        scopeInprogressCount +=
          (counts.Pending || 0) +
          (counts.Verified || 0) +
          (counts.Pending_Approval || 0);
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
   * wave-team-dashboard-equipment-coverage (BE-01) — load
   * `EquipmentProjectGroup` (EPG) rows for a set of agency ids, filtered by
   * the parent `DevelopmentPlan`. 1:1 mirror of
   * `loadSupplementProjectGroupsByAgency` but on the main-plan equipment
   * table.
   *
   * §14/§15: `deleted_at IS NULL` honored on EPG (its parent
   * `DevelopmentPlan` is the same plan we filter on, and that plan was
   * already resolved by the legacy preamble as the active latest/unbooked
   * plan, so no separate parent soft-delete probe is needed — equivalent
   * to the RPG/SPG loaders which probe the immediate parent book only).
   * `ts.isLatest = true` + `status.name != 'Ready'` mirror the ผ.02 filter
   * (the `Ready` exclusion is also how equipment drafts — which have no
   * `isDraft` column — are dropped). §7 partition: `responsible_agency_id`.
   * §16.5 shape-agnostic — never reads classification fields.
   */
  private async loadEquipmentProjectGroupsByAgency(
    developmentPlanId: string | null,
    agencyIds: string[],
  ): Promise<Map<string, any[]>> {
    const result = new Map<string, any[]>();
    if (!developmentPlanId || agencyIds.length === 0) return result;

    const rows = await this.equipmentProjectGroupRepo
      .createQueryBuilder('epg')
      .leftJoinAndSelect('epg.responsibleAgency', 'ra')
      .leftJoinAndSelect('epg.trackingStatus', 'ts', 'ts.isLatest = :isLatest', { isLatest: true })
      .leftJoinAndSelect('ts.statusId', 'status')
      .where('epg.developmentPlan = :planId', { planId: developmentPlanId })
      .andWhere('epg.deletedAt IS NULL')
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
   * wave-team-dashboard-equipment-coverage (BE-01) — load
   * `RevisedEquipmentProjectGroup` (RELPG) rows for a set of agency ids,
   * chained to the plan via `developmentPlanRevision.developmentPlan`. 1:1
   * mirror of `loadRevisedProjectGroupsByAgency` on the equipment table.
   *
   * §14/§15: `deleted_at IS NULL` honored on RELPG AND its parent revision.
   * `ts.isLatest = true` + `status.name != 'Ready'` mirror the ผ.02 filter.
   * §7 partition: `responsible_agency_id`. Each row is tagged with
   * `__revisionType` ('edit' | 'change') from `revisionType.name` to support
   * the equipment-revision-edit / equipment-revision-change discriminator —
   * union both (do NOT 400 on mixed revision types). §16.5 shape-agnostic.
   */
  private async loadRevisedEquipmentProjectGroupsByAgency(
    developmentPlanId: string | null,
    agencyIds: string[],
  ): Promise<Map<string, any[]>> {
    const result = new Map<string, any[]>();
    if (!developmentPlanId || agencyIds.length === 0) return result;

    const rows = await this.revisedEquipmentProjectGroupRepo
      .createQueryBuilder('relpg')
      .leftJoinAndSelect('relpg.developmentPlanRevision', 'dpr')
      .leftJoinAndSelect('dpr.revisionType', 'rt')
      .leftJoinAndSelect('relpg.responsibleAgency', 'ra')
      .leftJoinAndSelect('relpg.trackingStatus', 'ts', 'ts.isLatest = :isLatest', { isLatest: true })
      .leftJoinAndSelect('ts.statusId', 'status')
      .where('dpr.developmentPlan = :planId', { planId: developmentPlanId })
      .andWhere('relpg.deletedAt IS NULL')
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
   * wave-team-dashboard-equipment-coverage (BE-01) — load
   * `SupplementEquipmentProjectGroup` (SEPG) rows for a set of agency ids,
   * chained to the plan via `developmentPlanSupplement.developmentPlan`. 1:1
   * mirror of `loadSupplementProjectGroupsByAgency` on the equipment table.
   *
   * NOTE: SEPG has NO `isDraft` column (equipment has no stored draft flag —
   * unlike SPG; a "draft" equipment row is simply one whose latest status is
   * `Ready`). The `status.name != 'Ready'` filter is therefore the faithful
   * equivalent of the SPG loader's `isDraft = false` clause; adding a
   * `sepg.isDraft` predicate would reference a non-existent column.
   *
   * §14/§15: `deleted_at IS NULL` honored on SEPG AND its parent supplement.
   * §7 partition: `responsible_agency_id`. §16.5 shape-agnostic.
   */
  private async loadSupplementEquipmentProjectGroupsByAgency(
    developmentPlanId: string | null,
    agencyIds: string[],
  ): Promise<Map<string, any[]>> {
    const result = new Map<string, any[]>();
    if (!developmentPlanId || agencyIds.length === 0) return result;

    const rows = await this.supplementEquipmentProjectGroupRepo
      .createQueryBuilder('sepg')
      .leftJoinAndSelect('sepg.developmentPlanSupplement', 'dps')
      .leftJoinAndSelect('sepg.responsibleAgency', 'ra')
      .leftJoinAndSelect('sepg.trackingStatus', 'ts', 'ts.isLatest = :isLatest', { isLatest: true })
      .leftJoinAndSelect('ts.statusId', 'status')
      .where('dps.developmentPlan = :planId', { planId: developmentPlanId })
      .andWhere('sepg.deletedAt IS NULL')
      .andWhere('dps.deletedAt IS NULL')
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
}
