import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { WorkHistoryAmphoeResponsibility } from 'src/work-history-amphoe-responsibility/entities/work-history-amphoe-responsibility.entity';
import { WorkHistoryGovernmentAgencyResponsibility } from 'src/work-history-government-agency-responsibility/entities/work-history-government-agency-responsibility.entity';
import { LineUserBinding } from 'src/line/entities/line-user-binding.entity';
import { User } from 'src/users/entities/user.entity';
import {
  ProjectNotificationLineRecipient,
  ProjectNotificationRecipient,
} from '../events/project-notification-event';

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
 *   - workHistory.isCurrent = true AND workHistory.deletedAt IS NULL
 *
 * CHANNEL-AGNOSTIC RESOLUTION — this resolver returns the RAW candidate
 * recipient set (deduped-by-user + fanout-capped). It deliberately does NOT
 * gate on any channel preference (no `allowEmailNotification`, no
 * `allowLineNotification`, no email-presence). Each channel gates
 * INDEPENDENTLY at its own worker:
 *   - email  → NotificationsEmailService.sendPreparedJob re-checks
 *     `allowEmailNotification` (skipped-preference) + email-verified
 *     (skipped-not-verified).
 *   - LINE   → NotificationsLineService re-checks `allowLineNotification`
 *     (skipped-preference) + active binding (skipped-not-linked).
 *   - in-app → always delivered (bell) per the targeted-notification helper.
 * Moving the preference gate out of the resolver is what decouples the three
 * channels: a user who opted out of email still receives LINE / in-app.
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
    // W96-RECIPIENT-RESOLVER — LINE channel binding lookup. Read-only
    // injection — this service NEVER writes to `line_user_bindings`.
    // Active-row filter (`unlinkedAt IS NULL`) is enforced inline; we do
    // not delegate to LineUserBindingService because that service is
    // single-row keyed by lineUserId, while we need a batched user_id IN
    // (...) lookup with a single SQL roundtrip.
    @InjectRepository(LineUserBinding)
    private readonly lineBindingRepo: Repository<LineUserBinding>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  /**
   * Resolve the owner of a project by its createdBy WorkHistory id.
   * Used by PROJECT_RETURNED_FOR_REVISION and PROJECT_APPROVED events.
   */
  async resolveOwner(
    createdByWorkHistoryId: string,
  ): Promise<ProjectNotificationRecipient[]> {
    if (!createdByWorkHistoryId) return [];
    const wh = await this.workHistoryRepo.findOne({
      where: { id: createdByWorkHistoryId },
      relations: ['user'],
    });
    if (!wh || !wh.user) return [];
    return this.dedupeAndCap([wh], 'resolveOwner');
  }

  /**
   * Resolve staff-lead recipients who are responsible for the given amphoe.
   * Used for PROJECT_SUBMITTED on main-plan projects.
   */
  async resolveStaffLeadByAmphoe(
    amphoeId: string | number,
  ): Promise<ProjectNotificationRecipient[]> {
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

    const whList = rows
      .map((r) => r.workHistory)
      .filter((wh): wh is WorkHistory => !!wh);
    return this.dedupeAndCap(whList, 'resolveStaffLeadByAmphoe');
  }

  /**
   * Resolve staff-lead recipients responsible for a government agency.
   * Used for PROJECT_SUBMITTED on revision/change projects.
   */
  async resolveStaffLeadByAgency(
    agencyId: string | number,
  ): Promise<ProjectNotificationRecipient[]> {
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

    const whList = rows
      .map((r) => r.workHistory)
      .filter((wh): wh is WorkHistory => !!wh);
    return this.dedupeAndCap(whList, 'resolveStaffLeadByAgency');
  }

  /**
   * W96-RECIPIENT-RESOLVER — extend an email-shaped recipient list with
   * active LINE bindings. Returns ONLY the recipients that satisfy ALL of:
   *
   *   - `users.allowLineNotification = true` (1st-pass preference gate,
   *     parity with email's `allowEmailNotification` first layer; the
   *     dispatch service still re-checks at enqueue + processor time per
   *     §2.4 double-gate discipline)
   *   - exists an ACTIVE row in `line_user_bindings`
   *     (`unlinkedAt IS NULL`)
   *
   * Recipients dropped at either gate are EXCLUDED from the returned list.
   * The caller (W96-DISPATCH) is responsible for any audit row that
   * documents the drop (e.g. `'skipped-not-linked'`); this resolver is a
   * read-only lookup helper and MUST NOT write audit rows directly.
   *
   * Implementation:
   *   1. One SQL query to fetch `(id, allowLineNotification)` for the
   *      input userIds — drops opted-out users before the binding lookup.
   *   2. One SQL query to fetch active bindings for the surviving userIds,
   *      ordered by `linkedAt DESC` so the JS de-dupe keeps the most
   *      recent active row per user (defense against a theoretical
   *      multi-active-binding state — see §11 of the task spec).
   *
   * Total: 2 SQL roundtrips, both indexed (PK on users.id;
   * idx_line_user_bindings_user_active partial index on line_user_bindings).
   *
   * §17.3 — `lineUserId` resolved exclusively from `line_user_bindings`.
   * The legacy `users.lineId` column is intentionally NOT consulted.
   * §17.11 — preference + active-binding filters are integrity, not
   * permission; no role bypass.
   * W83 — summary log emits counts only (no raw lineUserId, no userId).
   * Per-recipient logging is left to the dispatcher (W96-DISPATCH), which
   * MUST mask any lineUserId via SHA-256 shortHash before emission.
   */
  async enrichWithLineBindings(
    recipients: ProjectNotificationRecipient[],
  ): Promise<ProjectNotificationLineRecipient[]> {
    if (!recipients || recipients.length === 0) return [];

    // De-dupe input by userId — multiple WorkHistory rows could surface
    // the same user (defensive; upstream resolver already de-dupes).
    const inputByUserId = new Map<string, ProjectNotificationRecipient>();
    for (const r of recipients) {
      if (r.userId && !inputByUserId.has(r.userId)) {
        inputByUserId.set(r.userId, r);
      }
    }
    const userIds = Array.from(inputByUserId.keys());
    if (userIds.length === 0) return [];

    // Roundtrip 1 — preference gate. Fetch only the columns we need.
    const userPrefs = await this.userRepo.find({
      where: { id: In(userIds) },
      select: ['id', 'allowLineNotification'],
    });
    const allowedUserIds: string[] = [];
    let preferenceOff = 0;
    for (const u of userPrefs) {
      if (u.allowLineNotification === false) {
        preferenceOff++;
        continue;
      }
      allowedUserIds.push(u.id);
    }

    if (allowedUserIds.length === 0) {
      this.logger.debug(
        `[Notify-line] filter source=enrichWithLineBindings kept=0 no-binding=0 preference-off=${preferenceOff} duplicate=0`,
      );
      return [];
    }

    // Roundtrip 2 — active-binding lookup (single batched query).
    // ORDER BY linkedAt DESC so the JS de-dupe below keeps the most
    // recently linked active row per user (§11 multi-binding edge case).
    const bindings = await this.lineBindingRepo.find({
      where: { userId: In(allowedUserIds), unlinkedAt: IsNull() },
      order: { linkedAt: 'DESC' },
      select: ['userId', 'lineUserId', 'linkedAt'],
    });

    const bindingByUserId = new Map<string, string>();
    for (const b of bindings) {
      // Skip duplicates — first occurrence wins (most-recent linkedAt
      // due to ORDER BY DESC above).
      if (!bindingByUserId.has(b.userId)) {
        bindingByUserId.set(b.userId, b.lineUserId);
      }
    }

    const seen = new Set<string>();
    const kept: ProjectNotificationLineRecipient[] = [];
    let noBinding = 0;
    let duplicate = 0;
    for (const userId of allowedUserIds) {
      const lineUserId = bindingByUserId.get(userId);
      if (!lineUserId) {
        noBinding++;
        continue;
      }
      if (seen.has(userId)) {
        duplicate++;
        continue;
      }
      seen.add(userId);
      const base = inputByUserId.get(userId);
      if (!base) continue; // defensive; should never happen
      kept.push({
        userId: base.userId,
        email: base.email,
        workHistoryId: base.workHistoryId,
        lineUserId,
      });
    }

    this.logger.debug(
      `[Notify-line] filter source=enrichWithLineBindings kept=${kept.length} no-binding=${noBinding} preference-off=${preferenceOff} duplicate=${duplicate}`,
    );

    return kept;
  }

  // ---------------------------------------------------------------------------

  /**
   * CHANNEL-AGNOSTIC dedupe + cap. Returns the raw candidate recipient set
   * with NO channel preference gating — opt-out is enforced independently at
   * each channel's worker (see class doc). Keeps only:
   *   - the must-have-`wh.user` guard (rows with no joined user are skipped)
   *   - dedupe by `user.id`
   *   - the RECIPIENT_FANOUT_CAP slice (W21 R5 blast-radius bound)
   * The returned `email` is `user.email ?? ''` — it may be empty; the email
   * worker re-loads + re-checks the real (encrypted) address at send time.
   */
  private dedupeAndCap(
    workHistories: WorkHistory[],
    source: string,
  ): ProjectNotificationRecipient[] {
    const seen = new Set<string>();
    const kept: ProjectNotificationRecipient[] = [];
    let skippedDuplicate = 0;

    for (const wh of workHistories) {
      if (!wh.user) {
        continue;
      }
      const user = wh.user;
      if (seen.has(user.id)) {
        skippedDuplicate++;
        continue;
      }
      seen.add(user.id);
      kept.push({
        userId: user.id,
        email: user.email ?? '',
        workHistoryId: wh.id,
      });
    }

    if (kept.length > RECIPIENT_FANOUT_CAP) {
      this.logger.warn(
        `[Notify] fanout-capped source=${source} total=${kept.length} cap=${RECIPIENT_FANOUT_CAP}`,
      );
      return kept.slice(0, RECIPIENT_FANOUT_CAP);
    }

    if (skippedDuplicate > 0) {
      this.logger.debug(
        `[Notify] dedupe source=${source} kept=${kept.length} duplicate=${skippedDuplicate}`,
      );
    }

    return kept;
  }
}
