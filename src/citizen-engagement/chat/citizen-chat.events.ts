import type { MessageDto } from '../dto/citizen-chat.dto';

/**
 * In-process event contract between CitizenChatService (emitter) and
 * CitizenChatGateway (relay). Decouples the two so the service never depends on
 * the WS layer (no circular DI) — mirrors the W106 presence `@OnEvent` bridge.
 *
 * §17.2 advisory / §17.3 — these events carry a recipient routing id + the
 * already-authorized MessageDto (alias-only, no PII). Realtime is best-effort;
 * a dropped event is reconciled by the REST poll fallback.
 */
export const CITIZEN_CHAT_MESSAGE_EVENT = 'citizen-chat.message';
export const CITIZEN_CHAT_READ_EVENT = 'citizen-chat.read';

export interface CitizenChatMessageEvent {
  /** The OTHER participant (never the author) — the socket room to emit to. */
  recipientId: string;
  message: MessageDto;
}

export interface CitizenChatReadEvent {
  /** The message author whose sent messages were just read. */
  recipientId: string;
  conversationId: string;
  readerId: string;
}
