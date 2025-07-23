import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LocalAdministrativeOrganizationsService } from './local-administrative-organizations.service';
import { LocalAdministrativeOrganization } from './entities/local-administrative-organization.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { CreateLocalAdministrativeOrganizationDto } from './dto/create-local-administrative-organization.dto';
import { UpdateLocalAdministrativeOrganizationDto } from './dto/update-local-administrative-organization.dto';
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import * as handleExceptionModule from 'src/util/handleException';

const FIXED_DATE = new Date('2025-01-01T00:00:00.000Z');

const mockAmphoe = (overrides: Partial<Amphoe> = {}): Amphoe => ({
  id: 'A001',
  name: 'Amphoe Test',
  createAt: FIXED_DATE,
  deletedAt: undefined,
  workHistory: [],
  localAdministrativeOrganization: [],
  workHistoryResponsibleAdmins: [],
  ...overrides,
});

const mockLAO = (overrides: Partial<LocalAdministrativeOrganization> = {}): LocalAdministrativeOrganization => ({
  id: 'L001',
  name: 'LAO Test',
  type: 'Type1',
  createdAt: FIXED_DATE,
  deleteAt: null,
  amphoe: mockAmphoe(),
  workHistory: [],
  originAgencyProjectGroup: [],
  ...overrides,
});

const mockLaoRepository = () => ({
  create: jest.fn(),
  save: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  findOneBy: jest.fn(),
  preload: jest.fn(),
  delete: jest.fn(),
  softDelete: jest.fn(),
  restore: jest.fn(),
});
const mockAmphoeRepository = () => ({
  findOneBy: jest.fn(),
});

