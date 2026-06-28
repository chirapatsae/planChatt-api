import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { CitizenIdentity } from './citizen-identity.entity';
import { CitizenPost } from './citizen-post.entity';

/**
 * citizen_notification — "someone interacted with YOUR post".
 *
 * C3 (plan D14): when a citizen comments on or hearts another citizen's post,
 * the post author receives ONE notification, created synchronously in the SAME
 * transaction as the comment/heart write (single-recipient → no fanout). Heart
 * notifications fire ONLY when a heart is ADDED (never on unheart). A self-
 * interaction (author === actor) is a NO-OP — you are not notified about your
 * own action.
 *
 * C4 (plan D12): an `official_response` notification is fired when an INTERNAL
 * staff member posts an official response. Such notices have NO citizen actor
 * — `actor_identity_id` is NULL — so the column is nullable (the FE renders a
 * fixed official-response copy with no actor alias).
 *
 * D11/D16: a notification MAY name the acting alias ("X commented on your
 * post") but this table is NOT a queryable follower-of-me list — it is indexed
 * by RECIPIENT only and never exposes "who follows me".
 *
 * §17.3 isolation: ALL FKs are citizen_* → citizen_* —
 * `recipient_identity_id` / `actor_identity_id → citizen_identities` and
 * `post_id → citizen_post`. `comment_id` is a PLAIN uuid (no relation). Zero
 * FK into project / users / work_history / tracking_status.
 */
@Entity('citizen_notification')
@Index('ix_citizen_notification_recipient', ['recipientIdentityId', 'createdAt'])
export class CitizenNotification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'recipient_identity_id', type: 'uuid' })
  recipientIdentityId: string;

  @ManyToOne(() => CitizenIdentity)
  @JoinColumn({ name: 'recipient_identity_id' })
  recipient: CitizenIdentity;

  /**
   * Nullable as of C4 (official-response notices have no citizen actor). The
   * comment/heart write paths always populate it; only `official_response`
   * leaves it NULL.
   */
  @Column({ name: 'actor_identity_id', type: 'uuid', nullable: true })
  actorIdentityId: string | null;

  @ManyToOne(() => CitizenIdentity)
  @JoinColumn({ name: 'actor_identity_id' })
  actor: CitizenIdentity | null;

  /**
   * `comment` | `heart` | `official_response`. CHECK enforced in migration.
   * Length 32 (was 16): `official_response` (C4) is 17 chars and overflowed the
   * original varchar(16). This was a latent C4 defect — the official-response
   * notification path was never exercised until the W-G2 status-change notify,
   * which surfaced `value too long for type character varying(16)`. Widened (+
   * idempotent bootstrap ALTER for prod parity).
   */
  @Column({ name: 'kind', type: 'varchar', length: 32 })
  kind: string;

  @Column({ name: 'post_id', type: 'uuid', nullable: true })
  postId: string | null;

  @ManyToOne(() => CitizenPost)
  @JoinColumn({ name: 'post_id' })
  post: CitizenPost | null;

  /** Plain uuid — no relation (the comment row need not survive for the notice). */
  @Column({ name: 'comment_id', type: 'uuid', nullable: true })
  commentId: string | null;

  @Column({ name: 'read_at', type: 'timestamptz', nullable: true })
  readAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
