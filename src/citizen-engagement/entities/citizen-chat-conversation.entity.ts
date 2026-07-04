import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { CitizenIdentity } from './citizen-identity.entity';

/**
 * citizen_chat_conversation — a 1:1 direct-message thread between exactly two
 * citizens (Community Chat Phase 1). Alice→Bob and Bob→Alice resolve to the
 * SAME row via the canonical `pair_key` (the two identity uuids sorted +
 * `:`-joined) with a partial-unique on the LIVE row.
 *
 * §17.3 isolation: the ONLY FK is `initiator_identity_id → citizen_identities`
 * (citizen_* → citizen_*). `participant_identity_id` is a PLAIN uuid (NOT a
 * new FK — mirrors `citizen_follow.target_key` / `citizen_block.blocked_identity_id`
 * to keep the table-level zero-extra-FK invariant). Zero FK into project /
 * users / work_history / tracking_status.
 *
 * PRIVACY: the participant roster is never public — only the two members ever
 * read the conversation (owner-scoped `WHERE initiator = me OR participant = me`).
 */
@Entity('citizen_chat_conversation')
@Index('ix_citizen_chat_convo_initiator', ['initiatorIdentityId'])
@Index('ix_citizen_chat_convo_participant', ['participantIdentityId'])
@Index('ix_citizen_chat_convo_last_message_at', ['lastMessageAt'])
// One LIVE conversation per unordered citizen pair (direction-independent).
@Index('ux_citizen_chat_convo_pair', ['pairKey'], {
  unique: true,
  where: '"deleted_at" IS NULL',
})
export class CitizenChatConversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'initiator_identity_id', type: 'uuid' })
  initiatorIdentityId: string;

  @ManyToOne(() => CitizenIdentity)
  @JoinColumn({ name: 'initiator_identity_id' })
  initiator: CitizenIdentity;

  /** The other member's identity_id — a PLAIN uuid, NO FK (§17.3). */
  @Column({ name: 'participant_identity_id', type: 'uuid' })
  participantIdentityId: string;

  /**
   * Canonical pair key = the two identity uuids sorted lexicographically and
   * joined with ':' (73 chars). Drives the direction-independent partial-unique
   * so a reversed first-DM never spawns a duplicate thread.
   */
  @Column({ name: 'pair_key', type: 'varchar', length: 73 })
  pairKey: string;

  /**
   * Sort key for the conversation list — bumped on every message. A bare
   * timestamp (no content), so it is safe to store in the clear; the list
   * PREVIEW is derived by decrypting the latest message at read time, so no
   * plaintext message content is ever persisted (full encryption at rest).
   */
  @Column({ name: 'last_message_at', type: 'timestamptz', nullable: true })
  lastMessageAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
