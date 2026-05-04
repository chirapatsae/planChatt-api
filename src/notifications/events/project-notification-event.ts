/**
 * Wave 21 — Email notification events (Phase 1).
 *
 * These events are emitted AFTER a workflow transition commits. They are advisory
 * signals only (§4.1, §17.2) — failure to deliver MUST NEVER fail a workflow
 * transition and MUST NEVER write to tracking_status (§12).
 */

export type ProjectNotificationEventType =
  | 'PROJECT_SUBMITTED'
  | 'PROJECT_RETURNED_FOR_REVISION'
  | 'PROJECT_APPROVED'
  // Wave 91 — owner-triggered pull back (Pending/Verified → Pull_Back).
  // Recipients: staff-lead in the project's amphoe (main plan) /
  // responsibleAgency (revision/change) — same resolver as PROJECT_SUBMITTED.
  // Owner does NOT receive (they performed the action).
  | 'PROJECT_PULLED_BACK'
  // Wave 94 — owner-side notification matrix completion. These events fire
  // ALONGSIDE existing staff-side events (e.g. PROJECT_SUBMITTED for staff
  // fans out staff fanout AND PROJECT_SUBMITTED_OWNER fans out owner
  // confirmation in the same transition). Government context: owners need
  // proof-of-submission and progress visibility, not just final outcomes.
  | 'PROJECT_SUBMITTED_OWNER'   // Ready→Pending — confirmation to owner
  | 'PROJECT_VERIFIED_OWNER'    // Pending→Verified — progress update to owner
  | 'PROJECT_REJECTED_OWNER'    // *→Rejected (W67) — final outcome to owner
  // Wave 95 — link-based email-verification request (Q1). NOT a workflow
  // notification — it carries a user-scoped HMAC verify link rather than a
  // project deep-link. Reuses the existing Bull queue + EmailService
  // chokepoint so W90 sandbox + audit logging behave identically. See
  // `BYPASS_VERIFICATION_GATE` below for the W95-GATE bypass set, and
  // `event.bypassAllowEmailNotification` for the consent-bypass flag used
  // ONLY by the first-login auto-fire path (NEVER by the user-initiated
  // resend button).
  | 'EMAIL_VERIFICATION_REQUEST'
  // W105 BE-PR2 — bulk-submit digest event types. Emitted by the digest
  // dispatcher AFTER `bulkSubmit` commits; one job per
  // (recipientUserId, eventType) group when group.projects.length >= 2.
  // N=1 groups fall back to the single-project events
  // (`PROJECT_SUBMITTED` / `PROJECT_SUBMITTED_OWNER`) so single-project
  // submit UX is unchanged. §17.3 — these events carry an array of
  // project descriptors but their queue payload references projects by
  // UUID only and never FKs into project tables.
  | 'PROJECT_SUBMITTED_DIGEST'        // staff-lead recipients (carousel digest)
  | 'PROJECT_SUBMITTED_OWNER_DIGEST'; // owner self-receipt (carousel digest)

/**
 * Wave 95 — Event types that MUST bypass the email-verification gate
 * (`emailVerifiedAt IS NULL` block) added by W95-GATE on the
 * queueEmail / sendPreparedJob path.
 *
 * This set exists because the verification email itself is sent to an
 * UNVERIFIED address — gating it on `emailVerifiedAt` would create a
 * deadlock where a user can never receive the message that would make
 * them verified. The set is intentionally narrow (only the verification
 * request itself) so no other event type can accidentally opt out.
 *
 * Owned by W95-VERIFY-FLOW; CONSUMED by W95-GATE.
 */
export const BYPASS_VERIFICATION_GATE: ReadonlySet<ProjectNotificationEventType> =
  new Set<ProjectNotificationEventType>(['EMAIL_VERIFICATION_REQUEST']);

