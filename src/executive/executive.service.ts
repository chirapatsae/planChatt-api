import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateExecutiveDto } from './dto/create-executive.dto';
import { UpdateExecutiveDto } from './dto/update-executive.dto';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';

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

  async getTeamDashboard(userId: string) {
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
              Revision: 0,
              Approved: 0,
              Pending_Approval: 0,
              Verified: 0
            };
            const aging = {
              Pending: { total: 0, count: 0, details: [] },
              Rejected: { total: 0, count: 0, details: [] },
              Revision: { total: 0, count: 0, details: [] },
              Approved: { total: 0, count: 0, details: [] },
              Pending_Approval: { total: 0, count: 0, details: [] },
              Verified: { total: 0, count: 0, details: [] }
            };

            const allProjects = item.amphoe.projectGroups || [];
            const projects = allProjects.filter(p => {
              const latest = p.trackingStatus?.find(t => t.isLatest);
              return latest && latest.statusId && latest.statusId.name !== 'Ready';
            });

            projects.forEach(p => {
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
            (item.amphoe as any).statusCounts = counts;
            (item.amphoe as any).projectCount = projects.length; // Ensure this is set
            (item.amphoe as any).projectGroups = projects;
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
              Revision: 0,
              Approved: 0,
              Pending_Approval: 0,
              Verified: 0
            };
            const aging = {
              Pending: { total: 0, count: 0, details: [] },
              Rejected: { total: 0, count: 0, details: [] },
              Revision: { total: 0, count: 0, details: [] },
              Approved: { total: 0, count: 0, details: [] },
              Pending_Approval: { total: 0, count: 0, details: [] },
              Verified: { total: 0, count: 0, details: [] }
            };

            const allProjects = item.governmentAgency.responsibleAgencyProjectGroup || [];
            const projects = allProjects.filter(p => {
              const latest = p.trackingStatus?.find(t => t.isLatest);
              return latest && latest.statusId && latest.statusId.name !== 'Ready';
            });

            projects.forEach(p => {
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
            (item.governmentAgency as any).statusCounts = counts;
            (item.governmentAgency as any).projectCount = projects.length; // Ensure this is set
            (item.governmentAgency as any).responsibleAgencyProjectGroup = projects;
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
      .andWhere('status.name != :readyStatus', {
        readyStatus: 'Ready'
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
      .andWhere('status.name NOT IN (:...excludeStatuses)', {
        excludeStatuses: ['Approved', 'Ready']
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
}
