import { Module } from '@nestjs/common';
import { CommentsService } from './comments.service';
import { CommentsController } from './comments.controller';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Comment } from './entities/comment.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WorkHistory,
      TrackingStatus,
      ProjectGroup,
      Comment,
    ]), // ✅ Add these
  ],
  controllers: [CommentsController],
  providers: [CommentsService],
})
export class CommentsModule {}
