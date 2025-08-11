import { Test, TestingModule } from '@nestjs/testing';
import { AmphoesController } from './amphoes.controller';
import { AmphoesService } from './amphoes.service';
import { CreateAmphoeDto } from './dto/create-amphoe.dto';
import { UpdateAmphoeDto } from './dto/update-amphoe.dto';
import { Amphoe } from './entities/amphoe.entity';
import { ConflictException, NotFoundException } from '@nestjs/common';

describe('AmphoesController', () => {
  let controller: AmphoesController;
  let service: AmphoesService;

  const mockAmphoe: Amphoe = {
    id: 'A001',
    name: 'Amphoe Test',
    createAt: new Date('2025-01-01T00:00:00.000Z'),
    deletedAt: undefined,
    workHistory: [],
    localAdministrativeOrganization: [],
    workHistoryResponsibleAdmins: [],
  };

  const mockAmphoesService = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    softRemove: jest.fn(),
    restore: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AmphoesController],
      providers: [
        {
          provide: AmphoesService,
          useValue: mockAmphoesService,
        },
      ],
    }).compile();

    controller = module.get<AmphoesController>(AmphoesController);
    service = module.get<AmphoesService>(AmphoesService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('create', () => {
    const createDto: CreateAmphoeDto = {
      code: 'A001',
      name: 'Amphoe Test',
    };

    it('should create an amphoe successfully', async () => {
      mockAmphoesService.create.mockResolvedValue(mockAmphoe);

      const result = await controller.create(createDto);

      expect(service.create).toHaveBeenCalledWith(createDto);
      expect(result).toEqual(mockAmphoe);
    });

    it('should handle service errors', async () => {
      const error = new ConflictException('Amphoe already exists');
      mockAmphoesService.create.mockRejectedValue(error);

      await expect(controller.create(createDto)).rejects.toThrow(ConflictException);
      expect(service.create).toHaveBeenCalledWith(createDto);
    });

    it('should handle empty DTO', async () => {
      const emptyDto = {} as CreateAmphoeDto;
      mockAmphoesService.create.mockResolvedValue(mockAmphoe);

      const result = await controller.create(emptyDto);

      expect(service.create).toHaveBeenCalledWith(emptyDto);
      expect(result).toEqual(mockAmphoe);
    });
  });

  describe('findAll', () => {
    it('should return all amphoes successfully', async () => {
      const mockAmphoes = [mockAmphoe, { ...mockAmphoe, id: 'A002', name: 'Amphoe Test 2' }];
      mockAmphoesService.findAll.mockResolvedValue(mockAmphoes);

      const result = await controller.findAll();

      expect(service.findAll).toHaveBeenCalled();
      expect(result).toEqual(mockAmphoes);
    });

    it('should return empty array when no amphoes exist', async () => {
      mockAmphoesService.findAll.mockResolvedValue([]);

      const result = await controller.findAll();

      expect(service.findAll).toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it('should handle service errors', async () => {
      const error = new Error('Database connection failed');
      mockAmphoesService.findAll.mockRejectedValue(error);

      await expect(controller.findAll()).rejects.toThrow(Error);
      expect(service.findAll).toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    const amphoeId = 'A001';

    it('should return an amphoe by id successfully', async () => {
      mockAmphoesService.findOne.mockResolvedValue(mockAmphoe);

      const result = await controller.findOne(amphoeId);

      expect(service.findOne).toHaveBeenCalledWith(amphoeId);
      expect(result).toEqual(mockAmphoe);
    });

    it('should handle amphoe not found', async () => {
      const error = new NotFoundException(`Amphoe with ID ${amphoeId} not found`);
      mockAmphoesService.findOne.mockRejectedValue(error);

      await expect(controller.findOne(amphoeId)).rejects.toThrow(NotFoundException);
      expect(service.findOne).toHaveBeenCalledWith(amphoeId);
    });

    it('should handle empty id parameter', async () => {
      const emptyId = '';
      const error = new NotFoundException(`Amphoe with ID ${emptyId} not found`);
      mockAmphoesService.findOne.mockRejectedValue(error);

      await expect(controller.findOne(emptyId)).rejects.toThrow(NotFoundException);
      expect(service.findOne).toHaveBeenCalledWith(emptyId);
    });

    it('should handle service errors', async () => {
      const error = new Error('Database error');
      mockAmphoesService.findOne.mockRejectedValue(error);

      await expect(controller.findOne(amphoeId)).rejects.toThrow(Error);
      expect(service.findOne).toHaveBeenCalledWith(amphoeId);
    });
  });

  describe('update', () => {
    const amphoeId = 'A001';
    const updateDto: UpdateAmphoeDto = {
      name: 'Updated Amphoe Name',
    };

    it('should update an amphoe successfully', async () => {
      const updatedAmphoe = { ...mockAmphoe, name: updateDto.name };
      mockAmphoesService.update.mockResolvedValue(updatedAmphoe);

      const result = await controller.update(amphoeId, updateDto);

      expect(service.update).toHaveBeenCalledWith(amphoeId, updateDto);
      expect(result).toEqual(updatedAmphoe);
    });

    it('should handle partial updates', async () => {
      const partialUpdateDto = { name: 'Partial Update' };
      const updatedAmphoe = { ...mockAmphoe, name: partialUpdateDto.name };
      mockAmphoesService.update.mockResolvedValue(updatedAmphoe);

      const result = await controller.update(amphoeId, partialUpdateDto);

      expect(service.update).toHaveBeenCalledWith(amphoeId, partialUpdateDto);
      expect(result).toEqual(updatedAmphoe);
    });

    it('should handle amphoe not found during update', async () => {
      const error = new NotFoundException(`Amphoe with ID ${amphoeId} not found`);
      mockAmphoesService.update.mockRejectedValue(error);

      await expect(controller.update(amphoeId, updateDto)).rejects.toThrow(NotFoundException);
      expect(service.update).toHaveBeenCalledWith(amphoeId, updateDto);
    });

    it('should handle empty id parameter', async () => {
      const emptyId = '';
      const error = new NotFoundException(`Amphoe with ID ${emptyId} not found`);
      mockAmphoesService.update.mockRejectedValue(error);

      await expect(controller.update(emptyId, updateDto)).rejects.toThrow(NotFoundException);
      expect(service.update).toHaveBeenCalledWith(emptyId, updateDto);
    });

    it('should handle service errors', async () => {
      const error = new Error('Database error');
      mockAmphoesService.update.mockRejectedValue(error);

      await expect(controller.update(amphoeId, updateDto)).rejects.toThrow(Error);
      expect(service.update).toHaveBeenCalledWith(amphoeId, updateDto);
    });
  });

  describe('remove', () => {
    const amphoeId = 'A001';

    describe('soft delete (default)', () => {
      it('should soft remove an amphoe successfully', async () => {
        const softDeleteResult = { message: `Amphoe with ID ${amphoeId} has been soft-removed.` };
        mockAmphoesService.softRemove.mockResolvedValue(softDeleteResult);

        const result = await controller.remove(amphoeId);

        expect(service.softRemove).toHaveBeenCalledWith(amphoeId);
        expect(result).toEqual(softDeleteResult);
      });

      it('should handle soft remove with explicit soft mode', async () => {
        const softDeleteResult = { message: `Amphoe with ID ${amphoeId} has been soft-removed.` };
        mockAmphoesService.softRemove.mockResolvedValue(softDeleteResult);

        const result = await controller.remove(amphoeId, 'soft');

        expect(service.softRemove).toHaveBeenCalledWith(amphoeId);
        expect(result).toEqual(softDeleteResult);
      });

      it('should handle soft remove errors', async () => {
        const error = new NotFoundException(`Amphoe with ID ${amphoeId} not found`);
        mockAmphoesService.softRemove.mockRejectedValue(error);

        await expect(controller.remove(amphoeId, 'soft')).rejects.toThrow(NotFoundException);
        expect(service.softRemove).toHaveBeenCalledWith(amphoeId);
      });
    });

    describe('hard delete', () => {
      it('should hard remove an amphoe successfully', async () => {
        const hardDeleteResult = { message: `Amphoe with ID ${amphoeId} has been permanently removed.` };
        mockAmphoesService.remove.mockResolvedValue(hardDeleteResult);

        const result = await controller.remove(amphoeId, 'hard');

        expect(service.remove).toHaveBeenCalledWith(amphoeId);
        expect(result).toEqual(hardDeleteResult);
      });

      it('should handle hard remove errors', async () => {
        const error = new NotFoundException(`Amphoe with ID ${amphoeId} not found`);
        mockAmphoesService.remove.mockRejectedValue(error);

        await expect(controller.remove(amphoeId, 'hard')).rejects.toThrow(NotFoundException);
        expect(service.remove).toHaveBeenCalledWith(amphoeId);
      });
    });

    it('should handle empty id parameter', async () => {
      const emptyId = '';
      const error = new NotFoundException(`Amphoe with ID ${emptyId} not found`);
      mockAmphoesService.softRemove.mockRejectedValue(error);

      await expect(controller.remove(emptyId)).rejects.toThrow(NotFoundException);
      expect(service.softRemove).toHaveBeenCalledWith(emptyId);
    });

    it('should handle service errors', async () => {
      const error = new Error('Database error');
      mockAmphoesService.softRemove.mockRejectedValue(error);

      await expect(controller.remove(amphoeId)).rejects.toThrow(Error);
      expect(service.softRemove).toHaveBeenCalledWith(amphoeId);
    });
  });

  describe('restore', () => {
    const amphoeId = 'A001';

    it('should restore an amphoe successfully', async () => {
      const restoreResult = { message: `Amphoe with ID ${amphoeId} has been restored.` };
      mockAmphoesService.restore.mockResolvedValue(restoreResult);

      const result = await controller.restore(amphoeId);

      expect(service.restore).toHaveBeenCalledWith(amphoeId);
      expect(result).toEqual(restoreResult);
    });

    it('should handle amphoe not found during restore', async () => {
      const error = new NotFoundException(`Amphoe with ID ${amphoeId} not found or was not deleted.`);
      mockAmphoesService.restore.mockRejectedValue(error);

      await expect(controller.restore(amphoeId)).rejects.toThrow(NotFoundException);
      expect(service.restore).toHaveBeenCalledWith(amphoeId);
    });

    it('should handle empty id parameter', async () => {
      const emptyId = '';
      const error = new NotFoundException(`Amphoe with ID ${emptyId} not found or was not deleted.`);
      mockAmphoesService.restore.mockRejectedValue(error);

      await expect(controller.restore(emptyId)).rejects.toThrow(NotFoundException);
      expect(service.restore).toHaveBeenCalledWith(emptyId);
    });

    it('should handle service errors', async () => {
      const error = new Error('Database error');
      mockAmphoesService.restore.mockRejectedValue(error);

      await expect(controller.restore(amphoeId)).rejects.toThrow(Error);
      expect(service.restore).toHaveBeenCalledWith(amphoeId);
    });
  });

  describe('edge cases and error handling', () => {
    it('should handle null parameters gracefully', async () => {
      const nullId = null as any;
      const error = new NotFoundException(`Amphoe with ID ${nullId} not found`);
      mockAmphoesService.findOne.mockRejectedValue(error);

      await expect(controller.findOne(nullId)).rejects.toThrow(NotFoundException);
      expect(service.findOne).toHaveBeenCalledWith(nullId);
    });

    it('should handle undefined parameters gracefully', async () => {
      const undefinedId = undefined as any;
      const error = new NotFoundException(`Amphoe with ID ${undefinedId} not found`);
      mockAmphoesService.findOne.mockRejectedValue(error);

      await expect(controller.findOne(undefinedId)).rejects.toThrow(NotFoundException);
      expect(service.findOne).toHaveBeenCalledWith(undefinedId);
    });

    it('should handle malformed DTOs', async () => {
      const malformedDto = { invalidField: 'value' } as any;
      mockAmphoesService.create.mockResolvedValue(mockAmphoe);

      const result = await controller.create(malformedDto);

      expect(service.create).toHaveBeenCalledWith(malformedDto);
      expect(result).toEqual(mockAmphoe);
    });
  });
});
