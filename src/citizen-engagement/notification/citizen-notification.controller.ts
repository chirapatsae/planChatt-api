import {
  Controller,
  Get,
  MessageEvent,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { interval, map, merge, Observable } from 'rxjs';

import { CitizenJwtGuard } from '../citizen-auth/citizen-jwt.guard';
import { ListCitizenChronoQueryDto } from '../dto/list-citizen-chrono-query.dto';
import { CitizenNotificationBus } from './citizen-notification.bus';
import { CitizenNotificationService } from './citizen-notification.service';

/** Heartbeat cadence — under the typical 30–60s idle-proxy timeout so the SSE
 * connection is never dropped by an intermediary while idle. */
const SSE_HEARTBEAT_MS = 25_000;

/** `req.user` shape set by CitizenJwtGuard / CitizenJwtStrategy. */
interface CitizenRequest {
  user: { identityId: string };
}

/**
 * Citizen NOTIFICATION inbox (C3, §17.2 advisory).
 *
 * The whole controller is citizen-gated. Every action reads/writes the
 * CALLER'S OWN inbox (recipient = `req.user.identityId`) — NEVER a body/param
 * identity. D11/D16: there is no follower-of-me roster, only "my inbox".
 */
@Controller({ path: 'citizen-engagement/me/notifications', version: '1' })
@UseGuards(CitizenJwtGuard)
export class CitizenNotificationController {
  constructor(
    private readonly notificationService: CitizenNotificationService,
    private readonly notificationBus: CitizenNotificationBus,
  ) {}

  /**
   * W-T2 realtime SSE stream (§17.2 advisory — carries notifications, gates
   * nothing). The caller identity comes ONLY from `req.user.identityId` (set by
   * `CitizenJwtGuard` / `CitizenJwtStrategy` from the verified JWT `sub`) — never
   * a param/body — so a citizen only ever streams their OWN events (§17.3
   * isolation, enforced by `bus.streamFor`'s per-recipient filter).
   *
   * The recipient stream is MERGED with a heartbeat so idle proxies don't drop
   * the connection. Events carry NO PII — just `{ type }` JSON. NestJS
   * auto-unsubscribes from both sources on client disconnect (request close).
   */
  @Sse('stream')
  stream(@Req() req: CitizenRequest): Observable<MessageEvent> {
    const events = this.notificationBus.streamFor(req.user.identityId).pipe(
      map((evt): MessageEvent => ({ data: JSON.stringify({ type: evt.type }) })),
    );
    const heartbeat = interval(SSE_HEARTBEAT_MS).pipe(
      map((): MessageEvent => ({ data: JSON.stringify({ type: 'ping' }) })),
    );
    return merge(events, heartbeat);
  }

  @Get()
  list(@Req() req: CitizenRequest, @Query() query: ListCitizenChronoQueryDto) {
    return this.notificationService.listNotifications(
      req.user.identityId,
      query.limit,
      query.beforeCreatedAt,
      query.beforeId,
    );
  }

  @Get('unread-count')
  unreadCount(@Req() req: CitizenRequest) {
    return this.notificationService.unreadCount(req.user.identityId);
  }

  @Post(':id/read')
  markRead(
    @Req() req: CitizenRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.notificationService.markRead(req.user.identityId, id);
  }

  @Post('read-all')
  markAllRead(@Req() req: CitizenRequest) {
    return this.notificationService.markAllRead(req.user.identityId);
  }
}
