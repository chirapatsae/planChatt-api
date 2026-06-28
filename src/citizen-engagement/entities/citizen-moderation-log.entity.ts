import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * citizen_moderation_log — append-only moderation history.
 *
 * §17.3 isolation: the internal moderator is stored as a PLAIN uuid
 * `actor_work_history_id` with NO FK (mirrors `ai_knowledge_audit_logs`).
 * The reported subject is referenced by plain `post_id` / `comment_id` /
 * `reporter_identity_id` (no FK). This is an audit table — it NEVER writes
 * `tracking_status` (§17.3) and has no soft-delete (append-only).
 */
@Entity('citizen_moderation_log')
@Index('ix_citizen_moderation_post', ['postId', 'createdAt'])
export class CitizenModerationLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'post_id', type: 'uuid', nullable: true })
  postId: string | null;

  @Column({ name: 'comment_id', type: 'uuid', nullable: true })
  commentId: string | null;

  /** Citizen who reported (plain uuid, no FK). */
  @Column({ name: 'reporter_identity_id', type: 'uuid', nullable: true })
  reporterIdentityId: string | null;

  /** Internal moderator WorkHistory uuid — NO FK (§17.3). Null for system actions. */
  @Column({ name: 'actor_work_history_id', type: 'uuid', nullable: true })
  actorWorkHistoryId: string | null;

  /** Role at action time (denormalized — survives role changes). */
  @Column({ name: 'actor_role', type: 'varchar', length: 64, nullable: true })
  actorRole: string | null;

  /** `report|hide|remove|restore|block_author`. CHECK in migration. */
  @Column({ name: 'action', type: 'varchar', length: 24 })
  action: string;

  @Column({ name: 'reason', type: 'text', nullable: true })
  reason: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
