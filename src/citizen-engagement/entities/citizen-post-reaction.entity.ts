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
 * citizen_post_reaction — one reaction per citizen per post (W-S1 multi-set).
 *
 * Replaces the prototype's anonymous deviceId heart (plan D7): reactions are
 * ThaID-gated. The "one reaction per citizen" rule is a PARTIAL-UNIQUE index
 * `(post_id, identity_id) WHERE deleted_at IS NULL` (migration) — `reaction_type`
 * is WHICH of the 4 (W-S1). Add = insert; switch = UPDATE the type; remove =
 * soft-delete. `heart_count` stays the TOTAL live-reaction engagement signal.
 *
 * §17.3 isolation: FKs are ONLY `post_id → citizen_post` and
 * `identity_id → citizen_identities` (citizen_* → citizen_*). `reaction_type`
 * is a plain scalar — no new FK, no new table.
 */
@Entity('citizen_post_reaction')
@Index('ix_citizen_reaction_post', ['postId'])
export class CitizenPostReaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'post_id', type: 'uuid' })
  postId: string;

  @ManyToOne(() => CitizenPost)
  @JoinColumn({ name: 'post_id' })
  post: CitizenPost;

  @Column({ name: 'identity_id', type: 'uuid' })
  identityId: string;

  @ManyToOne(() => CitizenIdentity)
  @JoinColumn({ name: 'identity_id' })
  identity: CitizenIdentity;

  /**
   * Legacy "kind of reaction row" discriminator from M0 (always `heart`). Kept
   * for back-compat with the original partial-unique; the W-S1 reaction set
   * lives on `reactionType` below. CHECK in the M0 migration keeps it additive.
   */
  @Column({ name: 'reaction', type: 'varchar', length: 16, default: 'heart' })
  reaction: string;

  /**
   * W-S1 reaction set — one of the 4 FROZEN keys (`like` | `love` | `support` |
   * `insightful`). Defaults to `like`; the migration backfills existing heart
   * rows to `like` and adds a CHECK on the 4 values.
   */
  @Column({
    name: 'reaction_type',
    type: 'varchar',
    length: 16,
    default: 'like',
  })
  reactionType: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