/**
 * Wave 96 — events that the LINE channel sends. The trigger-wiring node
 * fans out to BOTH email and LINE for every transition; LINE-side fanout
 * is filtered by this allowlist so only owner-facing events fire over LINE.
 *
 * Owner-side only per Q2: government context favors LINE for personal
 * progress awareness, not staff workflow notifications. Staff continue
 * to use email + dashboard for fanouts.
 *
 * Closed list — adding a new event here requires a corresponding Flex
 * template in `backend/src/notifications/templates/line/`.
 */
export const LINE_EVENT_ALLOWLIST: ReadonlySet<ProjectNotificationEventType> =
  new Set<ProjectNotificationEventType>([
    'PROJECT_SUBMITTED_OWNER',
    'PROJECT_VERIFIED_OWNER',
    'PROJECT_RETURNED_FOR_REVISION',
    'PROJECT_APPROVED',
    'PROJECT_REJECTED_OWNER',
    // W96F — staff-side LINE awareness. The W96 Q2 government-context bet
    // (staff use email + dashboard, don't need LINE alerts) was inverted by
    // first-test feedback: Thai government staff use LINE more than email,
    // and a queue-arrival LINE alert materially improves response time.
    //   PROJECT_SUBMITTED   — staff-lead in amphoe gets "new project to review"
    //   PROJECT_PULLED_BACK — staff-lead gets "project withdrawn from queue"
    // The fanout cap at RecipientResolverService.filterAndCap (W21 R5) still
    // bounds blast radius for busy amphoes.
    'PROJECT_SUBMITTED',
    'PROJECT_PULLED_BACK',
    // W105 BE-PR2 — digest variants ride the same allowlist; otherwise
    // `NotificationsLineService.queueLine` would gate them out at Gate 1
    // and the staff/owner digest carousels would never be enqueued.
    'PROJECT_SUBMITTED_DIGEST',
    'PROJECT_SUBMITTED_OWNER_DIGEST',
  ]);

/**
 * Phase 2 event types — design-only stubs. Handlers/templates exist but are
 * not wired to any cron / trigger in Wave 21.
 */
export type Phase2NotificationEventType =
  | 'STAFF_BACKLOG_ALERT'
  | 'AI_HIGH_RISK_ALERT';

export interface ProjectNotificationRecipient {
  userId: string;
  email: string;
  workHistoryId: string;
}

/**
 * Wave 96 — LINE-channel recipient shape. Produced by
 * `RecipientResolverService.enrichWithLineBindings()` from a list of
 * email-shaped recipients by joining `line_user_bindings` (active rows
 * only) and filtering out users who have opted out via
 * `users.allowLineNotification = false`.
 *
 * §17.3 — `lineUserId` is sourced from `line_user_bindings` (canonical
 * per W86); the legacy `users.lineId` column is NOT consulted.
 *
 * Extends `ProjectNotificationRecipient` per the W96-RECIPIENT-RESOLVER
 * spec — preserves `email` so the same recipient instance can be carried
 * through dispatch surfaces that surface a per-user channel-summary
 * (e.g. operator audit). The dispatch-time queue payload
 * (`LineNotificationJobPayload`) drops the `email` field — it carries
 * `{ userId, lineUserId, workHistoryId }` only.
 */
export interface ProjectNotificationLineRecipient
  extends ProjectNotificationRecipient {
  lineUserId: string;
}

/**
 * Contract consumed by NotificationsEmailService.queueEmail.
 *
 * `recipients` MUST be pre-resolved (by workflow emitter or RecipientResolverService)
 * — the service itself does NOT re-resolve. The `allowEmailNotification` + email-null
 * gate is enforced inside the service (double-gated at enqueue + processor per §2.4).
 */
