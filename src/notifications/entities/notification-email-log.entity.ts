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
 * NotificationEmailLog — Wave 21 advisory audit row.
 *
 * Source of truth:
 *   - docs/architecture/EMAIL_NOTIFICATION.md §4.2
 *   - Migration: backend/src/migrations/1745712000000-CreateNotificationEmailLogs.ts
 *   - CLAUDE.md §14 (no FK to project tables)
 *   - CLAUDE.md §17.3 (audit separation — analogous pattern)
 *
 * Invariants:
 *   - `targetId` is a loose uuid reference; NO TypeORM relation to any
 *     project entity. Rollback hard-deletes (§14.6) MUST NOT cascade here.
 *   - `recipientUserId` FK to `users.id` is permitted — users are not
 *     project tables and do not participate in §14 lineage locking.
 *   - This row does NOT gate any workflow transition. It is purely
 *     advisory / audit.
 *
 * NOTE: This entity is intentionally NOT registered in any module in
 * this wave. N1 (backend-api) will wire it into the new wave-21 email
 * `NotificationsModule` via `TypeOrmModule.forFeature([...])` once that
 * module lands.
 */
@Entity('notification_email_logs')
@Index('ix_notification_email_logs_target', ['targetKind', 'targetId'])
@Index('ix_notification_email_logs_recipient', ['recipientUserId'])
@Index('ix_notification_email_logs_queued_at', ['queuedAt'])
@Index('ix_notification_email_logs_event_status', ['eventType', 'status'])
// Wave 22 B1 — composite index on (actor_user_id, queued_at DESC) used by
// the super-admin email-stats top-senders aggregation. The column +
// physical index are created by the D1 migration
// `1746000000000-AddActorAndKillSwitchToNotifications`; the decorator here
// is kept declarative-consistent with TypeORM entity metadata. TypeORM's
// `synchronize` is disabled in this project so this will NOT attempt a
// duplicate CREATE INDEX at runtime.
@Index('ix_notification_email_logs_actor_queued', ['actorUserId', 'queuedAt'])
export class NotificationEmailLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Canonical event type. Examples:
   *   - 'PROJECT_SUBMITTED'
   *   - 'PROJECT_RETURNED_FOR_REVISION'
   *   - 'PROJECT_APPROVED'
   * Phase-2 event types (STAFF_BACKLOG_ALERT, AI_HIGH_RISK_ALERT) will
   * reuse the same column without schema change.
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

  @Column({ name: 'recipient_email', type: 'varchar', length: 255 })
  recipientEmail: string;

  /**
   * Wave 22 B1 — WORKFLOW ACTOR user id.
   *
   * The user whose WorkHistory triggered the workflow transition that
   * produced this notification. Populated from `workHistory.user.id` at
   * the 4 `dispatchPhaseOneNotification` emit sites in
   * `tracking-status.service.ts`.
   *
   * Constraints:
   *   - Nullable: pre-Wave-22 rows + any row where the actor cannot be
   *     resolved (e.g. system-initiated emit) leave this NULL.
   *   - FK → users(id) ON DELETE SET NULL (D1 migration).
   *   - MUST NOT FK into any project table (§14 / §17.3 — advisory row).
   *   - `top-senders` aggregation filters `actor_user_id IS NOT NULL` so
   *     pre-Wave-22 history does not pollute the leaderboard.
   */
  @Column({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'actor_user_id' })
  actorUser?: User | null;

  /**
   * Wave 22 B1 — WORKFLOW ACTOR work-history id.
   *
   * The WorkHistory row that represents the actor's organizational
   * context at the moment of the workflow transition (CLAUDE.md §4
   * ownership model). Stored as a loose UUID reference with NO foreign
   * key because WorkHistory rows are archival — a FK could block
   * WorkHistory cleanup and would not add integrity value on an
   * advisory-only audit row.
   *
   * Constraints:
   *   - Nullable: same rationale as `actorUserId`.
   *   - No FK (see above).
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
   */
  @Column({ name: 'status', type: 'varchar', length: 32 })
  status: string;

  @Column({ name: 'attempts', type: 'int', default: 0 })
  attempts: number;

  /**
   * Provider tag. Examples: 'gmail', 'postmark', 'sendgrid'.
   * Null for `skipped-preference` rows that never reached a provider.
   */
  @Column({ name: 'provider', type: 'varchar', length: 32, nullable: true })
  provider?: string | null;

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