describe('LocalAdministrativeOrganizationsService', () => {
  let service: LocalAdministrativeOrganizationsService;
  let laoRepository: ReturnType<typeof mockLaoRepository>;
  let amphoeRepository: ReturnType<typeof mockAmphoeRepository>;
  let handleExceptionSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    laoRepository = mockLaoRepository();
    amphoeRepository = mockAmphoeRepository();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocalAdministrativeOrganizationsService,
        { provide: getRepositoryToken(LocalAdministrativeOrganization), useValue: laoRepository },
        { provide: getRepositoryToken(Amphoe), useValue: amphoeRepository },
      ],
    }).compile();
    service = module.get<LocalAdministrativeOrganizationsService>(LocalAdministrativeOrganizationsService);
  });

  afterEach(() => {
    if (handleExceptionSpy) handleExceptionSpy.mockRestore();
  });

  describe('create', () => {
    const dto: CreateLocalAdministrativeOrganizationDto = {
      code: 'L001',
      name: 'LAO Test',
      type: 'Type1',
      amphoeId: 'A001',
    };
    it('should create and return a LAO (success)', async () => {
      amphoeRepository.findOneBy.mockResolvedValue(mockAmphoe());
      laoRepository.create.mockReturnValue(mockLAO());
      laoRepository.save.mockResolvedValue(mockLAO());
      const result = await service.create(dto);
      expect(amphoeRepository.findOneBy).toHaveBeenCalledWith({ id: dto.amphoeId });
      expect(laoRepository.create).toHaveBeenCalledWith({ id: dto.code, name: dto.name, type: dto.type, amphoe: mockAmphoe() });
      expect(laoRepository.save).toHaveBeenCalled();
      expect(result).toEqual(mockLAO());
    });
    it('should throw NotFoundException if amphoe not found', async () => {
      amphoeRepository.findOneBy.mockResolvedValue(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.create(dto)).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw ConflictException (DB unique violation)', async () => {
      amphoeRepository.findOneBy.mockResolvedValue(mockAmphoe());
      laoRepository.create.mockReturnValue(mockLAO());
      laoRepository.save.mockRejectedValue({ code: '23505' });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new ConflictException(); });
      await expect(service.create(dto)).rejects.toBeInstanceOf(ConflictException);
    });
    it('should throw BadRequestException (invalid input)', async () => {
      amphoeRepository.findOneBy.mockResolvedValue(mockAmphoe());
      laoRepository.create.mockImplementation(() => { throw new BadRequestException(); });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new BadRequestException(); });
      await expect(service.create({ ...dto, code: '' })).rejects.toBeInstanceOf(BadRequestException);
    });
    it('should throw InternalServerErrorException (other DB error)', async () => {
      amphoeRepository.findOneBy.mockResolvedValue(mockAmphoe());
      laoRepository.create.mockReturnValue(mockLAO());
      laoRepository.save.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.create(dto)).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty code', async () => {
      amphoeRepository.findOneBy.mockResolvedValue(mockAmphoe());
      laoRepository.create.mockImplementation(() => { throw new BadRequestException(); });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new BadRequestException(); });
      await expect(service.create({ ...dto, code: '' })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('findAll', () => {
    it('should return all LAOs (success)', async () => {
      laoRepository.find.mockResolvedValue([mockLAO(), mockLAO({ id: 'L002' })]);
      const result = await service.findAll();
      expect(laoRepository.find).toHaveBeenCalledWith({ relations: ['amphoe'] });
      expect(result).toHaveLength(2);
    });
    it('should throw InternalServerErrorException', async () => {
      laoRepository.find.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.findAll()).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('findOne', () => {
    it('should return a LAO by id (success)', async () => {
      laoRepository.findOne.mockResolvedValue(mockLAO());
      const result = await service.findOne('L001');
      expect(laoRepository.findOne).toHaveBeenCalledWith({ where: { id: 'L001' }, relations: ['amphoe'] });
      expect(result).toEqual(mockLAO());
    });
    it('should throw NotFoundException if LAO not found', async () => {
      laoRepository.findOne.mockResolvedValue(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.findOne('not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw InternalServerErrorException', async () => {
      laoRepository.findOne.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.findOne('L001')).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      laoRepository.findOne.mockResolvedValue(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.findOne('')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update', () => {
    const updateDto: UpdateLocalAdministrativeOrganizationDto = { name: 'Updated LAO', type: 'Type2', amphoeId: 'A002' };
    it('should update and return the LAO (success)', async () => {
      amphoeRepository.findOneBy.mockResolvedValue(mockAmphoe({ id: 'A002' }));
      laoRepository.preload.mockResolvedValue(mockLAO({ name: 'Updated LAO', type: 'Type2', amphoe: mockAmphoe({ id: 'A002' }) }));
      laoRepository.save.mockResolvedValue(mockLAO({ name: 'Updated LAO', type: 'Type2', amphoe: mockAmphoe({ id: 'A002' }) }));
      const result = await service.update('L001', updateDto);
      expect(amphoeRepository.findOneBy).toHaveBeenCalledWith({ id: 'A002' });
      expect(laoRepository.preload).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'L001',
          name: 'Updated LAO',
          type: 'Type2',
          amphoe: mockAmphoe({ id: 'A002' }),
        })
      );
      expect(laoRepository.save).toHaveBeenCalled();
      expect(result.name).toBe('Updated LAO');
      expect(result.type).toBe('Type2');
      expect(result.amphoe.id).toBe('A002');
    });
    it('should throw NotFoundException if amphoe not found', async () => {
      amphoeRepository.findOneBy.mockResolvedValue(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.update('L001', updateDto)).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw NotFoundException if LAO not found', async () => {
      amphoeRepository.findOneBy.mockResolvedValue(mockAmphoe({ id: 'A002' }));
      laoRepository.preload.mockResolvedValue(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.update('not-exist', updateDto)).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw InternalServerErrorException', async () => {
      amphoeRepository.findOneBy.mockResolvedValue(mockAmphoe({ id: 'A002' }));
      laoRepository.preload.mockResolvedValue(mockLAO({ name: 'Updated LAO', type: 'Type2', amphoe: mockAmphoe({ id: 'A002' }) }));
      laoRepository.save.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.update('L001', updateDto)).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      amphoeRepository.findOneBy.mockResolvedValue(mockAmphoe({ id: 'A002' }));
      laoRepository.preload.mockResolvedValue(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.update('', updateDto)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove', () => {
    it('should permanently delete a LAO (success)', async () => {
      laoRepository.delete.mockResolvedValue({ affected: 1 });
      const result = await service.remove('L001');
      expect(laoRepository.delete).toHaveBeenCalledWith('L001');
      expect(result).toEqual({ message: 'LAO with ID L001 has been permanently removed.' });
    });
    it('should throw NotFoundException if LAO not found', async () => {
      laoRepository.delete.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.remove('not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw InternalServerErrorException', async () => {
      laoRepository.delete.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.remove('L001')).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      laoRepository.delete.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.remove('')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('softRemove', () => {
    it('should soft delete a LAO (success)', async () => {
      laoRepository.softDelete.mockResolvedValue({ affected: 1 });
      const result = await service.softRemove('L001');
      expect(laoRepository.softDelete).toHaveBeenCalledWith('L001');
      expect(result).toEqual({ message: 'LAO with ID L001 has been soft-removed.' });
    });
    it('should throw NotFoundException if LAO not found', async () => {
      laoRepository.softDelete.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.softRemove('not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw InternalServerErrorException', async () => {
      laoRepository.softDelete.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.softRemove('L001')).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      laoRepository.softDelete.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.softRemove('')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('restore', () => {
    it('should restore a soft-deleted LAO (success)', async () => {
      laoRepository.restore.mockResolvedValue({ affected: 1 });
      const result = await service.restore('L001');
      expect(laoRepository.restore).toHaveBeenCalledWith('L001');
      expect(result).toEqual({ message: 'LAO with ID L001 has been restored.' });
    });
    it('should throw NotFoundException if LAO not found', async () => {
      laoRepository.restore.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.restore('not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw InternalServerErrorException', async () => {
      laoRepository.restore.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.restore('L001')).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      laoRepository.restore.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.restore('')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
