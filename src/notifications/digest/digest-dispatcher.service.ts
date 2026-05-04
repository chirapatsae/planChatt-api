import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Status } from 'src/status/entities/status.entity';
import type { BulkSubmitEmit } from 'src/tracking-status/types/bulk-emit';
import {
  DigestProjectDescriptor,
  ProjectNotificationEvent,
  ProjectNotificationEventType,
  ProjectNotificationRecipient,
} from '../events/project-notification-event';
import { NotificationsEmailService } from '../email/notifications-email.service';
import { NotificationsLineService } from '../line/notifications-line.service';
import { RecipientResolverService } from '../email/recipient-resolver.service';

/**
 * W105 BE-PR2 — Notification digest dispatcher.
 *
 * Consumes the post-commit `bulkEmits[]` array produced by
 * `TrackingStatusService.bulkSubmit` and collapses what would otherwise
 * be N events × K recipients × 2 channels into ONE digest job per
 * `(recipientUserId, eventType)` group when group.projects.length >= 2.
 *
 * Grouping key — `(recipientUserId, eventType)`. Per the W105 master plan
 * §9 risk note, the key MUST be userId, NOT workHistoryId — multiple
 * WorkHistory rows can resolve to the same User.
 *
 * N=1 fallback — if a group has exactly one project, the dispatcher
 * routes through the EXISTING per-project events
 * (`PROJECT_SUBMITTED` / `PROJECT_SUBMITTED_OWNER`) so the single-project
 * UX is unchanged. This rule is per-group, not per-batch (per the BE-PR2
 * task §6.2): a batch where recipient A sees 5 projects but recipient B
 * sees 1 produces a digest for A and per-project events for B.
 *
 * Owner self-receipt — the submitter is always the same across the
 * batch, so `PROJECT_SUBMITTED_OWNER_DIGEST` produces ONE owner-digest
 * job (1 recipient × N projects), not N owner jobs.
 *
 * §12 — this service NEVER writes to `tracking_status`.
 * §17.2 — advisory only; nothing here gates a workflow transition.
 * §17.3 — `bulkEmits[]` is in-memory; the dispatcher does NOT persist
 *   FKs to project tables. Bull queue logs are sufficient audit for this PR.
 * §4.1 — every enqueue is wrapped in try/catch so a notification failure
 *   never propagates to `bulkSubmit` (which has already returned to the
 *   client by the time this service is called).
 */
@Injectable()
export class DigestDispatcherService {
  private readonly logger = new Logger(DigestDispatcherService.name);

  constructor(
    private readonly notificationsEmailService: NotificationsEmailService,
    private readonly notificationsLineService: NotificationsLineService,
    private readonly recipientResolver: RecipientResolverService,
    @InjectRepository(Status)
    private readonly statusRepo: Repository<Status>,
  ) {}

