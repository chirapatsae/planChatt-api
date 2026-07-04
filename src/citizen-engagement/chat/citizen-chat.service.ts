import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';

import {
  CITIZEN_CHAT_MESSAGE_EVENT,
  CITIZEN_CHAT_READ_EVENT,
} from './citizen-chat.events';

import {
  ChatParticipantDto,
  ConversationDto,
  ConversationListDto,
  MessageDto,
  MessageListDto,
  UnreadCountDto,
} from '../dto/citizen-chat.dto';
import { CitizenAuditLog } from '../entities/citizen-audit-log.entity';
import { CitizenChatConversation } from '../entities/citizen-chat-conversation.entity';
import { CitizenChatMessage } from '../entities/citizen-chat-message.entity';
import { CitizenChatReadState } from '../entities/citizen-chat-read-state.entity';
import { CitizenIdentity } from '../entities/citizen-identity.entity';
import { CitizenBlockService } from '../block/citizen-block.service';
import { CitizenStorageService } from '../media/citizen-storage.service';
import {
  readImageDimensions,
  stripImageMetadata,
} from '../media/image-metadata.util';
import {
  decryption,
  encryption,
  isLikelyCiphertext,
} from '../../util/encryption.util';

const PREVIEW_MAX = 140;

// Image-attach limits (mirror CitizenMediaService).
const ACCEPTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_MAX_DIM = 10000;
const IMAGE_MAX_PIXELS = 40_000_000;
const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

/** Minimal shape of an uploaded file (memoryStorage → `buffer` populated). */
export interface ChatImageUploadFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

/**
 * CitizenChatService — 1:1 direct messages (Community Chat Phase 1, §17.2
 * advisory). Message bodies are ENCRYPTED AT REST (AES via
 * `src/util/encryption.util`). A live `block` edge either way (via
 * `CitizenBlockService.isBlockedEitherWay`) refuses start/send. Audit goes
 * EXCLUSIVELY to `citizen_audit_logs` (NEVER `tracking_status`).
 *
 * §17.3 isolation: touches ONLY `citizen_chat_*` + `citizen_identities` +
 * `citizen_block` (via the block service) + `citizen_audit_logs`. Reads are
 * strictly participant-scoped — a conversation is visible only to its two
 * members (no roster, no IDOR).
 */
@Injectable()
export class CitizenChatService {
  constructor(
    @InjectRepository(CitizenChatConversation)
    private readonly convoRepo: Repository<CitizenChatConversation>,
    @InjectRepository(CitizenChatMessage)
    private readonly messageRepo: Repository<CitizenChatMessage>,
    @InjectRepository(CitizenChatReadState)
    private readonly readStateRepo: Repository<CitizenChatReadState>,
    @InjectRepository(CitizenIdentity)
    private readonly identityRepo: Repository<CitizenIdentity>,
    private readonly blockService: CitizenBlockService,
    private readonly storage: CitizenStorageService,
    private readonly dataSource: DataSource,
    // Realtime bridge (Phase 2) — decoupled from the WS gateway via events.
    private readonly events: EventEmitter2,
  ) {}

  /** Push a just-saved message to the OTHER participant's socket (Phase 2). */
  private emitRealtimeMessage(otherId: string, message: MessageDto): void {
    try {
      this.events.emit(CITIZEN_CHAT_MESSAGE_EVENT, {
        recipientId: otherId,
        // The recipient is never the author → force `mine:false` for their view.
        message: { ...message, mine: false },
      });
    } catch {
      // Realtime is advisory — never break the write (§17.2).
    }
  }

  // ---------------------------------------------------------------------------
  // Conversations
  // ---------------------------------------------------------------------------

