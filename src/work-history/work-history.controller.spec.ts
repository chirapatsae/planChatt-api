import { Test, TestingModule } from '@nestjs/testing';
import { WorkHistoryController } from './work-history.controller';
import { WorkHistoryService } from './work-history.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WorkHistory } from './entities/work-history.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';
import { User } from 'src/users/entities/user.entity';
import { WorkStatus } from 'src/work-status/entities/work-status.entity';
import { Role } from 'src/roles/entities/role.entity';
import { GovernmentAgency } from 'src/government-agencies/entities/government-agency.entity';
import { Position } from 'src/positions/entities/position.entity';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { CreateWorkHistoryDto } from './dto/create-work-history.dto';
import { UpdateWorkHistoryDto } from './dto/update-work-history.dto';

describe('WorkHistoryController', () => {
  let controller: WorkHistoryController;
  let service: WorkHistoryService;

  const mockWorkHistoryService = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    softRemove: jest.fn(),
    restore: jest.fn(),
  };

  const mockUser = {
    userId: 'test-user-id',
  };

  const mockRequest = {
    user: mockUser,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WorkHistoryController],
      providers: [
        {
          provide: WorkHistoryService,
          useValue: mockWorkHistoryService,
        },
        { provide: getRepositoryToken(WorkHistory), useValue: {} },
        { provide: getRepositoryToken(Amphoe), useValue: {} },
        {
          provide: getRepositoryToken(LocalAdministrativeOrganization),
          useValue: {},
        },
        { provide: getRepositoryToken(User), useValue: {} },
        { provide: getRepositoryToken(WorkStatus), useValue: {} },
        { provide: getRepositoryToken(Role), useValue: {} },
        { provide: getRepositoryToken(GovernmentAgency), useValue: {} },
        { provide: getRepositoryToken(Position), useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<WorkHistoryController>(WorkHistoryController);
    service = module.get<WorkHistoryService>(WorkHistoryService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('findAll', () => {
    it('should return all work histories without filters', async () => {
      const expectedResult = [
        { id: '1', userId: 'user-1' },
        { id: '2', userId: 'user-2' },
      ];
      mockWorkHistoryService.findAll.mockResolvedValue(expectedResult);

      const result = await controller.findAll('', '');

      expect(service.findAll).toHaveBeenCalledWith('', '');
      expect(result).toEqual(expectedResult);
    });

    it('should return work histories filtered by status', async () => {
      const status = 'approved';
      const expectedResult = [{ id: '1', userId: 'user-1' }];
      mockWorkHistoryService.findAll.mockResolvedValue(expectedResult);

      const result = await controller.findAll(status, '');

      expect(service.findAll).toHaveBeenCalledWith(status, '');
      expect(result).toEqual(expectedResult);
    });

    it('should return work histories filtered by status and role', async () => {
      const status = 'approved';
      const role = 'admin';
      const expectedResult = [{ id: '1', userId: 'user-1' }];
      mockWorkHistoryService.findAll.mockResolvedValue(expectedResult);

      const result = await controller.findAll(status, role);

      expect(service.findAll).toHaveBeenCalledWith(status, role);
      expect(result).toEqual(expectedResult);
    });
  });

  describe('findOne', () => {
    it('should return a work history by id', async () => {
      const id = 'test-id';
      const expectedResult = { id, userId: 'test-user' };
      mockWorkHistoryService.findOne.mockResolvedValue(expectedResult);

      const result = await controller.findOne(id);

      expect(service.findOne).toHaveBeenCalledWith(id);
      expect(result).toEqual(expectedResult);
    });
  });

  describe('create', () => {
    it('should create a work history', async () => {
      const createDto: CreateWorkHistoryDto = {
        amphoeId: 'amphoe-1',
        localAdministrativeOrganizationId: 'lao-1',
        userId: 'user-1',
        workStatusId: 'status-1',
        roleId: 'role-1',
        governmentAgenciesId: 'gov-1',
      };

      const expectedResult = { id: 'test-id', ...createDto };
      mockWorkHistoryService.create.mockResolvedValue(expectedResult);

      const result = await controller.create(createDto, mockRequest as any);

      expect(service.create).toHaveBeenCalledWith(createDto, mockUser.userId);
      expect(result).toEqual(expectedResult);
    });
  });

  describe('update', () => {
    it('should update a work history', async () => {
      const id = 'test-id';
      const updateDto: UpdateWorkHistoryDto = {
        amphoeId: 'new-amphoe',
        localAdministrativeOrganizationId: 'new-lao',
        userId: 'new-user',
        workStatusId: 'new-status',
        roleId: 'new-role',
      };

      const expectedResult = { id, ...updateDto };
      mockWorkHistoryService.update.mockResolvedValue(expectedResult);

      const result = await controller.update(id, updateDto, mockRequest as any);

      expect(service.update).toHaveBeenCalledWith(id, updateDto, mockUser.userId);
      expect(result).toEqual(expectedResult);
    });
  });

  describe('remove', () => {
    it('should soft remove a work history by default', async () => {
      const id = 'test-id';
      const expectedResult = { message: `Work history with ID ${id} has been soft-removed.` };
      mockWorkHistoryService.softRemove.mockResolvedValue(expectedResult);

      const result = await controller.remove(id);

      expect(service.softRemove).toHaveBeenCalledWith(id);
      expect(result).toEqual(expectedResult);
    });

    it('should hard remove a work history when mode is hard', async () => {
      const id = 'test-id';
      const expectedResult = { message: `Work history with ID ${id} has been permanently deleted` };
      mockWorkHistoryService.remove.mockResolvedValue(expectedResult);

      const result = await controller.remove(id, 'hard');

      expect(service.remove).toHaveBeenCalledWith(id);
      expect(result).toEqual(expectedResult);
    });
  });

  describe('restore', () => {
    it('should restore a work history', async () => {
      const id = 'test-id';
      const expectedResult = { message: `Work history with ID ${id} has been restored.` };
      mockWorkHistoryService.restore.mockResolvedValue(expectedResult);

      const result = await controller.restore(id);

      expect(service.restore).toHaveBeenCalledWith(id);
      expect(result).toEqual(expectedResult);
    });
  });
});
