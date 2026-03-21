import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventsService } from './events.service';
import { Event } from './entities/event.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { AnnouncementsService } from 'src/announcements/announcements.service';
import { RolesService } from 'src/roles/roles.service';
import { AttachmentEventService } from 'src/attachment-event/attachment-event.service';

describe('EventsService', () => {
  let service: EventsService;

  const mockEventRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(() => ({
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn(),
    })),
    update: jest.fn(),
    softDelete: jest.fn(),
  };

  const mockWorkHistoryRepository = {
    findOne: jest.fn(),
  };

  const mockAnnouncementsService = {
    create: jest.fn(),
  };

  const mockRolesService = {
    findAll: jest.fn(),
  };

  const mockAttachmentEventService = {
    findByEventId: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        {
          provide: getRepositoryToken(Event),
          useValue: mockEventRepository,
        },
        {
          provide: getRepositoryToken(WorkHistory),
          useValue: mockWorkHistoryRepository,
        },
        {
          provide: AnnouncementsService,
          useValue: mockAnnouncementsService,
        },
        {
          provide: RolesService,
          useValue: mockRolesService,
        },
        {
          provide: AttachmentEventService,
          useValue: mockAttachmentEventService,
        },
      ],
    }).compile();

    service = module.get<EventsService>(EventsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('should create an event successfully and send notifications', async () => {
      const createEventDto = {
        title: 'Test Event',
        description: 'Test Description',
        location: {
          name: 'Test Location',
          address: 'Test Address',
        },
        startDate: '2024-01-15T09:00:00Z',
        endDate: '2024-01-15T17:00:00Z',
        attachments: [],
      };

      const mockWorkHistory = { id: 'work-history-id', user: { id: 'user-id' } };
      const mockEvent = { id: 'event-id', ...createEventDto, status: 'upcoming' };
      const mockRoles = [{ id: 'role-1' }, { id: 'role-2' }];

      mockWorkHistoryRepository.findOne.mockResolvedValue(mockWorkHistory);
      mockEventRepository.create.mockReturnValue(mockEvent);
      mockEventRepository.save.mockResolvedValue(mockEvent);
      mockRolesService.findAll.mockResolvedValue(mockRoles);
      mockAttachmentEventService.findByEventId.mockResolvedValue([]);

      const result = await service.create(createEventDto, 'user-id');
      
      expect(result).toBeDefined();
      expect(mockWorkHistoryRepository.findOne).toHaveBeenCalled();
      expect(mockEventRepository.create).toHaveBeenCalled();
      expect(mockEventRepository.save).toHaveBeenCalled();
      expect(mockRolesService.findAll).toHaveBeenCalled();
      expect(mockAnnouncementsService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'event',
          roleIds: ['role-1', 'role-2'],
        }),
        'user-id'
      );
    });
  });

  describe('findAll', () => {
    it('should return all events', async () => {
      const mockEvents = [{ id: '1', title: 'Event 1' }, { id: '2', title: 'Event 2' }];
      const mockQueryBuilder = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(mockEvents),
      };

      mockEventRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const result = await service.findAll();
      
      expect(result).toBeDefined();
      expect(mockEventRepository.createQueryBuilder).toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('should return a single event', async () => {
      const mockEvent = { id: 'event-id', title: 'Test Event' };
      mockEventRepository.findOne.mockResolvedValue(mockEvent);

      const result = await service.findOne('event-id');
      
      expect(result).toBeDefined();
      expect(mockEventRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'event-id' },
        relations: ['createdBy', 'createdBy.user'],
      });
    });
  });

  describe('update', () => {
    it('should update an event successfully', async () => {
      const updateEventDto = { title: 'Updated Event' };
      const mockEvent = { 
        id: 'event-id', 
        title: 'Test Event',
        createdBy: { user: { id: 'user-id' } }
      };
      const updatedEvent = { ...mockEvent, title: 'Updated Event' };

      mockEventRepository.findOne
        .mockResolvedValueOnce(mockEvent) // First call for finding event
        .mockResolvedValueOnce(updatedEvent); // Second call for finding updated event
      mockEventRepository.update.mockResolvedValue(undefined);

      const result = await service.update('event-id', updateEventDto, 'user-id');
      
      expect(result).toBeDefined();
      expect(mockEventRepository.update).toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('should remove an event successfully', async () => {
      const mockEvent = { 
        id: 'event-id', 
        title: 'Test Event',
        createdBy: { user: { id: 'user-id' } }
      };

      mockEventRepository.findOne.mockResolvedValue(mockEvent);
      mockEventRepository.softDelete.mockResolvedValue(undefined);

      await service.remove('event-id', 'user-id');
      
      expect(mockEventRepository.softDelete).toHaveBeenCalledWith('event-id');
    });
  });
});
