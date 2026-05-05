/**
 * W106-BE-PR1 — PresenceModule
 *
 * Wires the presence subsystem:
 *   - PresenceRedis      (ioredis client, dedicated, separate from Bull)
 *   - PresenceService    (markOnline / markOffline / bulk lookups / sweep)
 *   - PresenceController (REST surface, JWT-guarded)
 *   - PresenceSweeper    (cron @nestjs/schedule, every 60s)
 *
 * Exports:
 *   - PresenceService — consumed by `WebsocketGateway` for connect/disconnect
 *
 * §4.1 / §17.2 — this module deliberately imports NO workflow modules
 * (TrackingStatusModule, ProjectGroupModule, RevisedProjectGroupModule, …).
 * Presence is advisory metadata, not a transition gate.
 *
 * §17.3 — only TypeORM dependency is the User entity (for last_seen_at and
 * soft-delete filter). No FK to project / audit tables anywhere in the
 * presence pipeline.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { User } from 'src/users/entities/user.entity';
import { PresenceRedis } from './presence.redis';
import { PresenceService } from './presence.service';
import { PresenceController } from './presence.controller';
import { PresenceSweeper } from './presence.sweeper';

@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    // Mirror AuthModule's JwtModule.register so PresenceService /
    // WebsocketGateway can verify tokens without needing AuthModule
    // to export the JwtService (avoids a circular import: AuthModule ←
    // UsersModule, and presence has to live underneath AuthModule's
    // surface without depending on it).
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'defaultSecret',
      signOptions: { expiresIn: '1d' },
    }),
  ],
  controllers: [PresenceController],
  providers: [PresenceRedis, PresenceService, PresenceSweeper],
  exports: [PresenceService, PresenceRedis, JwtModule],
})
export class PresenceModule {}
