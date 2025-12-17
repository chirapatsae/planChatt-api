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
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { handleException } from 'src/util/handleException';

@Injectable()
export class TrackingStatusService {
  private readonly logger = new Logger(TrackingStatusService.name);

  constructor(
    @InjectRepository(TrackingStatus)
    private readonly trackingStatusRepo: Repository<TrackingStatus>,
    @InjectRepository(ProjectGroup)
    private readonly projectGroupRepo: Repository<ProjectGroup>,
    @InjectRepository(RevisedProjectGroup)
    private readonly revisedProjectGroupRepo: Repository<RevisedProjectGroup>,
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
          projectGroupId: { id: projectGroup.id },
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
    try {
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
            { projectGroupId: { id: projectId } },
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
    } catch (error) {
      handleException(this.logger, error);
    }
  }
  async createManyRevisedProjectGroup(dtos: CreateTrackingStatusDto[], userId: string) {
    try {
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
            { revisedProjectGroupId: { id: projectId } },
            { isLatest: false },
          );

          // 2) create new tracking status
          const tracking = manager.create(TrackingStatus, {
            createdBy: workHistory,
            revisedProjectGroupId: { id: projectId },
            statusId: { id: statusId },
            isLatest: true,
          });

          const savedTracking = await manager.save(TrackingStatus, tracking);
          results.push(savedTracking);
        }

        return results;
      });
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

  async createByRevisedProjectGroup(dto: CreateTrackingStatusDto, userId: string): Promise<TrackingStatus> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        // หา workHistory ของ user
        const workHistory = await manager.findOne(WorkHistory, {
          where: { user: { id: userId } },
        });
        if (!workHistory) {
          throw new NotFoundException(`WorkHistory for user ${userId} not found`);
        }

        // หา RevisedProjectGroup
        const revisedProjectGroup = await manager.findOne(RevisedProjectGroup, {
          where: { id: dto.projectId },
        });
        if (!revisedProjectGroup) {
          throw new NotFoundException(`RevisedProjectGroup with ID ${dto.projectId} not found`);
        }

        // หา status
        const status = await manager.findOne(Status, {
          where: { id: dto.statusId },
        });
        if (!status) {
          throw new NotFoundException(`Status with ID ${dto.statusId} not found`);
        }

        // อัปเดต oldAdditionDetail ใน RevisedProjectGroup ถ้ามีการส่งมา
        if (dto.oldAdditionDetail !== undefined) {
          revisedProjectGroup.oldAdditionDetail = dto.oldAdditionDetail;
          await manager.save(RevisedProjectGroup, revisedProjectGroup);
        }

        // อัปเดต TrackingStatus ตัวเก่าให้ isLatest = false
        await manager.update(TrackingStatus, {
          revisedProjectGroupId: { id: revisedProjectGroup.id },
        }, {
          isLatest: false,
        });

        // สร้าง TrackingStatus ใหม่
        const tracking = manager.create(TrackingStatus, {
          createdBy: workHistory,
          revisedProjectGroupId: revisedProjectGroup,
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

  async rollbackStatus(projectGroupId: string, isResponsibleClear: boolean = false, isBookedClear: boolean = false): Promise<{ message: string; status: string }> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        // ตรวจสอบว่า projectGroup มีอยู่จริง
        const projectGroup = await manager.findOne(ProjectGroup, {
          where: { id: projectGroupId },
        });
        if (!projectGroup) {
          throw new NotFoundException(`ProjectGroup with ID ${projectGroupId} not found`);
        }

        // หา trackingStatus ที่มี isLatest = true และลบออกก่อน
        const currentLatestStatus = await manager.findOne(TrackingStatus, {
          where: {
            projectGroupId: { id: projectGroupId },
            isLatest: true,
          },
        });

        if (currentLatestStatus) {
          await manager.remove(TrackingStatus, currentLatestStatus);
        }

        // หา trackingStatus ทั้งหมดของ projectGroup นี้ (เรียงตาม createAt DESC)
        const allTrackingStatuses = await manager.find(TrackingStatus, {
          where: {
            projectGroupId: { id: projectGroupId },
          },
          order: { createAt: 'DESC' },
          relations: ['statusId', 'createdBy', 'projectGroupId'],
        });

        if (allTrackingStatuses.length === 0) {
          throw new NotFoundException(
            `No tracking status found for project group ${projectGroupId}`,
          );
        }

        // หา trackingStatus ที่มี createAt สูงสุด (ตัวล่าสุด) และ set isLatest = true
        const latestTrackingStatus = allTrackingStatuses[0]; // เพราะเรา sort DESC แล้ว
        latestTrackingStatus.isLatest = true;
        await manager.save(TrackingStatus, latestTrackingStatus);

        // ถ้า isResponsibleClear เป็น true ให้ลบ responsibleAgency
        if (isResponsibleClear) {
          projectGroup.responsibleAgency = null as any;
        }

        if (isBookedClear) {
          projectGroup.isBooked = false;
          projectGroup.bookedAt = null as any;
        }

        if (isResponsibleClear || isBookedClear) {
          await manager.save(ProjectGroup, projectGroup);
          this.logger.log(`Updated project group: ${projectGroupId} (isResponsibleClear: ${isResponsibleClear}, isBookedClear: ${isBookedClear})`);
        }

        return {
          message: `Tracking status rolled back successfully for project group ${projectGroupId}${isResponsibleClear ? ' and responsibleAgency cleared' : ''}${isBookedClear ? ' and isBooked cleared' : ''}`,
          status: 'success'
        };
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }
  
  async rollbackRevisionProjectGroupStatus(revisionProjectGroupId: string): Promise<{ message: string; status: string }> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        // ตรวจสอบว่า projectGroup มีอยู่จริง
        const revisionProjectGroup = await manager.findOne(RevisedProjectGroup, {
          where: { id: revisionProjectGroupId },
        });
        if (!revisionProjectGroup) {
          throw new NotFoundException(`ProjectGroup with ID ${revisionProjectGroupId} not found`);
        }

        // หา trackingStatus ที่มี isLatest = true และลบออกก่อน
        const currentLatestStatus = await manager.findOne(TrackingStatus, {
          where: {
            revisedProjectGroupId: { id: revisionProjectGroupId },
            isLatest: true,
          },
        });

        if (currentLatestStatus) {
          await manager.remove(TrackingStatus, currentLatestStatus);
        }

        // หา trackingStatus ทั้งหมดของ projectGroup นี้ (เรียงตาม createAt DESC)
        const allTrackingStatuses = await manager.find(TrackingStatus, {
          where: {
            revisedProjectGroupId: { id: revisionProjectGroupId },
          },
          order: { createAt: 'DESC' },
          relations: ['statusId', 'createdBy', 'projectGroupId'],
        });

        if (allTrackingStatuses.length === 0) {
          throw new NotFoundException(
            `No tracking status found for project group ${revisionProjectGroupId}`,
          );
        }

        // หา trackingStatus ที่มี createAt สูงสุด (ตัวล่าสุด) และ set isLatest = true
        const latestTrackingStatus = allTrackingStatuses[0]; // เพราะเรา sort DESC แล้ว
        latestTrackingStatus.isLatest = true;
        await manager.save(TrackingStatus, latestTrackingStatus);

        return {
          message: `Tracking status rolled back successfully for project group ${revisionProjectGroupId}}`,
          status: 'success'
        };
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}
