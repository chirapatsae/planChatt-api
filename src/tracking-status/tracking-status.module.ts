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
  ],
  controllers: [TrackingStatusController],
  providers: [TrackingStatusService],
})
export class TrackingStatusModule {}
