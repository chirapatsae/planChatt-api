import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { WorkHistoryAmphoeResponsibility } from 'src/work-history-amphoe-responsibility/entities/work-history-amphoe-responsibility.entity';
import { WorkHistoryGovernmentAgencyResponsibility } from 'src/work-history-government-agency-responsibility/entities/work-history-government-agency-responsibility.entity';
import { ProjectNotificationRecipient } from '../events/project-notification-event';

/**
 * Maximum recipients allowed per single event dispatch. Matches architecture
 * §2 R5 cap — prevents unbounded fan-out on PROJECT_SUBMITTED for busy amphoes.
 */
export const RECIPIENT_FANOUT_CAP = 50;

/**
 * Staff-lead role gate — matches the logical "staff-lead" definition in
 * CLAUDE.md (§3 role responsibilities + Staff-Lead Definition).
 */
const STAFF_LEAD_ROLES = ['staff', 'admin', 'super-admin'];

/**
 * RecipientResolverService — centralizes recipient lookups for Wave 21
 * workflow-change emails. It does NOT emit events and does NOT write to
 * tracking_status (§12) — it is a read-only lookup helper.
 *
 * Filtering rules (applied in SQL where possible, in JS for the last mile):
 *   - workStatus.name = 'approved'            (§2 workStatus rule)
 *   - role.name IN (staff, admin, super-admin) for staff-lead queries
 *   - user.email IS NOT NULL AND user.email <> ''
 *   - user.allowEmailNotification = true      (preference double-gate, first layer)
 *   - workHistory.isCurrent = true AND workHistory.deletedAt IS NULL
 *
 * The preference filter here is an optimization — the NotificationsEmailService
 * preference gate at enqueue time + processor time remains the single source of
 * truth (§2.4).
 */
@Injectable()
export class RecipientResolverService {
  private readonly logger = new Logger(RecipientResolverService.name);

  constructor(
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,
    @InjectRepository(WorkHistoryAmphoeResponsibility)
    private readonly amphoeRespRepo: Repository<WorkHistoryAmphoeResponsibility>,
    @InjectRepository(WorkHistoryGovernmentAgencyResponsibility)
    private readonly agencyRespRepo: Repository<WorkHistoryGovernmentAgencyResponsibility>,
  ) {}

  /**
   * Resolve the owner of a project by its createdBy WorkHistory id.
   * Used by PROJECT_RETURNED_FOR_REVISION and PROJECT_APPROVED events.
   */
  async resolveOwner(createdByWorkHistoryId: string): Promise<ProjectNotificationRecipient[]> {
    if (!createdByWorkHistoryId) return [];
    const wh = await this.workHistoryRepo.findOne({
      where: { id: createdByWorkHistoryId },
      relations: ['user'],
    });
    if (!wh || !wh.user) return [];
    return this.filterAndCap([wh], 'resolveOwner');
  }

  /**
   * Resolve staff-lead recipients who are responsible for the given amphoe.
   * Used for PROJECT_SUBMITTED on main-plan projects.
   */
  async resolveStaffLeadByAmphoe(amphoeId: string | number): Promise<ProjectNotificationRecipient[]> {
    if (!amphoeId) return [];
    const rows = await this.amphoeRespRepo
      .createQueryBuilder('resp')
      .innerJoinAndSelect('resp.workHistory', 'wh')
      .innerJoinAndSelect('wh.user', 'user')
      .innerJoinAndSelect('wh.role', 'role')
      .innerJoinAndSelect('wh.workStatus', 'workStatus')
      .where('resp.amphoe_id = :amphoeId', { amphoeId })
      .andWhere('wh.is_current = :isCurrent', { isCurrent: true })
      .andWhere('wh.deleted_at IS NULL')
      .andWhere('workStatus.name = :approved', { approved: 'approved' })
      .andWhere('role.name IN (:...roles)', { roles: STAFF_LEAD_ROLES })
      .getMany();

    const whList = rows.map((r) => r.workHistory).filter((wh): wh is WorkHistory => !!wh);
    return this.filterAndCap(whList, 'resolveStaffLeadByAmphoe');
  }

  /**
   * Resolve staff-lead recipients responsible for a government agency.
   * Used for PROJECT_SUBMITTED on revision/change projects.
   */
  async resolveStaffLeadByAgency(agencyId: string | number): Promise<ProjectNotificationRecipient[]> {
    if (!agencyId) return [];
    const rows = await this.agencyRespRepo
      .createQueryBuilder('resp')
      .innerJoinAndSelect('resp.workHistory', 'wh')
      .innerJoinAndSelect('wh.user', 'user')
      .innerJoinAndSelect('wh.role', 'role')
      .innerJoinAndSelect('wh.workStatus', 'workStatus')
      .where('resp.government_agency_id = :agencyId', { agencyId })
      .andWhere('wh.is_current = :isCurrent', { isCurrent: true })
      .andWhere('wh.deleted_at IS NULL')
      .andWhere('workStatus.name = :approved', { approved: 'approved' })
      .andWhere('role.name IN (:...roles)', { roles: STAFF_LEAD_ROLES })
      .getMany();

    const whList = rows.map((r) => r.workHistory).filter((wh): wh is WorkHistory => !!wh);
    return this.filterAndCap(whList, 'resolveStaffLeadByAgency');
  }

  // ---------------------------------------------------------------------------

  private filterAndCap(workHistories: WorkHistory[], source: string): ProjectNotificationRecipient[] {
    const seen = new Set<string>();
    const kept: ProjectNotificationRecipient[] = [];
    let skippedPreference = 0;
    let skippedNoEmail = 0;
    let skippedDuplicate = 0;

    for (const wh of workHistories) {
      if (!wh.user) {
        continue;
      }
      const user = wh.user;
      if (!user.email || user.email.trim() === '') {
        skippedNoEmail++;
        continue;
      }
      if (user.allowEmailNotification === false) {
        skippedPreference++;
        continue;
      }
      if (seen.has(user.id)) {
        skippedDuplicate++;
        continue;
      }
      seen.add(user.id);
      kept.push({
        userId: user.id,
        email: user.email,
        workHistoryId: wh.id,
      });
    }

    if (kept.length > RECIPIENT_FANOUT_CAP) {
      this.logger.warn(
        `[Notify] fanout-capped source=${source} total=${kept.length} cap=${RECIPIENT_FANOUT_CAP}`,
      );
      return kept.slice(0, RECIPIENT_FANOUT_CAP);
    }

    if (skippedNoEmail + skippedPreference + skippedDuplicate > 0) {
      this.logger.debug(
        `[Notify] filter source=${source} kept=${kept.length} no-email=${skippedNoEmail} preference-off=${skippedPreference} duplicate=${skippedDuplicate}`,
      );
    }

    return kept;
  }
}
