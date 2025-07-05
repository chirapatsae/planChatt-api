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

@Injectable()
export class TrackingStatusService {
  private readonly logger = new Logger(TrackingStatusService.name);

  constructor(
    @InjectRepository(TrackingStatus)
    private readonly trackingStatusRepo: Repository<TrackingStatus>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Status)
    private readonly statusRepo: Repository<Status>,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,
    @InjectRepository(Comment)
    private readonly commentRepo: Repository<Comment>,
  ) {}

  async create(dto: CreateTrackingStatusDto, userId: string): Promise<{ message: string }> {
    try {
      const user = await this.getUserOrThrow(userId);
      const status = await this.getStatusOrThrow(dto.statusId);
  
      const workHistory = await this.workHistoryRepo.findOne({
        where: { user: { id: user.id }, status : 'approved'},
        relations: ['projectGroup'],
      });
  
      const tracking = this.trackingStatusRepo.create({
        status,
        projectGroup: { id: dto.projectId },
        workHistory: { id: workHistory?.id },
      });
  
      const savedTracking = await this.trackingStatusRepo.save(tracking);
  
      // ✅ ถ้ามี comment หลายรายการ ให้ loop + save ทีละรายการ
      if (dto.comment?.length) {
        const comments = dto.comment.map((c) =>
          this.commentRepo.create({
            detail: c.detail,
            step: c.step,
            trackingStatus: savedTracking,
          }),
        );
        await this.commentRepo.save(comments); // ✅ save array ได้เลย
      }
  
      return {
        message: 'Tracking status created successfully',
      };
    } catch (error) {
      this.logger.error('Failed to create tracking status', error.stack);
      throw this.handleError(error);
    }
  }
  

  async findAll(): Promise<TrackingStatus[]> {
    try {
      return await this.trackingStatusRepo.find({
        relations: ['user', 'status'],
      });
    } catch (error) {
      this.logger.error('Failed to fetch tracking statuses', error.stack);
      throw new InternalServerErrorException('Failed to fetch tracking statuses');
    }
  }

  async findOne(id: string): Promise<TrackingStatus> {
    try {
      const tracking = await this.trackingStatusRepo.findOne({
        where: { id },
        relations: ['user', 'status'],
      });

      if (!tracking) {
        throw new NotFoundException(`Tracking status with ID ${id} not found`);
      }

      return tracking;
    } catch (error) {
      this.logger.error(`Failed to fetch tracking status ${id}`, error.stack);
      throw this.handleError(error);
    }
  }

  async update(id: string, dto: UpdateTrackingStatusDto): Promise<{ message: string; data: TrackingStatus }> {
    try {
      const tracking = await this.trackingStatusRepo.findOne({ where: { id } });

      if (!tracking) {
        throw new NotFoundException(`Tracking status with ID ${id} not found`);
      }


      if (dto.statusId) {
        tracking.status = await this.getStatusOrThrow(dto.statusId);
      }

      Object.assign(tracking, dto);
      const updated = await this.trackingStatusRepo.save(tracking);

      return {
        message: 'Tracking status updated successfully',
        data: updated,
      };
    } catch (error) {
      this.logger.error(`Failed to update tracking status ${id}`, error.stack);
      throw this.handleError(error);
    }
  }

  async softRemove(id: string): Promise<{ message: string }> {
    try {
      const tracking = await this.trackingStatusRepo.findOne({ where: { id } });

      if (!tracking) {
        throw new NotFoundException(`Tracking status with ID ${id} not found`);
      }

      await this.trackingStatusRepo.softRemove(tracking);
      return {
        message: `Tracking status ${id} removed successfully`,
      };
    } catch (error) {
      this.logger.error(`Failed to remove tracking status ${id}`, error.stack);
      throw this.handleError(error);
    }
  }

  async restore(id: string): Promise<{ message: string; data: TrackingStatus }> {
    try {
      const tracking = await this.trackingStatusRepo.findOne({
        where: { id },
        withDeleted: true,
      });
  
      if (!tracking) {
        throw new NotFoundException(`Tracking status with ID ${id} not found`);
      }
  
      await this.trackingStatusRepo.restore(id);
  
      const restoredTracking = await this.trackingStatusRepo.findOne({
        where: { id },
        relations: ['user', 'status'],
      });
  
      if (!restoredTracking) {
        throw new NotFoundException(`Tracking status with ID ${id} not found after restore`);
      }
  
      return {
        message: `Tracking status ${id} restored successfully`,
        data: restoredTracking, // ✅ now guaranteed not null
      };
    } catch (error) {
      this.logger.error(`Failed to restore tracking status ${id}`, error.stack);
      throw this.handleError(error);
    }
  }
  
  // Helper methods

  private async getUserOrThrow(id: string): Promise<User> {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException(`User with ID ${id} not found`);
    return user;
  }

  private async getStatusOrThrow(id: string): Promise<Status> {
    const status = await this.statusRepo.findOne({ where: { id } });
    if (!status) throw new NotFoundException(`Status with ID ${id} not found`);
    return status;
  }

  private handleError(error: any) {
    if (error instanceof NotFoundException || error instanceof BadRequestException) {
      return error;
    }
    return new InternalServerErrorException('Unexpected error occurred');
  }
}
