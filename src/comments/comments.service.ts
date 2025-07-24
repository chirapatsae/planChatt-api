import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Repository } from 'typeorm';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { Comment } from './entities/comment.entity';

@Injectable()
export class CommentsService {
  constructor(
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,

    @InjectRepository(TrackingStatus)
    private readonly trackingStatusRepo: Repository<TrackingStatus>,

    @InjectRepository(ProjectGroup)
    private readonly projectGroupRepo: Repository<ProjectGroup>,

    @InjectRepository(Comment)
    private readonly commentRepo: Repository<Comment>, // 💡 ADD THIS!
  ) {}
  async create(createCommentDto: CreateCommentDto) {
    try {
      const trackingStatus = await this.trackingStatusRepo.findOne({
        where: { id: createCommentDto.trackingStatusId },
      });
      if (!trackingStatus) {
        throw new NotFoundException('Status ID not found');
      }

      const comment = this.commentRepo.create({
        detail: createCommentDto.detail,
        step: createCommentDto.step,
        trackingStatusId: trackingStatus,
      });

      await this.commentRepo.save(comment);

      return comment;
    } catch (error) {
      throw error;
    }
  }
}
