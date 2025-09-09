import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
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

    private readonly dataSource: DataSource,
  ) { }

  async create(dto: CreateTrackingStatusDto, userId: string): Promise<TrackingStatus> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        // หา workHistory ของ user
        const workHistory = await manager.findOne(WorkHistory, {
          where: { user: { id: userId } },
        });
        if (!workHistory) {
          throw new NotFoundException(`WorkHistory for user ${userId} not found`);
        }

        // หา projectGroup
        const projectGroup = await manager.findOne(ProjectGroup, {
          where: { id: dto.projectId },
        });
        if (!projectGroup) {
          throw new NotFoundException(`ProjectGroup with ID ${dto.projectId} not found`);
        }

        // หา status
        const status = await manager.findOne(Status, {
          where: { id: dto.statusId },
        });
        if (!status) {
          throw new NotFoundException(`Status with ID ${dto.statusId} not found`);
        }

        // อัปเดต TrackingStatus ตัวเก่าให้ isLatest = false
        await manager.update(TrackingStatus, {
          projectGroupId: projectGroup,
        }, {
          isLatest: false,
        });

        // สร้าง TrackingStatus ใหม่
        const tracking = manager.create(TrackingStatus, {
          createdBy: workHistory,
          projectGroupId: projectGroup,
          statusId: status,
          isLatest: true,
        });
        const savedTracking = await manager.save(TrackingStatus, tracking);

        if (dto.comments?.length) {
          const commentEntities = dto.comments.map((c) =>
            manager.create(Comment, {
              step: c.step,
              detail: c.detail,
              trackingStatusId: savedTracking,
            }),
          );
          await manager.save(Comment, commentEntities);
        }

        return savedTracking;
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async createMany(dtos: CreateTrackingStatusDto[], userId: string) {
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId } },
    });
  
    if (!workHistory) {
      throw new NotFoundException(`WorkHistory for user ${userId} not found`);
    }
  
    return this.dataSource.transaction(async (manager) => {
      const results: TrackingStatus[] = [];
  
      for (const dto of dtos) {
        const { projectId, statusId } = dto;
  
        // 1) update old tracking status
        await manager.update(
          TrackingStatus,
          { projectGroupId  : projectId},
          { isLatest: false },
        );
  
        // 2) create new tracking status
        const tracking = manager.create(TrackingStatus, {
          createdBy: workHistory,
          projectGroupId: { id: projectId },
          statusId: { id: statusId },
          isLatest: true,
        });
  
        const savedTracking = await manager.save(TrackingStatus, tracking);
        results.push(savedTracking);
      }
  
      return results;
    });
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
