import { Test, TestingModule } from '@nestjs/testing';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { EventsFileUploadService } from './events-file-upload.service';

describe('EventsController', () => {
  let controller: EventsController;
  let service: EventsService;
  let fileUploadService: EventsFileUploadService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EventsController],
      providers: [
        {
          provide: EventsService,
          useValue: {
            create: jest.fn(),
            findAll: jest.fn(),
            findOne: jest.fn(),
            update: jest.fn(),
            remove: jest.fn(),
          },
        },
        {
          provide: EventsFileUploadService,
          useValue: {
            uploadMultipleFiles: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<EventsController>(EventsController);
    service = module.get<EventsService>(EventsService);
    fileUploadService = module.get<EventsFileUploadService>(EventsFileUploadService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('create', () => {
    it('should create an event', async () => {
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

      const mockUser = { userId: 'test-user-id' };
      const mockEvent = { id: 'test-id', ...createEventDto };

      jest.spyOn(service, 'create').mockResolvedValue(mockEvent as any);

      const result = await controller.create(createEventDto, { user: mockUser } as any);
      expect(result).toEqual(mockEvent);
      expect(service.create).toHaveBeenCalledWith(createEventDto, mockUser.userId);
    });
  });

  describe('findAll', () => {
    it('should return all events with filters', async () => {
      const mockEvents = [{ id: '1', title: 'Event 1' }, { id: '2', title: 'Event 2' }];
      jest.spyOn(service, 'findAll').mockResolvedValue(mockEvents as any);

      const result = await controller.findAll('test', 'upcoming', 'week', 'Bangkok');
      expect(result).toEqual(mockEvents);
      expect(service.findAll).toHaveBeenCalledWith({
        search: 'test',
        status: 'upcoming',
        dateFilter: 'week',
        location: 'Bangkok',
      });
    });
  });

  describe('findOne', () => {
    it('should return a single event', async () => {
      const mockEvent = { id: 'test-id', title: 'Test Event' };
      jest.spyOn(service, 'findOne').mockResolvedValue(mockEvent as any);

      const result = await controller.findOne('test-id');
      expect(result).toEqual(mockEvent);
      expect(service.findOne).toHaveBeenCalledWith('test-id');
    });
  });

  describe('update', () => {
    it('should update an event', async () => {
      const updateEventDto = { title: 'Updated Event' };
      const mockUser = { userId: 'test-user-id' };
      const mockEvent = { id: 'test-id', title: 'Updated Event' };

      jest.spyOn(service, 'update').mockResolvedValue(mockEvent as any);

      const result = await controller.update('test-id', updateEventDto, { user: mockUser } as any);
      expect(result).toEqual(mockEvent);
      expect(service.update).toHaveBeenCalledWith('test-id', updateEventDto, mockUser.userId);
    });
  });

  describe('remove', () => {
    it('should remove an event', async () => {
      const mockUser = { userId: 'test-user-id' };
      jest.spyOn(service, 'remove').mockResolvedValue(undefined);

      await controller.remove('test-id', { user: mockUser } as any);
      expect(service.remove).toHaveBeenCalledWith('test-id', mockUser.userId);
    });
  });

  describe('uploadFiles', () => {
    it('should upload multiple files', async () => {
      const mockFiles = [
        { originalname: 'test1.pdf', mimetype: 'application/pdf', size: 1024, buffer: Buffer.from('test') },
        { originalname: 'test2.jpg', mimetype: 'image/jpeg', size: 2048, buffer: Buffer.from('test') },
      ] as any;

      const mockUser = { userId: 'test-user-id' };
      const mockUploadResult = [
        { filename: 'uuid1.pdf', originalName: 'test1.pdf', mimetype: 'application/pdf', size: 1024, path: 'uploads/events/uuid1.pdf' },
        { filename: 'uuid2.jpg', originalName: 'test2.jpg', mimetype: 'image/jpeg', size: 2048, path: 'uploads/events/uuid2.jpg' },
      ];

      jest.spyOn(fileUploadService, 'uploadMultipleFiles').mockResolvedValue(mockUploadResult);

      const result = await controller.uploadFiles(mockFiles, { user: mockUser } as any);
      expect(result).toEqual(mockUploadResult);
      expect(fileUploadService.uploadMultipleFiles).toHaveBeenCalledWith(mockFiles);
    });
  });
});
