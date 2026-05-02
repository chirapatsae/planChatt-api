import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from 'src/users/entities/user.entity';

/**
 * NotificationLineLog — Wave 96 advisory audit row for LINE channel.
 *
 * Source of truth:
 *   - docs/tasks/wave96/W96-MIGRATION.md §3
 *   - Migration: backend/src/migrations/<timestamp>-W96AddLineNotificationSchema.ts
 *   - CLAUDE.md §14 (no FK to project tables)
 *   - CLAUDE.md §17.3 (audit separation — analogous pattern to email log)
 *   - W83 — `recipient_line_user_id` is stored at rest but MUST NEVER appear
 *     in plaintext in log lines; callers use `LineMessagingService.shortHash`
 *     before emitting any log line.
 *
 * Invariants:
 *   - `targetId` is a loose uuid reference; NO TypeORM relation to any
 *     project entity. Rollback hard-deletes (§14.6) MUST NOT cascade here.
 *   - `recipientUserId` / `actorUserId` FK to `users.id` are permitted —
 *     users are not project tables and do not participate in §14 lineage
 *     locking. Both use ON DELETE SET NULL so audit history survives a user
 *     hard-delete.
 *   - This row does NOT gate any workflow transition. It is purely
 *     advisory / audit (§17.2).
 */
@Entity('notification_line_logs')
@Index('ix_notification_line_logs_target', ['targetKind', 'targetId'])
@Index('ix_notification_line_logs_recipient', ['recipientUserId'])
@Index('ix_notification_line_logs_queued_at', ['queuedAt'])
@Index('ix_notification_line_logs_event_status', ['eventType', 'status'])
@Index('ix_notification_line_logs_actor_queued', ['actorUserId', 'queuedAt'])
export class NotificationLineLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Canonical event type. Members of `LINE_EVENT_ALLOWLIST` per
   * `events/project-notification-event.ts`. Examples:
   *   - 'PROJECT_SUBMITTED_OWNER'
   *   - 'PROJECT_VERIFIED_OWNER'
   *   - 'PROJECT_RETURNED_FOR_REVISION'
   *   - 'PROJECT_APPROVED'
   *   - 'PROJECT_REJECTED_OWNER'
   */
  @Column({ name: 'event_type', type: 'varchar', length: 64 })
  eventType: string;

  /**
   * Loose discriminator for `targetId`. One of:
   *   - 'project-group'
   *   - 'revised-project-group'
   *   - 'supplement-project-group'
   */
  @Column({ name: 'target_kind', type: 'varchar', length: 32 })
  targetKind: string;

  /**
   * Loose uuid reference to the target project row.
   * INTENTIONALLY NOT an FK (§14 / §17.3).
   */
  @Column({ name: 'target_id', type: 'uuid' })
  targetId: string;

  /**
   * FK to users.id with ON DELETE SET NULL (see migration).
   * Nullable after a user is deleted so audit history survives.
   */
  @Column({ name: 'recipient_user_id', type: 'uuid', nullable: true })
  recipientUserId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'recipient_user_id' })
  recipientUser?: User | null;

  /**
   * LINE U-prefixed user id (≤ 64 chars). Stored at rest for audit
   * forensics, but MUST NEVER be emitted in plaintext to log lines —
   * use `LineMessagingService.shortHash` (8-char SHA-256 prefix) when
   * the value needs to appear in operator-visible logs (W83).
   */
  @Column({ name: 'recipient_line_user_id', type: 'varchar', length: 64 })
  recipientLineUserId: string;

  /**
   * Wave 22 B1 parity — WORKFLOW ACTOR user id.
   *
   * The user whose WorkHistory triggered the workflow transition that
   * produced this notification. Threaded from the trigger-wiring sites
   * in `tracking-status.service.ts` exactly like the email path.
   *
   * Constraints:
   *   - Nullable: legacy / system-initiated emits leave this NULL.
   *   - FK → users(id) ON DELETE SET NULL.
   *   - MUST NOT FK into any project table (§14 / §17.3).
   */
  @Column({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'actor_user_id' })
  actorUser?: User | null;

  /**
   * Wave 22 B1 parity — WORKFLOW ACTOR work-history id.
   *
   * Stored as a loose UUID reference with NO foreign key. WorkHistory
   * rows are archival; a FK could block WorkHistory cleanup and would
   * not add integrity value on an advisory-only audit row.
   */
  @Column({ name: 'actor_work_history_id', type: 'uuid', nullable: true })
  actorWorkHistoryId: string | null;

  @Column({
    name: 'queued_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  queuedAt: Date;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt?: Date | null;

  /**
   * Lifecycle status. One of:
   *   - 'queued'
   *   - 'sent'
   *   - 'failed'
   *   - 'skipped-preference'
   *   - 'skipped-killswitch'
   *   - 'skipped-allowlist'   — event type not in LINE_EVENT_ALLOWLIST
   *   - 'skipped-not-linked'  — no active line_user_bindings row at enqueue
   *   - 'skipped-unlinked'    — binding disappeared between enqueue and dispatch
   */
  @Column({ name: 'status', type: 'varchar', length: 32 })
  status: string;

  @Column({ name: 'attempts', type: 'int', default: 0 })
  attempts: number;

  /**
   * Provider tag. Default 'line-messaging' (the LINE Messaging API push
   * endpoint). Reserved for future provider rotation.
   */
  @Column({
    name: 'provider',
    type: 'varchar',
    length: 32,
    nullable: true,
    default: 'line-messaging',
  })
  provider?: string | null;

  /**
   * `x-line-request-id` from the push API response when available.
   * Used for ops correlation against LINE platform logs.
   */
  @Column({
    name: 'provider_message_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  providerMessageId?: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage?: string | null;

  @Column({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  createdAt: Date;

  @Column({
    name: 'updated_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  updatedAt: Date;
}
