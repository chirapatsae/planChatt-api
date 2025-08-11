import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ProjectTypesService } from './project-types.service';
import { ProjectType } from './entities/project-type.entity';
import { CreateProjectTypeDto } from './dto/create-project-type.dto';
import { UpdateProjectTypeDto } from './dto/update-project-type.dto';
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import * as handleExceptionModule from 'src/util/handleException';

const FIXED_DATE = new Date('2025-01-01T00:00:00.000Z');
const mockProjectType = (overrides: Partial<ProjectType> = {}): ProjectType => ({
  id: 'PT001',
  name: 'Project Type Test',
  ...overrides,
});

const mockProjectTypeRepository = () => ({
  create: jest.fn(),
  save: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  remove: jest.fn(),
});

describe('ProjectTypesService', () => {
  let service: ProjectTypesService;
  let projectTypeRepository: ReturnType<typeof mockProjectTypeRepository>;
  let handleExceptionSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    projectTypeRepository = mockProjectTypeRepository();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectTypesService,
        {
          provide: getRepositoryToken(ProjectType),
          useValue: projectTypeRepository,
        },
      ],
    }).compile();
    service = module.get<ProjectTypesService>(ProjectTypesService);
  });

  afterEach(() => {
    if (handleExceptionSpy) handleExceptionSpy.mockRestore();
  });

  describe('create', () => {
    const dto: CreateProjectTypeDto = { name: 'Project Type Test' };
    
    it('should create and return a project type (success)', async () => {
      projectTypeRepository.create.mockReturnValue(mockProjectType());
      projectTypeRepository.save.mockResolvedValue(mockProjectType());
      
      const result = await service.create(dto);
      
      expect(projectTypeRepository.create).toHaveBeenCalledWith(dto);
      expect(projectTypeRepository.save).toHaveBeenCalled();
      expect(result).toEqual(mockProjectType());
    });

    it('should throw ConflictException (DB unique violation)', async () => {
      projectTypeRepository.create.mockReturnValue(mockProjectType());
      projectTypeRepository.save.mockRejectedValue({ code: '23505' });
      
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new ConflictException();
        });
      
      await expect(service.create(dto)).rejects.toBeInstanceOf(ConflictException);
    });

    it('should throw BadRequestException (invalid input)', async () => {
      projectTypeRepository.create.mockImplementation(() => {
        throw new BadRequestException();
      });
      
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new BadRequestException();
        });
      
      await expect(service.create({ name: '' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should throw InternalServerErrorException (other DB error)', async () => {
      projectTypeRepository.create.mockReturnValue(mockProjectType());
      projectTypeRepository.save.mockRejectedValue(new Error('DB error'));
      
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new InternalServerErrorException();
        });
      
      await expect(service.create(dto)).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('should handle edge case: empty name', async () => {
      projectTypeRepository.create.mockImplementation(() => {
        throw new BadRequestException();
      });
      
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new BadRequestException();
        });
      
      await expect(service.create({ name: '' })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('findAll', () => {
    it('should return all project types (success)', async () => {
      projectTypeRepository.find.mockResolvedValue([
        mockProjectType(),
        mockProjectType({ id: 'PT002', name: 'Project Type Test 2' }),
      ]);
      
      const result = await service.findAll();
      
      expect(projectTypeRepository.find).toHaveBeenCalled();
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(mockProjectType());
      expect(result[1]).toEqual(mockProjectType({ id: 'PT002', name: 'Project Type Test 2' }));
    });

    it('should throw InternalServerErrorException', async () => {
      projectTypeRepository.find.mockRejectedValue(new Error('DB error'));
      
      await expect(service.findAll()).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('should return empty array when no project types exist', async () => {
      projectTypeRepository.find.mockResolvedValue([]);
      
      const result = await service.findAll();
      
      expect(result).toEqual([]);
      expect(result).toHaveLength(0);
    });
  });

  describe('findOne', () => {
    it('should return a project type by id (success)', async () => {
      projectTypeRepository.findOne.mockResolvedValue(mockProjectType());
      
      const result = await service.findOne('PT001');
      
      expect(projectTypeRepository.findOne).toHaveBeenCalledWith({ where: { id: 'PT001' } });
      expect(result).toEqual(mockProjectType());
    });

    it('should throw NotFoundException if project type not found', async () => {
      projectTypeRepository.findOne.mockResolvedValue(undefined);
      
      await expect(service.findOne('not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should throw InternalServerErrorException', async () => {
      projectTypeRepository.findOne.mockRejectedValue(new Error('DB error'));
      
      await expect(service.findOne('PT001')).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('should handle edge case: empty id', async () => {
      projectTypeRepository.findOne.mockResolvedValue(undefined);
      
      await expect(service.findOne('')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should handle edge case: null id', async () => {
      projectTypeRepository.findOne.mockResolvedValue(undefined);
      
      await expect(service.findOne(null as any)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update', () => {
    const updateDto: UpdateProjectTypeDto = { name: 'Updated Project Type' };
    
    it('should update and return the project type (success)', async () => {
      const existingProjectType = mockProjectType();
      const updatedProjectType = mockProjectType({ name: 'Updated Project Type' });
      
      projectTypeRepository.findOne.mockResolvedValue(existingProjectType);
      projectTypeRepository.save.mockResolvedValue(updatedProjectType);
      
      const result = await service.update('PT001', updateDto);
      
      expect(projectTypeRepository.findOne).toHaveBeenCalledWith({ where: { id: 'PT001' } });
      expect(projectTypeRepository.save).toHaveBeenCalledWith(updatedProjectType);
      expect(result.name).toBe('Updated Project Type');
    });

    it('should throw NotFoundException if project type not found', async () => {
      projectTypeRepository.findOne.mockResolvedValue(undefined);
      
      await expect(service.update('not-exist', updateDto)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should throw InternalServerErrorException', async () => {
      projectTypeRepository.findOne.mockResolvedValue(mockProjectType());
      projectTypeRepository.save.mockRejectedValue(new Error('DB error'));
      
      await expect(service.update('PT001', updateDto)).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('should handle edge case: empty id', async () => {
      projectTypeRepository.findOne.mockResolvedValue(undefined);
      
      await expect(service.update('', updateDto)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should handle partial update', async () => {
      const existingProjectType = mockProjectType();
      const updatedProjectType = mockProjectType({ name: 'Updated Project Type' });
      
      projectTypeRepository.findOne.mockResolvedValue(existingProjectType);
      projectTypeRepository.save.mockResolvedValue(updatedProjectType);
      
      const result = await service.update('PT001', { name: 'Updated Project Type' });
      
      expect(result.name).toBe('Updated Project Type');
    });
  });

  describe('remove', () => {
    it('should remove a project type (success)', async () => {
      const projectTypeToRemove = mockProjectType();
      projectTypeRepository.findOne.mockResolvedValue(projectTypeToRemove);
      projectTypeRepository.remove.mockResolvedValue(projectTypeToRemove);
      
      await service.remove('PT001');
      
      expect(projectTypeRepository.findOne).toHaveBeenCalledWith({ where: { id: 'PT001' } });
      expect(projectTypeRepository.remove).toHaveBeenCalledWith(projectTypeToRemove);
    });

    it('should throw NotFoundException if project type not found', async () => {
      projectTypeRepository.findOne.mockResolvedValue(undefined);
      
      await expect(service.remove('not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should throw InternalServerErrorException', async () => {
      projectTypeRepository.findOne.mockResolvedValue(mockProjectType());
      projectTypeRepository.remove.mockRejectedValue(new Error('DB error'));
      
      await expect(service.remove('PT001')).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('should handle edge case: empty id', async () => {
      projectTypeRepository.findOne.mockResolvedValue(undefined);
      
      await expect(service.remove('')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should handle edge case: null id', async () => {
      projectTypeRepository.findOne.mockResolvedValue(undefined);
      
      await expect(service.remove(null as any)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('error handling', () => {
    it('should handle database connection errors', async () => {
      projectTypeRepository.find.mockRejectedValue(new Error('Connection lost'));
      
      await expect(service.findAll()).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('should handle validation errors', async () => {
      projectTypeRepository.create.mockImplementation(() => {
        throw new Error('Validation failed');
      });
      
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new BadRequestException();
        });
      
      await expect(service.create({ name: 'invalid' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should handle timeout errors', async () => {
      projectTypeRepository.save.mockRejectedValue(new Error('Query timeout'));
      
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new InternalServerErrorException();
        });
      
      await expect(service.create({ name: 'test' })).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('edge cases', () => {
    it('should handle very long project type names', async () => {
      const longName = 'A'.repeat(1000);
      projectTypeRepository.create.mockReturnValue(mockProjectType({ name: longName }));
      projectTypeRepository.save.mockResolvedValue(mockProjectType({ name: longName }));
      
      const result = await service.create({ name: longName });
      
      expect(result.name).toBe(longName);
    });

    it('should handle special characters in names', async () => {
      const specialName = 'Project Type @#$%^&*()_+-=[]{}|;:,.<>?';
      projectTypeRepository.create.mockReturnValue(mockProjectType({ name: specialName }));
      projectTypeRepository.save.mockResolvedValue(mockProjectType({ name: specialName }));
      
      const result = await service.create({ name: specialName });
      
      expect(result.name).toBe(specialName);
    });

    it('should handle unicode characters in names', async () => {
      const unicodeName = 'โครงการทดสอบ タイプ プロジェクト';
      projectTypeRepository.create.mockReturnValue(mockProjectType({ name: unicodeName }));
      projectTypeRepository.save.mockResolvedValue(mockProjectType({ name: unicodeName }));
      
      const result = await service.create({ name: unicodeName });
      
      expect(result.name).toBe(unicodeName);
    });
  });
});