  /**
   * Public entry point invoked by `TrackingStatusService.bulkSubmit`
   * after the per-project sub-transactions have all resolved. Never
   * throws — the entire body is wrapped in defensive try/catch.
   *
   * Empty `emits[]` is a no-op (e.g. all rows failed validation).
   */
  async dispatchBulkSubmitNotifications(args: {
    emits: BulkSubmitEmit[];
    projectKind: 'project-group' | 'revised-project-group';
    actorUserId: string | null;
    actorWorkHistoryId: string | null;
  }): Promise<void> {
    const { emits, projectKind, actorUserId, actorWorkHistoryId } = args;
    if (!emits || emits.length === 0) return;

    try {
      // ── Resolve Thai status labels ONCE for the whole batch (Ready / Pending)
      // The bulk endpoint is restricted to Ready → Pending so this is constant.
      const fromStatusTh = await this.lookupStatusTh('Ready');
      const toStatusTh = await this.lookupStatusTh('Pending');

      // ── Build per-emit recipient sets (cache per amphoe + per ownerWh) ──
      // Each emit may produce two event types per the W94 matrix:
      //   PROJECT_SUBMITTED        → staff-lead by amphoe
      //   PROJECT_SUBMITTED_OWNER  → owner (createdBy WorkHistory)
      const amphoeStaffCache = new Map<
        string,
        ProjectNotificationRecipient[]
      >();
      const ownerCache = new Map<string, ProjectNotificationRecipient[]>();

      // Group key → group state.
      // Key: `${recipientUserId}::${eventType}`.
      // Value: the resolved recipient + accumulated project descriptors +
      // per-emit project metadata (used to populate the per-project events
      // when group has only one project — fallback path).
      type GroupState = {
        recipient: ProjectNotificationRecipient;
        eventType: ProjectNotificationEventType;
        // Each entry pairs the emit (for the per-project fallback path)
        // with the rendered descriptor (for the digest path).
        emits: BulkSubmitEmit[];
        descriptors: DigestProjectDescriptor[];
      };
      const groups = new Map<string, GroupState>();

      for (const emit of emits) {
        const descriptor: DigestProjectDescriptor = {
          projectId: emit.projectId,
          projectName: emit.projectName,
          fromStatus: emit.fromStatus,
          toStatus: emit.toStatus,
          fromStatusTh,
          toStatusTh,
        };

        // ── Staff-side resolution (amphoe). Empty list (e.g. no amphoe set
        //    on the project, or no staff-leads in that amphoe) is silently
        //    skipped — same semantics as `dispatchPhaseOneNotification`.
        if (projectKind === 'project-group' && emit.amphoeId) {
          let staffLeads = amphoeStaffCache.get(emit.amphoeId);
          if (!staffLeads) {
            staffLeads = await this.recipientResolver.resolveStaffLeadByAmphoe(
              emit.amphoeId,
            );
            amphoeStaffCache.set(emit.amphoeId, staffLeads);
          }
          for (const recipient of staffLeads) {
            this.addToGroup(
              groups,
              recipient,
              'PROJECT_SUBMITTED',
              emit,
              descriptor,
            );
          }
        }
        // Future: revision/change branch via resolveStaffLeadByAgency.

        // ── Owner-side resolution. Same submitter across the batch, so
        //    every emit folds into one PROJECT_SUBMITTED_OWNER group.
        if (emit.ownerWorkHistoryId) {
          let ownerRecipients = ownerCache.get(emit.ownerWorkHistoryId);
          if (!ownerRecipients) {
            ownerRecipients = await this.recipientResolver.resolveOwner(
              emit.ownerWorkHistoryId,
            );
            ownerCache.set(emit.ownerWorkHistoryId, ownerRecipients);
          }
          for (const recipient of ownerRecipients) {
            this.addToGroup(
              groups,
              recipient,
              'PROJECT_SUBMITTED_OWNER',
              emit,
              descriptor,
            );
          }
        }
      }

      // ── Dispatch each group ────────────────────────────────────────────
      for (const [, group] of groups) {
        const projectCount = group.descriptors.length;
        if (projectCount === 0) continue;

        if (projectCount === 1) {
          // N=1 fallback — use the existing per-project events so behavior
          // is identical to the pre-W105 single-submit path. The single
          // emit is at index 0 by construction.
          await this.dispatchSingleProject({
            recipient: group.recipient,
            eventType: group.eventType,
            emit: group.emits[0],
            descriptor: group.descriptors[0],
            projectKind,
            actorUserId,
            actorWorkHistoryId,
          });
        } else {
          await this.dispatchDigest({
            recipient: group.recipient,
            eventType: group.eventType,
            descriptors: group.descriptors,
            projectKind,
            actorUserId,
            actorWorkHistoryId,
          });
        }
      }
    } catch (err) {
      // Belt-and-braces: a thrown error inside resolution must not cascade
      // into the workflow caller. The caller is `bulkSubmit`, which has
      // already committed the per-project transactions and returned the
      // results array.
      this.logger.warn(
        `[NotifyDigest] dispatch unexpected-error err=${(err as Error).message}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private addToGroup(
    groups: Map<
      string,
      {
        recipient: ProjectNotificationRecipient;
        eventType: ProjectNotificationEventType;
        emits: BulkSubmitEmit[];
        descriptors: DigestProjectDescriptor[];
      }
    >,
    recipient: ProjectNotificationRecipient,
    eventType: ProjectNotificationEventType,
    emit: BulkSubmitEmit,
    descriptor: DigestProjectDescriptor,
  ): void {
    const key = `${recipient.userId}::${eventType}`;
    let state = groups.get(key);
    if (!state) {
      state = { recipient, eventType, emits: [], descriptors: [] };
      groups.set(key, state);
    }
    state.emits.push(emit);
    state.descriptors.push(descriptor);
  }

  /**
   * N=1 fallback path — emit the existing per-project event so the
   * single-project UX is unchanged. We build a `ProjectNotificationEvent`
   * with a single recipient and call queueEmail / queueLine directly.
   *
   * We bypass `RecipientResolverService` here because the recipient is
   * already pre-resolved by the dispatcher. This is intentional and parity
   * with how `dispatchPhaseOneNotification` builds an event with a known
   * recipient list.
   */
  private async dispatchSingleProject(args: {
    recipient: ProjectNotificationRecipient;
    eventType: ProjectNotificationEventType;
    emit: BulkSubmitEmit;
    descriptor: DigestProjectDescriptor;
    projectKind: 'project-group' | 'revised-project-group';
    actorUserId: string | null;
    actorWorkHistoryId: string | null;
  }): Promise<void> {
    const event: ProjectNotificationEvent =
      this.notificationsEmailService.buildEvent({
        eventType: args.eventType,
        projectId: args.emit.projectId,
        projectName: args.emit.projectName,
        fromStatus: args.emit.fromStatus,
        toStatus: args.emit.toStatus,
        fromStatusTh: args.descriptor.fromStatusTh,
        toStatusTh: args.descriptor.toStatusTh,
        projectKind: args.projectKind,
        recipients: [args.recipient],
        metadata: {
          kind: args.projectKind,
          planName: args.emit.planName ?? null,
        },
        actorUserId: args.actorUserId ?? undefined,
        actorWorkHistoryId: args.actorWorkHistoryId ?? undefined,
      });

    try {
      await this.notificationsEmailService.queueEmail(event);
    } catch (err) {
      this.logger.warn(
        `[NotifyDigest] N=1 fallback email failed event=${args.eventType} project=${args.emit.projectId} err=${(err as Error).message}`,
      );
    }
    try {
      await this.notificationsLineService.queueLine(event);
    } catch (err) {
      this.logger.warn(
        `[NotifyDigest] N=1 fallback line failed event=${args.eventType} project=${args.emit.projectId} err=${(err as Error).message}`,
      );
    }
    this.logger.log(
      `[NotifyDigest] N=1 fallback emitted event=${args.eventType} recipient=${args.recipient.userId} project=${args.emit.projectId}`,
    );
  }

  /**
   * N>=2 digest path — emit the digest event types on both channels. The
   * concrete digest job payloads (totalCount, projects[], actionLink) are
   * built INSIDE the email/line services, branching on event type. This
   * service hands them an envelope that carries everything they need.
   */
  private async dispatchDigest(args: {
    recipient: ProjectNotificationRecipient;
    eventType: ProjectNotificationEventType;
    descriptors: DigestProjectDescriptor[];
    projectKind: 'project-group' | 'revised-project-group';
    actorUserId: string | null;
    actorWorkHistoryId: string | null;
  }): Promise<void> {
    const digestEventType =
      args.eventType === 'PROJECT_SUBMITTED'
        ? 'PROJECT_SUBMITTED_DIGEST'
        : 'PROJECT_SUBMITTED_OWNER_DIGEST';

    // We reuse `signActionLink` via `buildEvent` so the queue page link
    // is signed with the same HMAC scheme as single-project events.
    // `projectId` is set to the FIRST project's id; the link itself is a
    // queue-listing deep-link (resolveActionPath returns a list path for
    // PROJECT_SUBMITTED / PROJECT_SUBMITTED_OWNER), so the projectId in
    // the signature is incidental but still scoped to the recipient's
    // batch.
    const firstProjectId = args.descriptors[0].projectId;
    const projectName = `${args.descriptors.length} โครงการ`; // display-only fallback
    const event: ProjectNotificationEvent =
      this.notificationsEmailService.buildEvent({
        eventType: digestEventType,
        projectId: firstProjectId,
        projectName,
        fromStatus: 'Ready',
        toStatus: 'Pending',
        fromStatusTh: args.descriptors[0].fromStatusTh,
        toStatusTh: args.descriptors[0].toStatusTh,
        projectKind: args.projectKind,
        recipients: [args.recipient],
        metadata: {
          kind: args.projectKind,
          // Carry the digest descriptors through the metadata channel so
          // the email + line services can reconstruct the templateCtx /
          // flex builder input without re-querying.
          // The metadata bag accepts string|number|null|undefined values;
          // we serialize the descriptor list as JSON to satisfy the type
          // contract while preserving fidelity.
          digestProjects: JSON.stringify(args.descriptors),
          digestTotalCount: args.descriptors.length,
        },
        actorUserId: args.actorUserId ?? undefined,
        actorWorkHistoryId: args.actorWorkHistoryId ?? undefined,
      });

    try {
      await this.notificationsEmailService.queueEmail(event);
    } catch (err) {
      this.logger.warn(
        `[NotifyDigest] digest email failed event=${digestEventType} recipient=${args.recipient.userId} err=${(err as Error).message}`,
      );
    }
    try {
      await this.notificationsLineService.queueLine(event);
    } catch (err) {
      this.logger.warn(
        `[NotifyDigest] digest line failed event=${digestEventType} recipient=${args.recipient.userId} err=${(err as Error).message}`,
      );
    }
    this.logger.log(
      `[NotifyDigest] digest emitted event=${digestEventType} recipient=${args.recipient.userId} projects=${args.descriptors.length}`,
    );
  }

  /**
   * Best-effort lookup of `status.th_name` for a canonical status name.
   * Mirrors the usage in `dispatchPhaseOneNotification`. Returns
   * `undefined` on miss so templates can fall back to canonical English.
   */
  private async lookupStatusTh(name: string): Promise<string | undefined> {
    try {
      const row = await this.statusRepo.findOne({
        where: { name },
        select: ['name', 'th_name'],
      });
      return row?.th_name ?? undefined;
    } catch (err) {
      this.logger.debug(
        `[NotifyDigest] status-th-lookup failed name=${name} err=${(err as Error).message}`,
      );
      return undefined;
    }
  }
}
