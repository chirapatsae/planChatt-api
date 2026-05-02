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
  | 'EMAIL_VERIFICATION_REQUEST';

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
