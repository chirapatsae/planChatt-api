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
 * citizen_follow — a citizen follows an AREA (amphoe), a TOPIC (category), or
 * (W-GATE-1, §10 APPROVED 2026-06-25) another PERSON.
 *
 * W-GATE-1 (supersedes the pre-§10 D11 forbid): `target_kind` is now `amphoe` |
 * `category` | `person`. A live follow is a row with `deleted_at IS NULL`;
 * toggle = soft-delete / re-insert. The partial-unique
 * `(follower_identity_id, target_kind, target_key) WHERE deleted_at IS NULL`
 * keeps at most one live follow per target (migration).
 *
 * §17.3 isolation: the ONLY FK is `follower_identity_id → citizen_identities`
 * (citizen_* → citizen_*). `target_key` is a PLAIN string — amphoe uuid OR
 * category name OR (for `person`) the followed citizen's `identity_id` as a
 * PLAIN uuid (NOT a new FK — kept a plain string like amphoe/category to
 * preserve the §17.3 table-level zero-FK invariant). Zero FK into
 * project / users / work_history / tracking_status.
 *
 * PRIVACY (D16): this table can answer "does X follow Y?" and "how many follow
 * Y?" (a COUNT) but the follower/following ROSTER (who-follows-whom) is PRIVATE.
 * Only the caller's OWN following list and public COUNTS are ever exposed.
 */
@Entity('citizen_follow')
@Index('ix_citizen_follow_follower', ['followerIdentityId'])
export class CitizenFollow {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'follower_identity_id', type: 'uuid' })
  followerIdentityId: string;

  @ManyToOne(() => CitizenIdentity)
  @JoinColumn({ name: 'follower_identity_id' })
  follower: CitizenIdentity;

  /** `amphoe` | `category` | `person` (W-GATE-1). CHECK enforced in migration. */
  @Column({ name: 'target_kind', type: 'varchar', length: 16 })
  targetKind: string;

  /**
   * amphoe uuid (when `amphoe`) OR category string (when `category`) OR the
   * followed citizen's identity_id as a PLAIN uuid (when `person`, W-GATE-1).
   * A uuid is 36 chars — within the varchar(64) bound.
   */
  @Column({ name: 'target_key', type: 'varchar', length: 64 })
  targetKey: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
