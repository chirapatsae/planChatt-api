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
  | 'PROJECT_APPROVED';

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
  reason?: string;
  actionLink: string;
  recipient: ProjectNotificationRecipient;
  metadata?: Record<string, string | number | null | undefined>;

  /** Wave 22 B1 — see ProjectNotificationEvent.actorUserId. */
  actorUserId?: string;
  /** Wave 22 B1 — see ProjectNotificationEvent.actorWorkHistoryId. */
  actorWorkHistoryId?: string;
}
