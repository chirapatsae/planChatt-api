import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OnEvent } from '@nestjs/event-emitter';

import {
  CITIZEN_CHAT_MESSAGE_EVENT,
  CITIZEN_CHAT_READ_EVENT,
  type CitizenChatMessageEvent,
  type CitizenChatReadEvent,
} from './citizen-chat.events';

/**
 * CitizenChatGateway — Community Chat Phase 2 realtime transport.
 *
 * A DEDICATED namespace `/api/v1/citizen-chat`, NOT an extension of the staff
 * W106 presence gateway (which verifies with `JWT_SECRET` and rejects citizen
 * tokens). This gateway authenticates the `aud:'citizen'` token signed by
 * `CITIZEN_JWT_SECRET`, binds the socket to `citizen-<identityId>`, and:
 *   - relays newly-saved messages / read-receipts (via the in-process
 *     `@OnEvent` bridge emitted by CitizenChatService) to the recipient room;
 *   - relays a transient typing indicator between participants.
 *
 * §17.2 advisory — the socket is an ACCELERANT only; the REST send/read path is
 * authoritative and a dropped socket event is reconciled by the poll fallback.
 * §17.3 — the gateway writes NO tracking_status / audit; it only relays
 * already-authorized DTOs (alias-only) over rooms. Multi-instance fan-out (the
 * Socket.IO Redis adapter) is a documented later-wave follow-up.
 */
const CHAT_SOCKET_DEFAULT_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5176',
  'https://pb.koratpao.go.th',
  'http://pb.thaiakitech.co.th',
  'http://pb.thaiakitech.co.th:8080',
  'https://pb.thaiakitech.co.th',
  'https://pb.thaiakitech.co.th:8080',
];
const CHAT_SOCKET_ENV_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);
const CHAT_SOCKET_ORIGINS = Array.from(
  new Set([...CHAT_SOCKET_DEFAULT_ORIGINS, ...CHAT_SOCKET_ENV_ORIGINS]),
);

@WebSocketGateway({
  cors: { origin: CHAT_SOCKET_ORIGINS, credentials: true },
  namespace: '/api/v1/citizen-chat',
})
export class CitizenChatGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(CitizenChatGateway.name);
  /** socket.id → citizen identityId (JWT-derived, never client-supplied). */
  private readonly connected = new Map<string, string>();

  constructor(private readonly jwt: JwtService) {}

  handleConnection(client: Socket) {
    const raw =
      (client.handshake.auth as { token?: unknown } | undefined)?.token ||
      this.bearer(client.handshake.headers?.authorization);
    if (!raw || typeof raw !== 'string') {
      client.disconnect(true);
      return;
    }
    let payload: { sub?: string; aud?: string } | null = null;
    try {
      payload = this.jwt.verify(raw, {
        secret:
          process.env.CITIZEN_JWT_SECRET ||
          process.env.JWT_SECRET ||
          'defaultSecret',
        audience: 'citizen',
      });
    } catch {
      client.disconnect(true);
      return;
    }
    if (payload?.aud !== 'citizen' || !payload?.sub) {
      client.disconnect(true);
      return;
    }
    const identityId = payload.sub;
    (client.data as { identityId?: string }).identityId = identityId;
    this.connected.set(client.id, identityId);
    client.join(`citizen-${identityId}`);
  }

  handleDisconnect(client: Socket) {
    this.connected.delete(client.id);
  }

  /**
   * Transient typing indicator. The SENDER identity is JWT-bound; `toId` (the
   * other participant, known to the FE from the ConversationDto) is client-
   * supplied but only routes a decorative "typing" ping — it writes nothing and
   * exposes nothing (§17.2 advisory).
   */
  @SubscribeMessage('chat:typing')
  handleTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId?: string; toId?: string },
  ) {
    const fromId = (client.data as { identityId?: string })?.identityId;
    if (!fromId || !data?.conversationId || !data?.toId) return;
    this.server
      .to(`citizen-${data.toId}`)
      .emit('chat:typing', { conversationId: data.conversationId, fromId });
  }

  @OnEvent(CITIZEN_CHAT_MESSAGE_EVENT)
  onChatMessage(event: CitizenChatMessageEvent) {
    if (!event?.recipientId) return;
    this.server.to(`citizen-${event.recipientId}`).emit('chat:message', event.message);
  }

  @OnEvent(CITIZEN_CHAT_READ_EVENT)
  onChatRead(event: CitizenChatReadEvent) {
    if (!event?.recipientId) return;
    this.server.to(`citizen-${event.recipientId}`).emit('chat:read', {
      conversationId: event.conversationId,
      readerId: event.readerId,
    });
  }

  private bearer(h: unknown): string | null {
    if (!h || typeof h !== 'string') return null;
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m ? m[1] : null;
  }
}
