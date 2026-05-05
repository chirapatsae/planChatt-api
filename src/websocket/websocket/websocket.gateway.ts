import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OnEvent } from '@nestjs/event-emitter';
import {
  PresenceChangedEvent,
  PresenceService,
} from 'src/presence/presence.service';

/**
 * Wave 106 BE-PR1 — gateway hardening.
 *
 * Changes vs pre-W106:
 *   1. JWT-based connection auth. The connection is rejected immediately
 *      if `socket.handshake.auth.token` (or the `Authorization` header)
 *      is missing or invalid. Userid is bound from the JWT payload —
 *      NEVER from a client-supplied field.
 *   2. `connectedClients` is now keyed off the verified JWT identity.
 *      `handleJoinUserRoom` keeps backward compatibility but rejects any
 *      client trying to join a different user's room than their JWT
 *      identifies (W106 acceptance: "rejects mismatched join-user-room").
 *   3. `PresenceService.markOnline / markOffline` is invoked on connect
 *      and disconnect, with source='ws'. This is the live channel; the
 *      HTTP heartbeat (`/v1/presence/heartbeat`) is the durable fallback.
 *   4. New event subscription `subscribe-presence` lets the FE register
 *      a subset of userIds it actually renders, so the gateway can do
 *      per-socket fan-out instead of broadcasting `presence:changed`
 *      to the whole namespace.
 *   5. The gateway listens on its own EventEmitter for `presence:changed`
 *      (emitted by `PresenceService` on transitions) and relays only
 *      to interested sockets.
 *
 * §4.1 / §17.2 — none of the WS hardening changes alter ownership, role
 * authority, or workflow gating. Auth is bound to identity, not to
 * workflow state.
 *
 * §17.3 — gateway does NOT write to tracking_status / notification logs /
 * any audit table. It only mutates Redis (via PresenceService) and an
 * in-process Map.
 */
