import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ProjectTypesController } from './project-types.controller';
import { ProjectTypesService } from './project-types.service';
import { ProjectType } from './entities/project-type.entity';
import { Logger, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { CreateProjectTypeDto } from './dto/create-project-type.dto';
import { UpdateProjectTypeDto } from './dto/update-project-type.dto';

const mockProjectTypeRepository = () => ({
  create: jest.fn(),
  save: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  remove: jest.fn(),
});

const mockProjectType = (overrides: Partial<ProjectType> = {}): ProjectType => ({
  id: 'PT001',
  name: 'Project Type Test',
  ...overrides,
});

describe('ProjectTypesController', () => {
  let controller: ProjectTypesController;
  let service: ProjectTypesService;
  let projectTypeRepository: ReturnType<typeof mockProjectTypeRepository>;

  beforeEach(async () => {
    projectTypeRepository = mockProjectTypeRepository();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProjectTypesController],
      providers: [
        ProjectTypesService,
        {
          provide: getRepositoryToken(ProjectType),
          useValue: projectTypeRepository,
        },
        {
          provide: Logger,
          useValue: {
            error: jest.fn(),
            warn: jest.fn(),
            log: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<ProjectTypesController>(ProjectTypesController);
    service = module.get<ProjectTypesService>(ProjectTypesService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('create', () => {
    const createDto: CreateProjectTypeDto = { name: 'New Project Type' };

    it('should create a project type successfully', async () => {
      const expectedResult = mockProjectType({ name: 'New Project Type' });
      jest.spyOn(service, 'create').mockResolvedValue(expectedResult);

      const result = await controller.create(createDto);

      expect(service.create).toHaveBeenCalledWith(createDto);
      expect(result).toEqual(expectedResult);
    });

    it('should handle service errors', async () => {
      jest.spyOn(service, 'create').mockRejectedValue(new InternalServerErrorException());

      await expect(controller.create(createDto)).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('findAll', () => {
    it('should return all project types', async () => {
      const expectedResult = [
        mockProjectType(),
        mockProjectType({ id: 'PT002', name: 'Project Type 2' }),
      ];
      jest.spyOn(service, 'findAll').mockResolvedValue(expectedResult);

      const result = await controller.findAll();

      expect(service.findAll).toHaveBeenCalled();
      expect(result).toEqual(expectedResult);
      expect(result).toHaveLength(2);
    });

    it('should return empty array when no project types exist', async () => {
      jest.spyOn(service, 'findAll').mockResolvedValue([]);

      const result = await controller.findAll();

      expect(result).toEqual([]);
      expect(result).toHaveLength(0);
    });

    it('should handle service errors', async () => {
      jest.spyOn(service, 'findAll').mockRejectedValue(new InternalServerErrorException());

      await expect(controller.findAll()).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('findOne', () => {
    it('should return a project type by id', async () => {
      const expectedResult = mockProjectType();
      jest.spyOn(service, 'findOne').mockResolvedValue(expectedResult);

      const result = await controller.findOne('PT001');

      expect(service.findOne).toHaveBeenCalledWith('PT001');
      expect(result).toEqual(expectedResult);
    });

    it('should handle not found error', async () => {
      jest.spyOn(service, 'findOne').mockRejectedValue(new NotFoundException());

      await expect(controller.findOne('not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should handle service errors', async () => {
      jest.spyOn(service, 'findOne').mockRejectedValue(new InternalServerErrorException());

      await expect(controller.findOne('PT001')).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('update', () => {
    const updateDto: UpdateProjectTypeDto = { name: 'Updated Project Type' };

    it('should update a project type successfully', async () => {
      const expectedResult = mockProjectType({ name: 'Updated Project Type' });
      jest.spyOn(service, 'update').mockResolvedValue(expectedResult);

      const result = await controller.update('PT001', updateDto);

      expect(service.update).toHaveBeenCalledWith('PT001', updateDto);
      expect(result).toEqual(expectedResult);
      expect(result.name).toBe('Updated Project Type');
    });

    it('should handle not found error', async () => {
      jest.spyOn(service, 'update').mockRejectedValue(new NotFoundException());

      await expect(controller.update('not-exist', updateDto)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should handle service errors', async () => {
      jest.spyOn(service, 'update').mockRejectedValue(new InternalServerErrorException());

      await expect(controller.update('PT001', updateDto)).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('remove', () => {
    it('should remove a project type successfully', async () => {
      jest.spyOn(service, 'remove').mockResolvedValue(undefined);

      await controller.remove('PT001');

      expect(service.remove).toHaveBeenCalledWith('PT001');
    });

    it('should handle not found error', async () => {
      jest.spyOn(service, 'remove').mockRejectedValue(new NotFoundException());

      await expect(controller.remove('not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should handle service errors', async () => {
      jest.spyOn(service, 'remove').mockRejectedValue(new InternalServerErrorException());

      await expect(controller.remove('PT001')).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('edge cases', () => {
    it('should handle empty string id', async () => {
      jest.spyOn(service, 'findOne').mockRejectedValue(new NotFoundException());

      await expect(controller.findOne('')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should handle null id', async () => {
      jest.spyOn(service, 'findOne').mockRejectedValue(new NotFoundException());

      await expect(controller.findOne(null as any)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should handle empty update dto', async () => {
      const emptyDto = {};
      const expectedResult = mockProjectType();
      jest.spyOn(service, 'update').mockResolvedValue(expectedResult);

      const result = await controller.update('PT001', emptyDto);

      expect(service.update).toHaveBeenCalledWith('PT001', emptyDto);
      expect(result).toEqual(expectedResult);
    });
  });
});
