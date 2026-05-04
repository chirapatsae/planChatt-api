import { Module } from '@nestjs/common';
import { TrackingStatusService } from './tracking-status.service';
import { TrackingStatusController } from './tracking-status.controller';
import { TrackingStatus } from './entities/tracking-status.entity';
import { User } from 'src/users/entities/user.entity';
import { Status } from 'src/status/entities/status.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Comment } from 'src/comments/entities/comment.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';

import { AnnouncementsModule } from 'src/announcements/announcements.module';
import { WorkHistoryAmphoeResponsibility } from 'src/work-history-amphoe-responsibility/entities/work-history-amphoe-responsibility.entity';
import { WorkHistoryGovernmentAgencyResponsibility } from 'src/work-history-government-agency-responsibility/entities/work-history-government-agency-responsibility.entity';
import { LineageLockModule } from 'src/common/lineage-lock/lineage-lock.module';
import { NotificationsEmailModule } from 'src/notifications/email/notifications-email.module';
import { NotificationsLineModule } from 'src/notifications/line/notifications-line.module';
// W105 BE-PR2 — digest dispatcher consumed by TrackingStatusService.bulkSubmit
// to collapse N per-project notifications into ONE digest job per
// (recipientUserId, eventType) group. Registered as a provider here so it
// can be constructor-injected; depends on NotificationsEmail/LineModule
// (already imported above) and the local Status repository (already in
// TypeOrmModule.forFeature below).
import { DigestDispatcherService } from 'src/notifications/digest/digest-dispatcher.service';
import { UsersModule } from 'src/users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TrackingStatus,
      User,
      Status,
      WorkHistory,
      Comment,
      ProjectGroup,
      RevisedProjectGroup,
      WorkHistoryAmphoeResponsibility,
      WorkHistoryGovernmentAgencyResponsibility,
    ]),
    AnnouncementsModule,
    LineageLockModule,
    NotificationsEmailModule,
    // W96-TRIGGER-WIRING — independent LINE fanout (Q9). Imported here so
    // TrackingStatusService can inject NotificationsLineService alongside
    // NotificationsEmailService.
    NotificationsLineModule,
    // W100 PR3 — needed by TrackingStatusService.maskActorUsersOnTracking
    // to call `usersService.decryptUserPii(user)` before masking actor email.
    // §17.11: masking is applied uniformly regardless of role; no reveal here.
    UsersModule,
  ],
  controllers: [TrackingStatusController],
  providers: [TrackingStatusService, DigestDispatcherService],
})
export class TrackingStatusModule {}