@WebSocketGateway({
  cors: {
    origin: ['http://localhost:5173', 'https://pb.koratpao.go.th'],
    credentials: true,
  },
  namespace: '/api/v1/notifications',
})
export class WebsocketGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(WebsocketGateway.name);

  /**
   * connectedClients map — keyed by socket.id, value carries the JWT-derived
   * userId, the socket reference, and a roles cache populated by the
   * existing `join-role-room` event.
   *
   * `subscribedPresenceUserIds` is the new W106 field: each socket can
   * register the userIds it currently renders, and the gateway will only
   * fan out `presence:changed` events for those ids to that socket.
   */
  private connectedClients = new Map<
    string,
    {
      userId: string;
      socket: Socket;
      roles: string[];
      subscribedPresenceUserIds: Set<string>;
    }
  >();

  constructor(
    private readonly jwt: JwtService,
    private readonly presence: PresenceService,
  ) {}

  onModuleInit() {
    this.logger.log(
      'WebsocketGateway initialized with JWT auth + presence integration (W106)',
    );
  }

  // ---------------------------------------------------------------------
  // Connection lifecycle (W106 hardened)
  // ---------------------------------------------------------------------

  async handleConnection(client: Socket) {
    // Token may arrive via `auth.token` (preferred, socket.io 4.x) or via
    // a Bearer Authorization header on the upgrade request.
    const rawToken =
      (client.handshake.auth && (client.handshake.auth as any).token) ||
      this.extractBearerFromHeader(client.handshake.headers?.authorization);

    if (!rawToken || typeof rawToken !== 'string') {
      this.logger.warn(
        `[ws] reject ${client.id}: missing auth token in handshake`,
      );
      client.disconnect(true);
      return;
    }

    let payload: { sub?: string; userId?: string; role?: string } | null = null;
    try {
      payload = this.jwt.verify(rawToken, {
        secret: process.env.JWT_SECRET || 'defaultSecret',
      });
    } catch (e: any) {
      this.logger.warn(
        `[ws] reject ${client.id}: invalid jwt — ${e?.message ?? e}`,
      );
      client.disconnect(true);
      return;
    }

    const userId = payload?.sub || payload?.userId;
    if (!userId) {
      this.logger.warn(
        `[ws] reject ${client.id}: jwt missing sub/userId claim`,
      );
      client.disconnect(true);
      return;
    }

    // Bind identity to the socket. Subsequent `join-user-room` events
    // are validated against this value.
    (client.data as any).userId = userId;

    this.connectedClients.set(client.id, {
      userId,
      socket: client,
      roles: [],
      subscribedPresenceUserIds: new Set<string>(),
    });

    // Auto-join the user-scoped room so legacy notifyXxx() helpers below
    // continue to work without a separate `join-user-room` round trip.
    client.join(`user-${userId}`);

    try {
      await this.presence.markOnline(userId, 'ws');
    } catch (e: any) {
      // Never throw out of the connection handler — presence is advisory.
      this.logger.warn(`[ws] markOnline failed: ${e?.message ?? e}`);
    }

    this.logger.log(`[ws] connected ${client.id} as user=${userId}`);
  }

  async handleDisconnect(client: Socket) {
    const entry = this.connectedClients.get(client.id);
    if (entry) {
      this.connectedClients.delete(client.id);
      try {
        // Only flip presence to offline if THIS user has no other live
        // socket on this instance. PresenceService also re-checks Redis
        // (per-source key existence) so multi-tab works.
        const stillHasOtherSocket = this.userHasAnotherSocket(
          entry.userId,
          client.id,
        );
        if (!stillHasOtherSocket) {
          await this.presence.markOffline(entry.userId, 'ws');
        }
      } catch (e: any) {
        this.logger.warn(`[ws] markOffline failed: ${e?.message ?? e}`);
      }
      this.logger.log(`[ws] disconnected ${client.id} (user=${entry.userId})`);
    } else {
      this.logger.log(`[ws] disconnected ${client.id} (unauthenticated)`);
    }
  }

  private userHasAnotherSocket(userId: string, ignoreSocketId: string): boolean {
    for (const [sid, val] of this.connectedClients.entries()) {
      if (sid !== ignoreSocketId && val.userId === userId) return true;
    }
    return false;
  }

  private extractBearerFromHeader(h: unknown): string | null {
    if (!h || typeof h !== 'string') return null;
    const match = /^Bearer\s+(.+)$/i.exec(h);
    return match ? match[1] : null;
  }

  // ---------------------------------------------------------------------
  // Subscription messages
  // ---------------------------------------------------------------------

  /**
   * Backward-compat: the legacy client emits `join-user-room` with a
   * `userId` payload. Pre-W106 this was trusted as-is. We now validate
   * it against the JWT-derived identity and reject mismatches.
   */
  @SubscribeMessage('join-user-room')
  handleJoinUserRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { userId: string },
  ) {
    const entry = this.connectedClients.get(client.id);
    const verifiedUserId = entry?.userId || (client.data as any)?.userId;

    if (!verifiedUserId) {
      this.logger.warn(`[ws] join-user-room rejected: no auth for ${client.id}`);
      client.emit('error', { message: 'Unauthenticated socket' });
      client.disconnect(true);
      return;
    }

    if (data?.userId && data.userId !== verifiedUserId) {
      this.logger.warn(
        `[ws] join-user-room rejected: claimed=${data.userId} verified=${verifiedUserId}`,
      );
      client.emit('error', { message: 'userId mismatch' });
      client.disconnect(true);
      return;
    }

    client.join(`user-${verifiedUserId}`);
    client.emit('joined-room', {
      message: `Joined room for user ${verifiedUserId}`,
      room: `user-${verifiedUserId}`,
    });
  }

  @SubscribeMessage('join-role-room')
  handleJoinRoleRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roleName: string },
  ) {
    const { roleName } = data;
    if (!roleName) return;
    const entry = this.connectedClients.get(client.id);
    if (!entry) {
      // unauthenticated — refuse silently (handleConnection should have
      // disconnected already, but guard defensively).
      return;
    }
    client.join(`role-${roleName}`);
    if (!entry.roles.includes(roleName)) {
      entry.roles.push(roleName);
    }
    client.emit('joined-room', {
      message: `Joined role room: ${roleName}`,
      room: `role-${roleName}`,
    });
  }

  /**
   * W106: register interest in a set of userIds. The gateway will fan out
   * `presence:changed` events for these ids — and ONLY these ids — to
   * this socket. Replaces the previous broadcast-everything strategy.
   */
  @SubscribeMessage('subscribe-presence')
  handleSubscribePresence(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { userIds: string[] },
  ) {
    const entry = this.connectedClients.get(client.id);
    if (!entry) return;
    const ids = Array.isArray(data?.userIds) ? data.userIds : [];
    entry.subscribedPresenceUserIds = new Set(ids.filter(Boolean));
    client.emit('subscribed-presence', { count: entry.subscribedPresenceUserIds.size });
  }

  @SubscribeMessage('unsubscribe-presence')
  handleUnsubscribePresence(@ConnectedSocket() client: Socket) {
    const entry = this.connectedClients.get(client.id);
    if (!entry) return;
    entry.subscribedPresenceUserIds = new Set();
  }

  @SubscribeMessage('leave-user-room')
  handleLeaveUserRoom(@ConnectedSocket() client: Socket) {
    const entry = this.connectedClients.get(client.id);
    if (entry) {
      // Don't delete the entire entry — disconnect handles that. Just
      // leave the room (the socket may want to stay connected for
      // role-scoped events).
      client.leave(`user-${entry.userId}`);
      this.logger.log(`[ws] ${client.id} left user-${entry.userId}`);
    }
  }

  @SubscribeMessage('leave-role-room')
  handleLeaveRoleRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roleName: string },
  ) {
    const { roleName } = data;
    if (!roleName) return;
    client.leave(`role-${roleName}`);
    const entry = this.connectedClients.get(client.id);
    if (entry) {
      entry.roles = entry.roles.filter((r) => r !== roleName);
    }
    this.logger.log(`[ws] ${client.id} left role-${roleName}`);
  }

  // ---------------------------------------------------------------------
  // Presence event relay
  // ---------------------------------------------------------------------

  /**
   * Subscribed to the in-process `presence:changed` channel emitted by
   * `PresenceService`. Fans out to sockets that explicitly subscribed
   * to the changed userId.
   *
   * NOTE: in a multi-instance deployment this channel is local to the
   * instance and would need a Redis pub/sub bridge or the Socket.IO
   * Redis adapter. That is flagged in W106-PLAN-USER-PRESENCE.md as a
   * Wave 108 follow-up and is explicitly out of scope here.
   */
  @OnEvent('presence:changed')
  handlePresenceChanged(payload: PresenceChangedEvent) {
    if (!payload?.userId) return;
    const wire = {
      userId: payload.userId,
      online: payload.online,
      lastSeen: payload.lastSeen ? payload.lastSeen.toISOString() : null,
    };

    for (const [, entry] of this.connectedClients.entries()) {
      if (entry.subscribedPresenceUserIds.has(payload.userId)) {
        entry.socket.emit('presence:changed', wire);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Pre-existing notifier helpers (UNCHANGED API surface)
  // ---------------------------------------------------------------------

  notifyWorkStatusUpdate(
    userId: string,
    workStatus: string,
    workHistoryId: string,
    role?: string,
    previousRole?: string,
    previousWorkStatus?: string,
    updatedBy?: string,
  ) {
    this.server.to(`user-${userId}`).emit('work-status-updated', {
      userId,
      workStatus,
      workHistoryId,
      role,
      previousRole,
      previousWorkStatus,
      updatedBy,
      timestamp: new Date().toISOString(),
      message: `Your work status has been updated to: ${workStatus}`,
    });

    this.logger.log(
      `Notified user ${userId} about work status update: ${workStatus}, role: ${role}, previousRole: ${previousRole}, previousWorkStatus: ${previousWorkStatus}`,
    );
  }

  broadcastAnnouncementToRoles(roleNames: string[], announcement: any) {
    for (const roleName of roleNames) {
      const roomName = `role-${roleName}`;
      this.logger.log(`[Gateway] broadcasting announcement to ${roomName}`);
      this.logger.log(`[Gateway] payload: ${JSON.stringify(announcement)}`);
      this.server.to(roomName).emit('announcement', {
        type: 'announcement',
        announcement,
        role: roleName,
        timestamp: new Date().toISOString(),
        message: `New announcement published for role: ${roleName}`,
      });
      this.logger.log(`Broadcasted announcement to role room: ${roomName}`);
    }
  }

  getConnectedClients() {
    return Array.from(this.connectedClients.entries()).map(
      ([socketId, { userId, roles }]) => ({ socketId, userId, roles }),
    );
  }

  /** W106 — used by `PresenceSweeper` if it ever needs an authoritative
   * "who is connected on this instance" view. */
  getConnectedUserIds(): string[] {
    const ids = new Set<string>();
    for (const [, v] of this.connectedClients.entries()) ids.add(v.userId);
    return Array.from(ids);
  }

  isUserConnected(userId: string): boolean {
    for (const [, value] of this.connectedClients.entries()) {
      if (value.userId === userId) return true;
    }
    return false;
  }

  getUserSocket(userId: string): Socket | null {
    for (const [, value] of this.connectedClients.entries()) {
      if (value.userId === userId) return value.socket;
    }
    return null;
  }

  getClientsInRoleRoom(roleName: string): string[] {
    const clients: string[] = [];
    for (const [socketId, value] of this.connectedClients.entries()) {
      if (value.roles.includes(roleName)) clients.push(socketId);
    }
    return clients;
  }

  notifyPdfGenerationProgress(
    userId: string,
    developmentPlanId: string,
    progress: { percentage: number; stage: string; message?: string },
  ) {
    this.server.to(`user-${userId}`).emit('pdf-generation-progress', {
      userId,
      developmentPlanId,
      progress: {
        percentage: progress.percentage,
        stage: progress.stage,
        message: progress.message,
      },
      timestamp: new Date().toISOString(),
    });

    this.logger.log(
      `PDF generation progress for user ${userId}, plan ${developmentPlanId}: ${progress.percentage}% - ${progress.stage}`,
    );
  }
}
