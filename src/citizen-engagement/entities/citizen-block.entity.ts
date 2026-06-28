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

/**
 * citizen_block — a citizen MUTES or BLOCKS another citizen (W-T1, §17.2).
 *
 *   - `mute`  → the muter never sees the muted author's posts/comments, but the
 *               muted author can STILL interact (comment/react/follow/repost).
 *   - `block` → mutual invisibility (neither sees the other's posts/comments)
 *               AND the blocked author CANNOT interact with the blocker (and
 *               vice-versa). Setting `block` ALSO soft-deletes the follow edges
 *               in BOTH directions.
 *
 * PRIVACY (W-T1): block/mute is PRIVATE — the target is NEVER notified and the
 * pair is owner-scoped (only the blocker can list / unset its own blocks). The
 * partial-unique `(blocker_identity_id, blocked_identity_id) WHERE deleted_at IS
 * NULL` keeps at most one live edge per directed pair; switching kind UPDATEs
 * the same live row.
 *
 * §17.3 isolation: the ONLY foreign key is `blocker_identity_id →
 * citizen_identities` (citizen_* → citizen_*, declared via @ManyToOne).
 * `blocked_identity_id` is a PLAIN uuid (NOT a new foreign key — kept a plain
 * column like citizen_follow.target_key to preserve the §17.3 table-level
 * zero-FK invariant). Zero foreign key into project / users / work_history /
 * tracking_status.
 */
@Entity('citizen_block')
@Index('ix_citizen_block_blocker', ['blockerIdentityId'])
export class CitizenBlock {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'blocker_identity_id', type: 'uuid' })
  blockerIdentityId: string;

  @ManyToOne(() => CitizenIdentity)
  @JoinColumn({ name: 'blocker_identity_id' })
  blocker: CitizenIdentity;

  /** The blocked/muted citizen's identity_id as a PLAIN uuid (NOT a FK). */
  @Column({ name: 'blocked_identity_id', type: 'uuid' })
  blockedIdentityId: string;

  /** `mute` | `block`. CHECK enforced in migration. */
  @Column({ name: 'kind', type: 'varchar', length: 8 })
  kind: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