export interface ProjectNotificationEvent {
  eventType: ProjectNotificationEventType;
  projectId: string;
  projectName: string;
  fromStatus: string;
  toStatus: string;
  /**
   * Wave 92 — Thai display labels resolved from `status.th_name` per CLAUDE.md
   * W67 single source of truth. Hard-coded canonical→Thai maps are forbidden.
   * Optional only because legacy callers may not have set them yet; templates
   * fall back to canonical English when these are missing.
   */
  fromStatusTh?: string;
  toStatusTh?: string;
  /** Only populated for PROJECT_RETURNED_FOR_REVISION. Staff-authored free text. */
  reason?: string;
  /** Signed URL with TTL (see NotificationsEmailService.signActionLink). */
  actionLink: string;
  recipients: ProjectNotificationRecipient[];
  /** Optional display-only metadata (project kind, plan label, etc.). */
  metadata?: Record<string, string | number | null | undefined>;

  /**
   * Wave 22 B1 — WORKFLOW ACTOR threading.
   *
   * `actorUserId` and `actorWorkHistoryId` identify the user (and their
   * organizational context via WorkHistory) who performed the workflow
   * transition that produced this notification. These values are threaded
   * from the 4 `dispatchPhaseOneNotification` emit sites in
   * `tracking-status.service.ts` through `buildEvent()` / `queueEmail()`
   * and persisted onto every resulting `notification_email_logs` row.
   *
   * Constraints:
   *   - Optional — pre-existing emit sites / system emits may omit.
   *   - Advisory only (§4.1, §17.2). These fields MUST NOT gate any
   *     workflow transition and MUST NOT influence recipient resolution.
   *   - MUST NOT carry PII beyond the UUIDs.
   */
  actorUserId?: string;
  actorWorkHistoryId?: string;

  /**
   * Wave 95 — Consent-bypass flag for the `allowEmailNotification` preference
   * gate. ONLY the initial first-login auto-fire path (where the user has
   * not yet had a chance to set their preference) MAY set this to `true`.
   * The user-initiated "Resend" button MUST NOT set this — explicit consent
   * applies even to the verification email if the user has opted out.
   *
   * §17.2 advisory — this flag is a consent override, NOT a workflow
   * authority bypass. It only relaxes the preference gate, never the
   * verification-status gate (W95-GATE) which is governed separately by
   * `BYPASS_VERIFICATION_GATE` keyed on event type.
   */
  bypassAllowEmailNotification?: boolean;
}

/**
 * Serializable payload persisted into the Bull queue. MUST NOT carry ORM
 * entities — only primitive IDs + minimal display fields — so the queue
 * remains portable across process restarts (R2).
 */
export interface ProjectNotificationJobPayload {
  eventType: ProjectNotificationEventType;
  projectId: string;
  projectName: string;
  fromStatus: string;
  toStatus: string;
  /** Wave 92 — Thai labels (see ProjectNotificationEvent). */
  fromStatusTh?: string;
  toStatusTh?: string;
  reason?: string;
  actionLink: string;
  recipient: ProjectNotificationRecipient;
  metadata?: Record<string, string | number | null | undefined>;

  /** Wave 22 B1 — see ProjectNotificationEvent.actorUserId. */
  actorUserId?: string;
  /** Wave 22 B1 — see ProjectNotificationEvent.actorWorkHistoryId. */
  actorWorkHistoryId?: string;

  /** Wave 95 — see ProjectNotificationEvent.bypassAllowEmailNotification. */
  bypassAllowEmailNotification?: boolean;
}

/**
 * W105 BE-PR2 — Per-project descriptor used inside the digest event /
 * payload. Mirrors the §17.3 audit-separation discipline: project rows
 * are referenced by UUID only and the descriptor carries the display
 * fields the renderer needs so the dispatcher does not have to re-query.
 */
export interface DigestProjectDescriptor {
  projectId: string;
  projectName: string;
  fromStatus: string;
  toStatus: string;
  fromStatusTh?: string;
  toStatusTh?: string;
}

