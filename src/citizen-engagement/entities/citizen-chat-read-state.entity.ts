import {
  Column,
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
 * citizen_chat_read_state — the "last read" watermark for ONE participant in
 * ONE conversation (Community Chat Phase 1). Unread count for a reader =
 * live `citizen_chat_message` rows in the conversation with
 * `created_at > last_read_at` authored by the OTHER participant.
 *
 * §17.3 isolation: FKs only into `citizen_chat_conversation` +
 * `citizen_identities` (citizen_* → citizen_*).
 */
@Entity('citizen_chat_read_state')
@Index('ux_citizen_chat_read_state_convo_reader', ['conversationId', 'readerIdentityId'], {
  unique: true,
})
export class CitizenChatReadState {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId: string;

  @ManyToOne(() => CitizenChatConversation)
  @JoinColumn({ name: 'conversation_id' })
  conversation: CitizenChatConversation;

  @Column({ name: 'reader_identity_id', type: 'uuid' })
  readerIdentityId: string;

  @ManyToOne(() => CitizenIdentity)
  @JoinColumn({ name: 'reader_identity_id' })
  reader: CitizenIdentity;

  /** The moment the reader last opened/marked the conversation read. */
  @Column({ name: 'last_read_at', type: 'timestamptz', nullable: true })
  lastReadAt: Date | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
