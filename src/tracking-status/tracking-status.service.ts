import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateTrackingStatusDto } from './dto/create-tracking-status.dto';
import { UpdateTrackingStatusDto } from './dto/update-tracking-status.dto';
import { User } from 'src/users/entities/user.entity';
import { Status } from 'src/status/entities/status.entity';
import { TrackingStatus } from './entities/tracking-status.entity';
import { Comment } from 'src/comments/entities/comment.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { handleException } from 'src/util/handleException';

@Injectable()
export class TrackingStatusService {
  private readonly logger = new Logger(TrackingStatusService.name);

  constructor(
    @InjectRepository(TrackingStatus)
    private readonly trackingStatusRepo: Repository<TrackingStatus>,
    @InjectRepository(ProjectGroup)
    private readonly projectGroupRepo: Repository<ProjectGroup>,
    @InjectRepository(Status)
    private readonly statusRepo: Repository<Status>,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,
    @InjectRepository(Comment)
    private readonly commentRepo: Repository<Comment>,
  ) {}

  async create(
    dto: CreateTrackingStatusDto,
    userId: string,
  ): Promise<TrackingStatus> {
    try {
      // หา workHistory ของ user
      const workHistory = await this.workHistoryRepo.findOne({
        where: { user: { id: userId } },
      });
      if (!workHistory)
        throw new NotFoundException(`WorkHistory for user ${userId} not found`);

      // หา projectGroup
      const projectGroup = await this.projectGroupRepo.findOne({
        where: { id: dto.projectId },
      });
      if (!projectGroup)
        throw new NotFoundException(
          `ProjectGroup with ID ${dto.projectId} not found`,
        );

      // หา status
      const status = await this.statusRepo.findOne({
        where: { id: dto.statusId },
      });
      if (!status)
        throw new NotFoundException(`Status with ID ${dto.statusId} not found`);

      // set isLatest = true และอัปเดตตัวเก่าให้ isLatest = false
      await this.trackingStatusRepo.update(
        { projectGroupId: projectGroup },
        { isLatest: false },
      );

      // สร้าง TrackingStatus
      const tracking = this.trackingStatusRepo.create({
        comment: undefined, // ไม่ใช้ comment ตรง entity
        createdBy: workHistory,
        projectGroupId: projectGroup,
        statusId: status,
        isLatest: true,
      });
      const savedTracking = await this.trackingStatusRepo.save(tracking);

      return savedTracking;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll(): Promise<TrackingStatus[]> {
    try {
      return await this.trackingStatusRepo.find({
        relations: [
          'createdBy',
          'deletedBy',
          'projectGroupId',
          'statusId',
          'comments',
        ],
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<TrackingStatus> {
    try {
      const tracking = await this.trackingStatusRepo.findOne({
        where: { id },
        relations: [
          'createdBy',
          'deletedBy',
          'projectGroupId',
          'statusId',
          'comments',
        ],
      });
      if (!tracking) {
        throw new NotFoundException(`Tracking status with ID ${id} not found`);
      }
      return tracking;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(
    id: string,
    dto: UpdateTrackingStatusDto,
  ): Promise<{ message: string; data: TrackingStatus }> {
    try {
      const tracking = await this.trackingStatusRepo.findOne({ where: { id } });
      if (!tracking) {
        throw new NotFoundException(`Tracking status with ID ${id} not found`);
      }
      if (dto.statusId) {
        const status = await this.statusRepo.findOne({
          where: { id: dto.statusId },
        });
        if (!status)
          throw new NotFoundException(
            `Status with ID ${dto.statusId} not found`,
          );
        tracking.statusId = status;
      }
      const updated = await this.trackingStatusRepo.save(tracking);
      return {
        message: 'Tracking status updated successfully',
        data: updated,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async softRemove(id: string, userId?: string): Promise<{ message: string }> {
    try {
      const tracking = await this.trackingStatusRepo.findOne({ where: { id } });
      if (!tracking) {
        throw new NotFoundException(`Tracking status with ID ${id} not found`);
      }
      if (userId) {
        const workHistory = await this.workHistoryRepo.findOne({
          where: { user: { id: userId } },
        });
        if (workHistory) tracking.deletedBy = workHistory;
        await this.trackingStatusRepo.save(tracking);
      }
      await this.trackingStatusRepo.softRemove(tracking);
      return {
        message: `Tracking status ${id} removed successfully`,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async restore(
    id: string,
  ): Promise<{ message: string; data: TrackingStatus }> {
    try {
      await this.trackingStatusRepo.restore(id);
      const restoredTracking = await this.trackingStatusRepo.findOne({
        where: { id },
        relations: [
          'createdBy',
          'deletedBy',
          'projectGroupId',
          'statusId',
          'comments',
        ],
      });
      if (!restoredTracking) {
        throw new NotFoundException(
          `Tracking status with ID ${id} not found after restore`,
        );
      }
      return {
        message: `Tracking status ${id} restored successfully`,
        data: restoredTracking,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}
