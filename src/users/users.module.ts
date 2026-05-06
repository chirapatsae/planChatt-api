import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ThrottlerModule } from '@nestjs/throttler';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { User } from './entities/user.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Status } from 'src/status/entities/status.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { AiUsageQuotasModule } from 'src/ai-usage-quotas/ai-usage-quotas.module';
import { StorageModule } from 'src/storage/storage.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, WorkHistory, Status, TrackingStatus]),
    // BE-IMPL-01 P2-B — Cap the multipart body parser at 5 MB so an
    // oversize upload is rejected MID-STREAM by Multer instead of being
    // buffered fully before ParseFilePipe rejects it. Defends against
    // a memory-exhaustion DoS on the profile-image endpoint.
    MulterModule.register({
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
    // BE-IMPL-01 P2-C — Per-route upload rate-limit (30 / min). Mirrors
    // the module-scoped pattern used by LineModule (W86) so we don't
    // couple user-route throttling to a global tracker. The `@Throttle`
    // decorator on the upload + delete routes selects this default
    // bucket; the routes also list `ThrottlerGuard` in their
    // `@UseGuards(...)` so enforcement is opt-in (no global APP_GUARD
    // registration).
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 30 },
    ]),
    AiUsageQuotasModule,
    StorageModule,
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule { }
