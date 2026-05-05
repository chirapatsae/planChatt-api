import { Module } from '@nestjs/common';
import { WebsocketGateway } from './websocket/websocket.gateway';
import { WebsocketService } from './websocket/websocket.service';
// W106-BE-PR1 — gateway now requires:
//   1. JwtService — to verify the handshake token
//   2. PresenceService — to mirror connect/disconnect into Redis
// PresenceModule re-exports both (`JwtModule` is registered there with
// the same secret as AuthModule, sidestepping a potential circular
// import via UsersModule).
import { PresenceModule } from 'src/presence/presence.module';

@Module({
  imports: [PresenceModule],
  providers: [WebsocketGateway, WebsocketService],
  exports: [WebsocketService],
})
export class WebsocketModule {}
