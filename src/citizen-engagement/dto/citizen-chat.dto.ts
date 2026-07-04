import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Body cap for a single chat message. */
export const CHAT_MESSAGE_MAX_LEN = 4000;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/* ── Request DTOs ──────────────────────────────────────────────────── */

/** POST /conversations — open or re-open a 1:1 DM with another citizen. */
export class StartConversationDto {
  @IsUUID()
  participantId: string;
}

/** POST /conversations/:id/messages — send a text message. */
export class SendMessageDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(CHAT_MESSAGE_MAX_LEN)
  body: string;
}

/** GET /conversations/:id/messages — keyset pagination (newest-first). */
export class ListMessagesQueryDto {
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  beforeCreatedAt?: string;

  @IsOptional()
  @IsUUID()
  beforeId?: string;
}

/* ── Response DTOs ─────────────────────────────────────────────────── */

/** §17.3 — alias-only projection of a citizen (never PII). */
export interface ChatParticipantDto {
  id: string;
  displayAlias: string;
}

export interface ConversationDto {
  id: string;
  /** The OTHER member (never the caller). */
  participant: ChatParticipantDto;
  lastMessageAt: string | null;
  /** Decrypted preview of the latest message (truncated), or null if empty. */
  lastMessagePreview: string | null;
  unreadCount: number;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  author: ChatParticipantDto;
  /** Decrypted plaintext body (served only to a participant). Empty for an
   *  image-only message. */
  body: string;
  /** Relative API path to the attached image (participant-scoped serve), or
   *  null for a text message. */
  imageUrl: string | null;
  /** true when the caller authored this message. */
  mine: boolean;
  createdAt: string;
}

export interface ConversationListDto {
  items: ConversationDto[];
}

export interface MessageListDto {
  items: MessageDto[];
  nextCursor: { createdAt: string; id: string } | null;
}

export interface UnreadCountDto {
  count: number;
}
