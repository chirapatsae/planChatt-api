import { Test, TestingModule } from '@nestjs/testing';
import { WorkHistoryService } from './work-history.service';
import { WebsocketService } from '../websocket/websocket/websocket.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WorkHistory } from './entities/work-history.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';
import { User } from 'src/users/entities/user.entity';
import { WorkStatus } from 'src/work-status/entities/work-status.entity';
import { Role } from 'src/roles/entities/role.entity';
import { GovernmentAgency } from 'src/government-agencies/entities/government-agency.entity';
import { Position } from 'src/positions/entities/position.entity';
import { AnnouncementsService } from 'src/announcements/announcements.service';

describe('WorkHistoryService', () => {
  let service: WorkHistoryService;
  let websocketService: WebsocketService;
  let announcementsService: AnnouncementsService;

  const mockRepository = {
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    find: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
    delete: jest.fn(),
    softDelete: jest.fn(),
    restore: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkHistoryService,
        {
          provide: getRepositoryToken(WorkHistory),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(Amphoe),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(LocalAdministrativeOrganization),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(User),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(WorkStatus),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(Role),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(GovernmentAgency),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(Position),
          useValue: mockRepository,
        },
        {
          provide: WebsocketService,
          useValue: {
            notifyWorkStatusUpdate: jest.fn(),
          },
        },
        {
          provide: AnnouncementsService,
          useValue: {
            create: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<WorkHistoryService>(WorkHistoryService);
    websocketService = module.get<WebsocketService>(WebsocketService);
    announcementsService = module.get<AnnouncementsService>(AnnouncementsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('should create work history and send notification with type USER if pending', async () => {
      const dto = {
        amphoeId: '3001',
        localAdministrativeOrganizationId: '3001027',
        userId: 'user-id',
        workStatusId: 'pending-id',
        roleId: 'user-id',
      };
      
      const mockUser = { id: 'user-id', firstname: 'Test', lastname: 'User' };
      const mockCreator = { id: 'creator-id' };
      const mockAmphoe = { id: '3001' };
      const mockLao = { id: '3001027', name: 'Test LAO' };
      const mockWorkStatus = { id: 'pending-id', name: 'pending' };
      const mockRole = { id: 'user-id', name: 'user' };
      const mockAdminRoles = [{ id: 'admin-role-id' }];

      jest.spyOn(mockRepository, 'findOne').mockResolvedValue(mockCreator);
      jest.spyOn(mockRepository, 'findOneBy')
        .mockResolvedValueOnce(mockAmphoe)
        .mockResolvedValueOnce(mockLao)
        .mockResolvedValueOnce(mockUser)
        .mockResolvedValueOnce(mockWorkStatus)
        .mockResolvedValueOnce(mockRole);
      
      jest.spyOn(mockRepository, 'find').mockResolvedValue(mockAdminRoles);
      jest.spyOn(mockRepository, 'save').mockResolvedValue({ id: 'wh-id' });

      await service.create(dto, 'creator-id');

      expect(announcementsService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'user',
        }),
        'creator-id'
      );
    });
  });
});
