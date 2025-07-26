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

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TrackingStatus,
      User,
      Status,
      WorkHistory,
      Comment,
      ProjectGroup,
    ]),
  ],
  controllers: [TrackingStatusController],
  providers: [TrackingStatusService],
})
export class TrackingStatusModule {}
