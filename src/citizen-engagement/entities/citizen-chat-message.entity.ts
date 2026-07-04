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

import { CitizenChatConversation } from './citizen-chat-conversation.entity';
import { CitizenIdentity } from './citizen-identity.entity';

/**
 * citizen_chat_message — one message in a 1:1 conversation (Community Chat
 * Phase 1). The `body` is stored ENCRYPTED AT REST (AES via
 * `src/util/encryption.util` `encryption()` → `iv:hex`), decrypted only when
 * served to a participant. Messages are immutable (no edit in v1); the author
 * may soft-delete their own message.
 *
 * §17.3 isolation: FKs only into `citizen_chat_conversation` +
 * `citizen_identities` (citizen_* → citizen_*). Zero FK into project / users /
 * work_history / tracking_status.
 */
@Entity('citizen_chat_message')
// Thread pagination — newest-first within a conversation.
@Index('ix_citizen_chat_message_convo_created', ['conversationId', 'createdAt'])
export class CitizenChatMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId: string;

  @ManyToOne(() => CitizenChatConversation)
  @JoinColumn({ name: 'conversation_id' })
  conversation: CitizenChatConversation;

  @Column({ name: 'author_identity_id', type: 'uuid' })
  authorIdentityId: string;

  @ManyToOne(() => CitizenIdentity)
  @JoinColumn({ name: 'author_identity_id' })
  author: CitizenIdentity;

  /**
   * Ciphertext (`iv:hex`) of the message text — NEVER stored in plaintext.
   * Empty string for an image-only message.
   */
  @Column({ name: 'body', type: 'text' })
  body: string;

  /**
   * Storage key of an attached image (EXIF-stripped, served participant-scoped),
   * or null for a text message. The image bytes are access-controlled on serve
   * (not encrypted at rest — same posture as citizen post/story media).
   */
  @Column({ name: 'image_path', type: 'varchar', length: 512, nullable: true })
  imagePath: string | null;

  @Column({ name: 'image_content_type', type: 'varchar', length: 64, nullable: true })
  imageContentType: string | null;

  /**
   * Moderation state, reusing the citizen post/comment vocabulary:
   * `live | flagged_pending_review | hidden_by_report | removed_by_staff`.
   * Only `live` messages are served to the counterpart.
   */
  @Column({ name: 'moderation_state', type: 'varchar', length: 24, default: 'live' })
  moderationState: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
