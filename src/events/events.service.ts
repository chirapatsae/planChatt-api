import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, Between, MoreThan, LessThan } from 'typeorm';
import { Event } from './entities/event.entity';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { EventResponseDto } from './dto/event-response.dto';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { AttachmentEventService } from 'src/attachment-event/attachment-event.service';
import { AnnouncementsService } from 'src/announcements/announcements.service';
import { RolesService } from 'src/roles/roles.service';
import { AnnouncementStatus, NotificationType } from 'src/announcements/entities/announcement.entity';
import { UsersService } from 'src/users/users.service';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepository: Repository<WorkHistory>,
    private readonly attachmentEventService: AttachmentEventService,
    private readonly announcementsService: AnnouncementsService,
    private readonly rolesService: RolesService,
    // W89B — used to decrypt `event.createdBy.user` PII at the response
    // boundary. Pre-W89B this entity flowed straight from TypeORM into
    // the response DTO with `iv:ciphertext` email/phone columns.
    private readonly usersService: UsersService,
  ) {}

  async create(createEventDto: CreateEventDto, userId: string): Promise<EventResponseDto> {
    try {
      // Get user work history
      const workHistory = await this.workHistoryRepository.findOne({
        where: { user: { id: userId } },
        relations: ['user'],
      });

      if (!workHistory) {
        throw new BadRequestException('User work history not found');
      }

      // Create event
      const event = this.eventRepository.create({
        ...createEventDto,
        startDate: new Date(createEventDto.startDate),
        endDate: new Date(createEventDto.endDate),
        publishDateTime: new Date(),
        createdBy: workHistory,
      });

      const savedEvent = await this.eventRepository.save(event);

      // Send notification to all roles
      try {
        const roles = await this.rolesService.findAll();
        const roleIds = roles.map(r => r.id);

        if (roleIds.length > 0) {
          await this.announcementsService.create({
            title: `กิจกรรมใหม่: ${savedEvent.title}`,
            description: savedEvent.description,
            type: NotificationType.EVENT,
            status: AnnouncementStatus.PUBLISHED,
            roleIds: roleIds,
          }, userId);
          this.logger.log(`Created new event notification for all roles`);
        }
      } catch (notificationError) {
        this.logger.error(`Failed to create event notification: ${notificationError.message}`, notificationError.stack);
        // We don't throw here because the event itself is already saved successfully
      }

      return await this.mapToResponseDto(savedEvent);
    } catch (error) {
      this.logger.error(`Error creating event: ${error.message}`, error.stack);
      throw error;
    }
  }

  async findAll(query?: {
    search?: string;
    status?: string;
    dateFilter?: string;
    location?: string;
  }): Promise<EventResponseDto[]> {
    try {
      let queryBuilder = this.eventRepository
        .createQueryBuilder('event')
        .leftJoinAndSelect('event.createdBy', 'createdBy')
        .leftJoinAndSelect('createdBy.user', 'user')
        .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
        .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'localAdministrativeOrganization')
        .orderBy('event.createdAt', 'DESC');

      // Apply search filter
      if (query?.search) {
        queryBuilder = queryBuilder.where(
          '(event.title ILIKE :search OR event.description ILIKE :search OR event.location->>\'name\' ILIKE :search OR event.location->>\'address\' ILIKE :search)',
          { search: `%${query.search}%` }
        );
      }

      // Apply status filter
      if (query?.status && query.status !== 'all') {
        const now = new Date();
        
        switch (query.status) {
          case 'upcoming':
            queryBuilder = queryBuilder.andWhere('event.startDate > :now', { now });
            break;
          case 'ongoing':
            queryBuilder = queryBuilder.andWhere(
              'event.startDate <= :now AND event.endDate >= :now',
              { now }
            );
            break;
          case 'completed':
            queryBuilder = queryBuilder.andWhere('event.endDate < :now', { now });
            break;
        }
      }

      // Apply date filter
      if (query?.dateFilter && query.dateFilter !== 'all') {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const weekStart = new Date(today);
        weekStart.setDate(today.getDate() - today.getDay());
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        switch (query.dateFilter) {
          case 'today':
            queryBuilder = queryBuilder.andWhere(
              'event.startDate <= :today AND event.endDate >= :today',
              { today }
            );
            break;
          case 'week':
            const weekEnd = new Date(weekStart.getTime() + 6 * 24 * 60 * 60 * 1000);
            queryBuilder = queryBuilder.andWhere(
              'event.startDate <= :weekEnd AND event.endDate >= :weekStart',
              { weekStart, weekEnd }
            );
            break;
          case 'month':
            const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
            queryBuilder = queryBuilder.andWhere(
              'event.startDate <= :monthEnd AND event.endDate >= :monthStart',
              { weekStart, monthEnd }
            );
            break;
          case 'upcoming':
            queryBuilder = queryBuilder.andWhere('event.startDate > :now', { now });
            break;
          case 'expired':
            queryBuilder = queryBuilder.andWhere('event.endDate < :now', { now });
            break;
        }
      }

      // Apply location filter
      if (query?.location) {
        queryBuilder = queryBuilder.andWhere(
          'event.location->>\'name\' ILIKE :location OR event.location->>\'address\' ILIKE :location',
          { location: `%${query.location}%` }
        );
      }

      const events = await queryBuilder.getMany();
      
      // Map events to response DTOs
      const eventPromises = events.map(event => this.mapToResponseDto(event));
      return Promise.all(eventPromises);
    } catch (error) {
      this.logger.error(`Error fetching events: ${error.message}`, error.stack);
      throw error;
    }
  }

  async findOne(id: string): Promise<EventResponseDto> {
    try {
      const event = await this.eventRepository.findOne({
        where: { id },
        relations: ['createdBy', 'createdBy.user'],
      });

      if (!event) {
        throw new NotFoundException(`Event with ID ${id} not found`);
      }

      return await this.mapToResponseDto(event);
    } catch (error) {
      this.logger.error(`Error fetching event ${id}: ${error.message}`, error.stack);
      throw error;
    }
  }

  async update(id: string, updateEventDto: UpdateEventDto, userId: string): Promise<EventResponseDto> {
    try {
      const event = await this.eventRepository.findOne({
        where: { id },
        relations: ['createdBy', 'createdBy.user'],
      });

      if (!event) {
        throw new NotFoundException(`Event with ID ${id} not found`);
      }

      // Check if user is the creator or has admin rights
      if (event.createdBy?.user?.id !== userId) {
        // TODO: Add admin role check here
        throw new BadRequestException('You can only edit events you created');
      }

      // Prepare update data
      const updateData: any = { ...updateEventDto };
      
      // Convert string dates to Date objects if provided
      if (updateEventDto.startDate || updateEventDto.endDate) {
        if (updateEventDto.startDate) {
          updateData.startDate = new Date(updateEventDto.startDate);
        }
        if (updateEventDto.endDate) {
          updateData.endDate = new Date(updateEventDto.endDate);
        }
      }

      // Convert string dates to Date objects
      if (updateEventDto.startDate) {
        updateData.startDate = new Date(updateEventDto.startDate);
      }
      if (updateEventDto.endDate) {
        updateData.endDate = new Date(updateEventDto.endDate);
      }

      await this.eventRepository.update(id, updateData);
      
      const updatedEvent = await this.eventRepository.findOne({
        where: { id },
        relations: ['createdBy', 'createdBy.user'],
      });

      if (!updatedEvent) {
        throw new NotFoundException(`Event with ID ${id} not found after update`);
      }

      return await this.mapToResponseDto(updatedEvent);
    } catch (error) {
      this.logger.error(`Error updating event ${id}: ${error.message}`, error.stack);
      throw error;
    }
  }

  async remove(id: string, userId: string): Promise<void> {
    try {
      const event = await this.eventRepository.findOne({
        where: { id },
        relations: ['createdBy', 'createdBy.user'],
      });

      if (!event) {
        throw new NotFoundException(`Event with ID ${id} not found`);
      }

      // Check if user is the creator or has admin rights
      if (event.createdBy?.user?.id !== userId) {
        // TODO: Add admin role check here
        throw new BadRequestException('You can only delete events you created');
      }

      await this.eventRepository.softDelete(id);
    } catch (error) {
      this.logger.error(`Error deleting event ${id}: ${error.message}`, error.stack);
      throw error;
    }
  }

  private async mapToResponseDto(event: Event): Promise<EventResponseDto> {
    // ดึงข้อมูล attachments จาก attachment-event service
    const attachments = await this.attachmentEventService.findByEventId(event.id);

    // W89B — `event.createdBy.user` arrives from TypeORM with email/phone
    // still in `iv:ciphertext` form (W89 encrypted these columns at rest).
    // Decrypt at the response boundary so the FE never sees ciphertext.
    // `decryptUserPii` is idempotent (W89B ciphertext heuristic guards
    // each column) so a re-decrypt on cached/repeated entities is safe.
    if (event.createdBy?.user) {
      await this.usersService.decryptUserPii(event.createdBy.user);
    }

    return {
      id: event.id,
      title: event.title,
      description: event.description,
      location: event.location,
      startDate: event.startDate,
      endDate: event.endDate,
      attachments: attachments.map(att => ({
        id : att.id,
        filename: att.filename,
        originalName: att.originalName,
        mimetype: att.mimetype,
        size: att.size,
        path: att.path,
      })),
      publishDateTime: event.publishDateTime,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
      createdBy: event.createdBy ? {
        id: event.createdBy.id,
        amphoe: event.createdBy.amphoe || undefined,
        localAdministrativeOrganization: event.createdBy.localAdministrativeOrganization || undefined,
        user: event.createdBy.user ? {
          firstname: event.createdBy.user.firstname,
          lastname: event.createdBy.user.lastname,
          email: event.createdBy.user.email,
          phone: event.createdBy.user.phone,
        } : undefined,
      } : undefined,
    };
  }
}