/**
 * W105 BE-PR2 — In-process event consumed by the email + LINE digest
 * branches of `NotificationsEmailService.queueEmail` /
 * `NotificationsLineService.queueLine`. Distinct from
 * `ProjectNotificationEvent` because:
 *   - it carries a `projects[]` array, not a single project
 *   - it carries a single `recipient` (digest jobs are 1 recipient × N
 *     projects; the dispatcher pre-resolves and groups by recipient)
 *
 * §17.2 advisory — digest events MUST NOT gate any workflow transition.
 * §17.3 audit separation — descriptors carry no FK; project deletion
 * after digest enqueue is intentionally tolerated (the rendered job
 * still emits with the captured project name).
 */
export interface ProjectNotificationDigestEvent {
  eventType: 'PROJECT_SUBMITTED_DIGEST' | 'PROJECT_SUBMITTED_OWNER_DIGEST';
  recipient: ProjectNotificationRecipient;
  projects: DigestProjectDescriptor[];
  /** Deep link to the queue / submitted page. */
  actionLink: string;
  /** `'project-group'` for main plan; future-proofed for revision/change. */
  projectKind: 'project-group' | 'revised-project-group';
  /** §4.1 advisory — workflow actor (display only on stats surfaces). */
  actorUserId?: string;
  actorWorkHistoryId?: string;
}

/**
 * W105 BE-PR2 — Serializable digest payload persisted into the email
 * Bull queue. Distinct shape from `ProjectNotificationJobPayload` so the
 * processor can branch on `'projects' in payload` without ambiguity.
 *
 * `projects[]` is the rendered list passed to the handlebars
 * `{{#each projects}}` loop. `recipient` is a single recipient (1 job =
 * 1 recipient × N projects).
 */
export interface ProjectNotificationDigestEmailPayload {
  eventType: 'PROJECT_SUBMITTED_DIGEST' | 'PROJECT_SUBMITTED_OWNER_DIGEST';
  totalCount: number;
  projects: DigestProjectDescriptor[];
  actionLink: string;
  recipient: ProjectNotificationRecipient;
  /** Display-only metadata; mirrors `ProjectNotificationJobPayload.metadata`. */
  metadata?: Record<string, string | number | null | undefined>;
  actorUserId?: string;
  actorWorkHistoryId?: string;
}

/**
 * W105 BE-PR2 — Serializable digest payload persisted into the LINE
 * Bull queue. Mirror of `ProjectNotificationDigestEmailPayload` but
 * with the LINE-specific recipient shape (lineUserId).
 */
export interface ProjectNotificationDigestLinePayload {
  eventType: 'PROJECT_SUBMITTED_DIGEST' | 'PROJECT_SUBMITTED_OWNER_DIGEST';
  totalCount: number;
  projects: DigestProjectDescriptor[];
  actionLink: string;
  recipient: {
    userId: string;
    lineUserId: string;
    workHistoryId: string;
  };
  metadata?: Record<string, string | number | null | undefined>;
  actorUserId?: string;
  actorWorkHistoryId?: string;
}

/**
 * Wave 96 — Serializable payload for the `notifications-line` Bull queue.
 * Mirror of ProjectNotificationJobPayload but with LINE-specific recipient
 * shape (lineUserId instead of email).
 *
 * Channel-specific resolution (email vs LINE recipient shape) happens at
 * dispatch time — the workflow event layer (`ProjectNotificationEvent`)
 * remains channel-agnostic per §17.2 advisory boundary.
 */
export interface LineNotificationJobPayload {
  eventType: ProjectNotificationEventType;
  projectId: string;
  projectName: string;
  fromStatus: string;
  toStatus: string;
  /** Wave 92 — Thai labels (see ProjectNotificationEvent). */
  fromStatusTh?: string;
  toStatusTh?: string;
  reason?: string;
  actionLink: string;
  recipient: {
    userId: string;
    lineUserId: string;
    workHistoryId: string;
  };
  metadata?: Record<string, string | number | null | undefined>;

  /** Wave 22 B1 — see ProjectNotificationEvent.actorUserId. */
  actorUserId?: string;
  /** Wave 22 B1 — see ProjectNotificationEvent.actorWorkHistoryId. */
  actorWorkHistoryId?: string;
}
