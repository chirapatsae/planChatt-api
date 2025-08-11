import { Test, TestingModule } from '@nestjs/testing';
import { ProjectGroupsController } from './project-groups.controller';
import { ProjectGroupsService } from './project-groups.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ProjectGroup } from './entities/project-group.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { Budget } from 'src/budget/entities/budget.entity';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { CreateProjectGroupDto } from './dto/create-project-group.dto';
import { UpdateProjectGroupDto } from './dto/update-project-group.dto';

describe('ProjectGroupsController', () => {
  let controller: ProjectGroupsController;
  let service: ProjectGroupsService;

  const mockProjectGroupsService = {
    create: jest.fn(),
    createDraft: jest.fn(),
    simplePublish: jest.fn(),
    updateDraft: jest.fn(),
    publishDraft: jest.fn(),
    findProjectsByStatus: jest.fn(),
    findDelete: jest.fn(),
    findOne: jest.fn(),
    handleProjectCleanUp: jest.fn(),
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
      controllers: [ProjectGroupsController],
      providers: [
        {
          provide: ProjectGroupsService,
          useValue: mockProjectGroupsService,
        },
        { provide: getRepositoryToken(ProjectGroup), useValue: {} },
        { provide: getRepositoryToken(WorkHistory), useValue: {} },
        { provide: getRepositoryToken(BudgetPlan), useValue: {} },
        { provide: getRepositoryToken(TrackingStatus), useValue: {} },
        { provide: getRepositoryToken(Strategy), useValue: {} },
        { provide: getRepositoryToken(Tactic), useValue: {} },
        { provide: getRepositoryToken(Plan), useValue: {} },
        { provide: getRepositoryToken(Budget), useValue: {} },
        { provide: DataSource, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<ProjectGroupsController>(ProjectGroupsController);
    service = module.get<ProjectGroupsService>(ProjectGroupsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('create', () => {
    it('should create a project group', async () => {
      const createDto: CreateProjectGroupDto = {
        title: 'Test Project',
        projectYear: 2024,
        budgetPlanId: 'budget-plan-1',
        budget: [
          {
            quantity: 100,
            year: 2024,
          },
        ],
      };

      const expectedResult = { id: 'test-id', ...createDto };
      mockProjectGroupsService.create.mockResolvedValue(expectedResult);

      const result = await controller.create(createDto, mockRequest as any);

      expect(service.create).toHaveBeenCalledWith(createDto, mockUser.userId);
      expect(result).toEqual(expectedResult);
    });
  });

  describe('createDraft', () => {
    it('should create a draft project group', async () => {
      const createDto: CreateProjectGroupDto = {
        title: 'Test Draft',
        projectYear: 2024,
        budgetPlanId: 'budget-plan-1',
        isDraft: true,
      };

      const expectedResult = { id: 'draft-id', ...createDto };
      mockProjectGroupsService.createDraft.mockResolvedValue(expectedResult);

      const result = await controller.createDraft(createDto, mockRequest as any);

      expect(service.createDraft).toHaveBeenCalledWith(createDto, mockUser.userId);
      expect(result).toEqual(expectedResult);
    });
  });

  describe('simplePublishDraft', () => {
    it('should simple publish a draft', async () => {
      const id = 'draft-id';
      const expectedResult = { message: 'Draft published successfully' };
      mockProjectGroupsService.simplePublish.mockResolvedValue(expectedResult);

      const result = await controller.simplePublishDraft(id, mockRequest as any);

      expect(service.simplePublish).toHaveBeenCalledWith(id, mockUser.userId);
      expect(result).toEqual(expectedResult);
    });
  });

  describe('updateDraft', () => {
    it('should update a draft project group', async () => {
      const id = 'draft-id';
      const updateDto: CreateProjectGroupDto = {
        title: 'Updated Draft',
        projectYear: 2024,
        budgetPlanId: 'budget-plan-1',
        isDraft: true,
      };

      const expectedResult = { id, ...updateDto };
      mockProjectGroupsService.updateDraft.mockResolvedValue(expectedResult);

      const result = await controller.updateDraft(id, updateDto, mockRequest as any);

      expect(service.updateDraft).toHaveBeenCalledWith(id, updateDto, mockUser.userId);
      expect(result).toEqual(expectedResult);
    });
  });

  describe('publishDraft', () => {
    it('should publish a draft project group', async () => {
      const id = 'draft-id';
      const publishDto: CreateProjectGroupDto = {
        title: 'Published Project',
        projectYear: 2024,
        budgetPlanId: 'budget-plan-1',
        budget: [
          {
            quantity: 100,
            year: 2024,
          },
        ],
      };

      const expectedResult = { id, ...publishDto };
      mockProjectGroupsService.publishDraft.mockResolvedValue(expectedResult);

      const result = await controller.publishDraft(id, publishDto, mockRequest as any);

      expect(service.publishDraft).toHaveBeenCalledWith(id, publishDto, mockUser.userId);
      expect(result).toEqual(expectedResult);
    });
  });

  describe('findByStatus', () => {
    it('should find projects by status with type', async () => {
      const type = 'draft';
      const expectedResult = [{ id: '1', title: 'Draft Project' }];
      mockProjectGroupsService.findProjectsByStatus.mockResolvedValue(expectedResult);

      const result = await controller.findByStatus(mockRequest as any, type);

      expect(service.findProjectsByStatus).toHaveBeenCalledWith({
        userId: mockUser.userId,
        type,
        countOnly: false,
      });
      expect(result).toEqual(expectedResult);
    });

    it('should find projects by status with countOnly', async () => {
      const type = 'pending';
      const countOnly = 'true';
      const expectedResult = { count: 5 };
      mockProjectGroupsService.findProjectsByStatus.mockResolvedValue(expectedResult);

      const result = await controller.findByStatus(mockRequest as any, type, countOnly);

      expect(service.findProjectsByStatus).toHaveBeenCalledWith({
        userId: mockUser.userId,
        type,
        countOnly: true,
      });
      expect(result).toEqual(expectedResult);
    });
  });

  describe('findDelete', () => {
    it('should find deleted projects', async () => {
      const expectedResult = [{ id: '1', title: 'Deleted Project' }];
      mockProjectGroupsService.findDelete.mockResolvedValue(expectedResult);

      const result = await controller.findDelete(mockRequest as any);

      expect(service.findDelete).toHaveBeenCalledWith(mockUser.userId);
      expect(result).toEqual(expectedResult);
    });
  });

  describe('findOne', () => {
    it('should return a project group by id', async () => {
      const id = 'test-id';
      const expectedResult = { id, title: 'Test Project' };
      mockProjectGroupsService.findOne.mockResolvedValue(expectedResult);

      const result = await controller.findOne(id);

      expect(service.findOne).toHaveBeenCalledWith(id);
      expect(result).toEqual(expectedResult);
    });
  });

  describe('purgeDeletedProjects', () => {
    it('should purge deleted projects', async () => {
      const expectedResult = { message: 'Purge completed' };
      mockProjectGroupsService.handleProjectCleanUp.mockResolvedValue(expectedResult);

      const result = await controller.purgeDeletedProjects();

      expect(service.handleProjectCleanUp).toHaveBeenCalled();
      expect(result).toEqual(expectedResult);
    });
  });

  describe('update', () => {
    it('should update a project group', async () => {
      const id = 'test-id';
      const updateDto: UpdateProjectGroupDto = {
        title: 'Updated Project',
      };

      const expectedResult = { id, ...updateDto };
      mockProjectGroupsService.update.mockResolvedValue(expectedResult);

      const result = await controller.update(id, updateDto, mockRequest as any);

      expect(service.update).toHaveBeenCalledWith(id, updateDto, mockUser.userId);
      expect(result).toEqual(expectedResult);
    });
  });

  describe('remove', () => {
    it('should soft remove a project group by default', async () => {
      const id = 'test-id';
      const expectedResult = { message: `Project group ${id} has been soft-removed.` };
      mockProjectGroupsService.softRemove.mockResolvedValue(expectedResult);

      const result = await controller.remove(id);

      expect(service.softRemove).toHaveBeenCalledWith(id);
      expect(result).toEqual(expectedResult);
    });

    it('should hard remove a project group when mode is hard', async () => {
      const id = 'test-id';
      const expectedResult = { message: `Project group ${id} has been permanently deleted` };
      mockProjectGroupsService.remove.mockResolvedValue(expectedResult);

      const result = await controller.remove(id, 'hard');

      expect(service.remove).toHaveBeenCalledWith(id);
      expect(result).toEqual(expectedResult);
    });
  });

  describe('restore', () => {
    it('should restore a project group', async () => {
      const id = 'test-id';
      const expectedResult = { message: `Project group ${id} has been restored.` };
      mockProjectGroupsService.restore.mockResolvedValue(expectedResult);

      const result = await controller.restore(id);

      expect(service.restore).toHaveBeenCalledWith(id);
      expect(result).toEqual(expectedResult);
    });
  });
});