  /**
   * Open (or re-open) the caller's 1:1 conversation with `participantId`.
   * Symmetric: the pair resolves to ONE row regardless of who started it.
   */
  async startConversation(
    callerId: string,
    participantId: string,
  ): Promise<ConversationDto> {
    if (participantId === callerId) {
      throw new BadRequestException('CITIZEN_CHAT_SELF');
    }
    const target = await this.identityRepo.findOne({
      where: { id: participantId, status: 'active', deletedAt: IsNull() },
    });
    if (!target) {
      throw new NotFoundException('CITIZEN_IDENTITY_NOT_FOUND');
    }
    if (await this.blockService.isBlockedEitherWay(callerId, participantId)) {
      throw new ForbiddenException('CITIZEN_BLOCKED');
    }

    const pairKey = this.pairKeyFor(callerId, participantId);

    const convo = await this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(CitizenChatConversation);
      const existing = await repo.findOne({
        where: { pairKey, deletedAt: IsNull() },
      });
      if (existing) {
        return existing;
      }
      // Race-safe insert: a concurrent first-DM from the other side hits the
      // partial-unique `(pair_key) WHERE deleted_at IS NULL` without aborting.
      await repo
        .createQueryBuilder()
        .insert()
        .values({
          initiatorIdentityId: callerId,
          participantIdentityId: participantId,
          pairKey,
        })
        .orIgnore()
        .execute();
      const row = await repo.findOne({ where: { pairKey, deletedAt: IsNull() } });
      if (!row) {
        // Should never happen (we just inserted or found a live row).
        throw new NotFoundException('CITIZEN_CHAT_CONVERSATION_NOT_FOUND');
      }
      await this.writeAudit(em, callerId, 'chat.conversation.start', row.id, {
        participantId,
      });
      return row;
    });

    const alias = (await this.resolveAliases([participantId])).get(participantId) ?? '';
    const preview = await this.previewForConversation(convo.id, callerId);
    const unread = await this.unreadForConversation(convo.id, callerId);
    return {
      id: convo.id,
      participant: { id: participantId, displayAlias: alias },
      lastMessageAt: convo.lastMessageAt ? convo.lastMessageAt.toISOString() : null,
      lastMessagePreview: preview,
      unreadCount: unread,
    };
  }

  /** One conversation's meta (participant + preview + unread). Participant-scoped. */
  async getConversation(
    callerId: string,
    conversationId: string,
  ): Promise<ConversationDto> {
    const convo = await this.loadParticipantConversation(conversationId, callerId);
    const otherId = this.otherId(convo, callerId);
    const alias = (await this.resolveAliases([otherId])).get(otherId) ?? '';
    return {
      id: convo.id,
      participant: { id: otherId, displayAlias: alias },
      lastMessageAt: convo.lastMessageAt ? convo.lastMessageAt.toISOString() : null,
      lastMessagePreview: await this.previewForConversation(convo.id, callerId),
      unreadCount: await this.unreadForConversation(convo.id, callerId),
    };
  }

  /** The caller's conversations, newest-activity-first. Owner-scoped. */
  async listConversations(callerId: string): Promise<ConversationListDto> {
    const rows = await this.convoRepo
      .createQueryBuilder('c')
      .where('c.deletedAt IS NULL')
      .andWhere(
        '(c.initiatorIdentityId = :me OR c.participantIdentityId = :me)',
        { me: callerId },
      )
      .orderBy('c.lastMessageAt', 'DESC', 'NULLS LAST')
      .addOrderBy('c.createdAt', 'DESC')
      .getMany();

    const otherIds = rows.map((c) => this.otherId(c, callerId));
    const aliasBy = await this.resolveAliases(otherIds);

    const items = await Promise.all(
      rows.map(async (c): Promise<ConversationDto> => {
        const otherId = this.otherId(c, callerId);
        return {
          id: c.id,
          participant: { id: otherId, displayAlias: aliasBy.get(otherId) ?? '' },
          lastMessageAt: c.lastMessageAt ? c.lastMessageAt.toISOString() : null,
          lastMessagePreview: await this.previewForConversation(c.id, callerId),
          unreadCount: await this.unreadForConversation(c.id, callerId),
        };
      }),
    );
    return { items };
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  /** A conversation's messages, newest-first, keyset-paginated. */
  async listMessages(
    callerId: string,
    conversationId: string,
    limit = 30,
    beforeCreatedAt?: string,
    beforeId?: string,
  ): Promise<MessageListDto> {
    const convo = await this.loadParticipantConversation(conversationId, callerId);
    const take = Math.min(Math.max(limit, 1), 100);

    const qb = this.messageRepo
      .createQueryBuilder('m')
      .where('m.conversationId = :cid', { cid: convo.id })
      .andWhere('m.deletedAt IS NULL')
      .andWhere("m.moderationState = 'live'");

    if (beforeCreatedAt && beforeId) {
      qb.andWhere(
        '(m.createdAt < :bca OR (m.createdAt = :bca AND m.id < :bid))',
        { bca: beforeCreatedAt, bid: beforeId },
      );
    }
    qb.orderBy('m.createdAt', 'DESC').addOrderBy('m.id', 'DESC').take(take);

    const rows = await qb.getMany();

    const authorIds = rows.map((m) => m.authorIdentityId);
    const aliasBy = await this.resolveAliases(authorIds);

    const items = await Promise.all(
      rows.map((m) => this.toMessageDto(m, callerId, aliasBy)),
    );

    const nextCursor =
      rows.length === take
        ? {
            createdAt: rows[rows.length - 1].createdAt.toISOString(),
            id: rows[rows.length - 1].id,
          }
        : null;

    return { items, nextCursor };
  }

  /** Send a text message. Encrypts at rest; refuses on a live block edge. */
  async sendMessage(
    callerId: string,
    conversationId: string,
    body: string,
  ): Promise<MessageDto> {
    const trimmed = body.trim();
    if (!trimmed) {
      throw new BadRequestException('CITIZEN_CHAT_EMPTY');
    }
    const convo = await this.loadParticipantConversation(conversationId, callerId);
    const otherId = this.otherId(convo, callerId);
    if (await this.blockService.isBlockedEitherWay(callerId, otherId)) {
      throw new ForbiddenException('CITIZEN_BLOCKED');
    }

    const ciphertext = await encryption(trimmed);

    const saved = await this.dataSource.transaction(async (em) => {
      const msgRepo = em.getRepository(CitizenChatMessage);
      const row = msgRepo.create({
        conversationId: convo.id,
        authorIdentityId: callerId,
        body: ciphertext,
        moderationState: 'live',
      });
      const persisted = await msgRepo.save(row);
      await em
        .getRepository(CitizenChatConversation)
        .update(convo.id, { lastMessageAt: persisted.createdAt ?? new Date() });
      await this.writeAudit(em, callerId, 'chat.message.send', persisted.id, {
        conversationId: convo.id,
      });
      return persisted;
    });

    const alias = (await this.resolveAliases([callerId])).get(callerId) ?? '';
    const dto: MessageDto = {
      id: saved.id,
      conversationId: convo.id,
      author: { id: callerId, displayAlias: alias },
      body: trimmed,
      imageUrl: null,
      mine: true,
      createdAt: (saved.createdAt ?? new Date()).toISOString(),
    };
    this.emitRealtimeMessage(otherId, dto);
    return dto;
  }

  /** Send an image message (EXIF-stripped, optional caption). */
  async sendImageMessage(
    callerId: string,
    conversationId: string,
    file: ChatImageUploadFile,
    caption?: string,
  ): Promise<MessageDto> {
    const convo = await this.loadParticipantConversation(conversationId, callerId);
    const otherId = this.otherId(convo, callerId);
    if (await this.blockService.isBlockedEitherWay(callerId, otherId)) {
      throw new ForbiddenException('CITIZEN_BLOCKED');
    }
    if (
      !file ||
      !ACCEPTED_IMAGE_TYPES.has(file.mimetype) ||
      file.size > IMAGE_MAX_BYTES
    ) {
      throw new BadRequestException('CITIZEN_CHAT_IMAGE_INVALID');
    }
    let dims: { width: number; height: number };
    try {
      dims = readImageDimensions(file.buffer, file.mimetype);
    } catch {
      throw new BadRequestException('CITIZEN_CHAT_IMAGE_INVALID');
    }
    if (
      dims.width > IMAGE_MAX_DIM ||
      dims.height > IMAGE_MAX_DIM ||
      dims.width * dims.height > IMAGE_MAX_PIXELS
    ) {
      throw new BadRequestException('CITIZEN_CHAT_IMAGE_DIMENSIONS');
    }
    let clean: Buffer;
    try {
      clean = stripImageMetadata(file.buffer, file.mimetype);
    } catch {
      throw new BadRequestException('CITIZEN_CHAT_IMAGE_INVALID');
    }

    const key = this.storage.keyFor(EXT_BY_TYPE[file.mimetype]);
    await this.storage.save(key, clean);

    const trimmedCaption = caption?.trim() ?? '';
    const bodyCipher = trimmedCaption ? await encryption(trimmedCaption) : '';

    const saved = await this.dataSource.transaction(async (em) => {
      const msgRepo = em.getRepository(CitizenChatMessage);
      const row = msgRepo.create({
        conversationId: convo.id,
        authorIdentityId: callerId,
        body: bodyCipher,
        imagePath: key,
        imageContentType: file.mimetype,
        moderationState: 'live',
      });
      const persisted = await msgRepo.save(row);
      await em
        .getRepository(CitizenChatConversation)
        .update(convo.id, { lastMessageAt: persisted.createdAt ?? new Date() });
      await this.writeAudit(em, callerId, 'chat.message.image', persisted.id, {
        conversationId: convo.id,
      });
      return persisted;
    });

    const alias = (await this.resolveAliases([callerId])).get(callerId) ?? '';
    const dto: MessageDto = {
      id: saved.id,
      conversationId: convo.id,
      author: { id: callerId, displayAlias: alias },
      body: trimmedCaption,
      imageUrl: `/citizen-engagement/chat/media/${saved.id}`,
      mine: true,
      createdAt: (saved.createdAt ?? new Date()).toISOString(),
    };
    this.emitRealtimeMessage(otherId, dto);
    return dto;
  }

  /** Read an image message's bytes — participant-scoped (no IDOR). */
  async getMessageImage(
    callerId: string,
    messageId: string,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const msg = await this.messageRepo.findOne({
      where: { id: messageId, deletedAt: IsNull() },
    });
    if (!msg || !msg.imagePath) {
      throw new NotFoundException('CITIZEN_CHAT_IMAGE_NOT_FOUND');
    }
    // Assert the caller is a participant of the message's conversation.
    await this.loadParticipantConversation(msg.conversationId, callerId);
    try {
      const buffer = await this.storage.read(msg.imagePath);
      return { buffer, contentType: msg.imageContentType ?? 'image/jpeg' };
    } catch {
      throw new NotFoundException('CITIZEN_CHAT_IMAGE_NOT_FOUND');
    }
  }

  /** Soft-delete the caller's OWN message (v1: no edit, delete-own only). */
  async deleteMessage(
    callerId: string,
    messageId: string,
  ): Promise<{ ok: true }> {
    return this.dataSource.transaction(async (em) => {
      const msgRepo = em.getRepository(CitizenChatMessage);
      const msg = await msgRepo.findOne({
        where: { id: messageId, deletedAt: IsNull() },
      });
      if (!msg) {
        throw new NotFoundException('CITIZEN_CHAT_MESSAGE_NOT_FOUND');
      }
      if (msg.authorIdentityId !== callerId) {
        throw new ForbiddenException('CITIZEN_CHAT_NOT_AUTHOR');
      }
      await msgRepo.softDelete(msg.id);
      await this.writeAudit(em, callerId, 'chat.message.delete', msg.id, {
        conversationId: msg.conversationId,
      });
      return { ok: true as const };
    });
  }

  // ---------------------------------------------------------------------------
  // Read state / unread
  // ---------------------------------------------------------------------------

  /** Mark a conversation read (upsert the caller's watermark to now). */
  async markRead(
    callerId: string,
    conversationId: string,
  ): Promise<{ ok: true }> {
    const convo = await this.loadParticipantConversation(conversationId, callerId);
    const now = new Date();
    await this.readStateRepo
      .createQueryBuilder()
      .insert()
      .values({
        conversationId: convo.id,
        readerIdentityId: callerId,
        lastReadAt: now,
      })
      .orUpdate(['last_read_at'], ['conversation_id', 'reader_identity_id'])
      .execute();
    // Realtime read-receipt → the OTHER participant (the message author) so
    // their "อ่านแล้ว" marker updates live (Phase 2, best-effort).
    try {
      this.events.emit(CITIZEN_CHAT_READ_EVENT, {
        recipientId: this.otherId(convo, callerId),
        conversationId: convo.id,
        readerId: callerId,
      });
    } catch {
      // advisory — never break the write.
    }
    return { ok: true as const };
  }

  /** Total unread messages across all the caller's conversations. */
  async getUnreadCount(callerId: string): Promise<UnreadCountDto> {
    const count = await this.messageRepo
      .createQueryBuilder('m')
      .innerJoin(
        CitizenChatConversation,
        'c',
        'c.id = m.conversation_id AND c.deleted_at IS NULL',
      )
      .leftJoin(
        CitizenChatReadState,
        'r',
        'r.conversation_id = c.id AND r.reader_identity_id = :me',
        { me: callerId },
      )
      .where('(c.initiator_identity_id = :me OR c.participant_identity_id = :me)', {
        me: callerId,
      })
      .andWhere('m.author_identity_id != :me', { me: callerId })
      .andWhere('m.deleted_at IS NULL')
      .andWhere("m.moderation_state = 'live'")
      .andWhere('(r.last_read_at IS NULL OR m.created_at > r.last_read_at)')
      .getCount();
    return { count };
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  /** Canonical, direction-independent key for a citizen pair. */
  private pairKeyFor(a: string, b: string): string {
    return [a, b].sort().join(':');
  }

  private otherId(c: CitizenChatConversation, callerId: string): string {
    return c.initiatorIdentityId === callerId
      ? c.participantIdentityId
      : c.initiatorIdentityId;
  }

  /** Load a LIVE conversation and assert the caller is one of its two members. */
  private async loadParticipantConversation(
    conversationId: string,
    callerId: string,
  ): Promise<CitizenChatConversation> {
    const convo = await this.convoRepo.findOne({
      where: { id: conversationId, deletedAt: IsNull() },
    });
    if (!convo) {
      throw new NotFoundException('CITIZEN_CHAT_CONVERSATION_NOT_FOUND');
    }
    if (
      convo.initiatorIdentityId !== callerId &&
      convo.participantIdentityId !== callerId
    ) {
      throw new ForbiddenException('CITIZEN_CHAT_NOT_PARTICIPANT');
    }
    return convo;
  }

  /** Decrypt a body ciphertext; tolerate a legacy/plain value defensively. */
  private async decryptBody(stored: string): Promise<string> {
    if (!isLikelyCiphertext(stored)) {
      return stored;
    }
    try {
      return await decryption(stored);
    } catch {
      return '';
    }
  }

  private async toMessageDto(
    m: CitizenChatMessage,
    callerId: string,
    aliasBy: Map<string, string>,
  ): Promise<MessageDto> {
    return {
      id: m.id,
      conversationId: m.conversationId,
      author: {
        id: m.authorIdentityId,
        displayAlias: aliasBy.get(m.authorIdentityId) ?? '',
      },
      body: m.body ? await this.decryptBody(m.body) : '',
      imageUrl: m.imagePath
        ? `/citizen-engagement/chat/media/${m.id}`
        : null,
      mine: m.authorIdentityId === callerId,
      createdAt: (m.createdAt ?? new Date()).toISOString(),
    };
  }

  /** Decrypted, truncated preview of a conversation's latest live message. */
  private async previewForConversation(
    conversationId: string,
    _callerId: string,
  ): Promise<string | null> {
    const latest = await this.messageRepo.findOne({
      where: {
        conversationId,
        deletedAt: IsNull(),
        moderationState: 'live',
      },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    if (!latest) {
      return null;
    }
    const text = latest.body ? await this.decryptBody(latest.body) : '';
    if (!text) {
      return latest.imagePath ? '📷 รูปภาพ' : '';
    }
    return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text;
  }

  private async unreadForConversation(
    conversationId: string,
    callerId: string,
  ): Promise<number> {
    const readState = await this.readStateRepo.findOne({
      where: { conversationId, readerIdentityId: callerId },
    });
    const qb = this.messageRepo
      .createQueryBuilder('m')
      .where('m.conversationId = :cid', { cid: conversationId })
      .andWhere('m.authorIdentityId != :me', { me: callerId })
      .andWhere('m.deletedAt IS NULL')
      .andWhere("m.moderationState = 'live'");
    if (readState?.lastReadAt) {
      qb.andWhere('m.createdAt > :lra', { lra: readState.lastReadAt });
    }
    return qb.getCount();
  }

  /** §17.3 / PDPA: id + public alias only — never the *_enc / *_hash columns. */
  private async resolveAliases(ids: string[]): Promise<Map<string, string>> {
    const byId = new Map<string, string>();
    const unique = [...new Set(ids)].filter(Boolean);
    if (unique.length === 0) {
      return byId;
    }
    const rows = await this.identityRepo.find({
      where: { id: In(unique) },
      select: { id: true, displayAlias: true },
    });
    for (const r of rows) {
      byId.set(r.id, r.displayAlias ?? '');
    }
    return byId;
  }

  private async writeAudit(
    em: EntityManager,
    actorId: string,
    action: string,
    targetId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const row = em.getRepository(CitizenAuditLog).create({
      actorKind: 'citizen',
      actorId,
      action,
      targetKind: 'chat',
      targetId,
      detail,
    });
    await em.getRepository(CitizenAuditLog).save(row);
  }

  // Exposed for the participant-scoped DTO shape used by other citizen services
  // (e.g. a future notification integration). Kept private surface minimal.
  buildParticipantDto(id: string, displayAlias: string): ChatParticipantDto {
    return { id, displayAlias };
  }
}
