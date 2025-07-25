import { Test, TestingModule } from '@nestjs/testing';
import { UserActivityLogsService } from './user-activity-logs.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UserActivityLog } from './entities/user-activity-log.entity';
import { User } from 'src/users/entities/user.entity';
import { Repository } from 'typeorm';
import { NotFoundException, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { CreateUserActivityLogDto } from './dto/create-user-activity-log.dto';
import { handleException } from 'src/util/handleException';

jest.mock('src/util/handleException');

describe('UserActivityLogsService', () => {
  let service: UserActivityLogsService;
  let userActivityLogRepository: jest.Mocked<Repository<UserActivityLog>>;
  let userRepository: jest.Mocked<Repository<User>>;

  const mockUser: User = { id: 'user-1' } as User;
  const mockLog: UserActivityLog = {
    id: 'log-1',
    activityType: 'LOGIN',
    activvityDetail: 'User logged in',
    ipAddress: '127.0.0.1',
    platform: 'web',
    userAgent: 'agent',
    createdAt: new Date(),
    createdBy: mockUser,
  } as UserActivityLog;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserActivityLogsService,
        {
          provide: getRepositoryToken(UserActivityLog),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            find: jest.fn(),
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<UserActivityLogsService>(UserActivityLogsService);
    userActivityLogRepository = module.get(getRepositoryToken(UserActivityLog));
    userRepository = module.get(getRepositoryToken(User));
    jest.clearAllMocks();
    (handleException as unknown as jest.Mock).mockReset();
  });

  describe('create', () => {
    const dto: CreateUserActivityLogDto = {
      activityType: 'LOGIN',
      activityDetail: 'User logged in',
      ipAddress: '127.0.0.1',
      platform: 'web',
      userAgent: 'agent',
    };
    it('should create and save a log (success)', async () => {
      userRepository.findOne.mockResolvedValue(mockUser);
      userActivityLogRepository.create.mockReturnValue(mockLog);
      userActivityLogRepository.save.mockResolvedValue(mockLog);
      const result = await service.create(dto, mockUser.id);
      expect(userRepository.findOne).toHaveBeenCalledWith({ where: { id: mockUser.id } });
      expect(userActivityLogRepository.create).toHaveBeenCalledWith({ ...dto, createdAt: expect.any(Date), createdBy: mockUser });
      expect(userActivityLogRepository.save).toHaveBeenCalledWith(mockLog);
      expect(result).toBe(mockLog);
    });
    it('should throw NotFoundException if user not found', async () => {
      userRepository.findOne.mockResolvedValue(null);
      (handleException as unknown as jest.Mock).mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.create(dto, 'bad-id')).rejects.toThrow(NotFoundException);
    });
    it('should handle BadRequestException (conflict)', async () => {
      userRepository.findOne.mockResolvedValue(mockUser);
      userActivityLogRepository.create.mockReturnValue(mockLog);
      const error = { driverError: { code: '23505' } };
      userActivityLogRepository.save.mockRejectedValue(error);
      (handleException as unknown as jest.Mock).mockImplementation(() => { throw new BadRequestException(); });
      await expect(service.create(dto, mockUser.id)).rejects.toThrow(BadRequestException);
    });
    it('should handle InternalServerErrorException', async () => {
      userRepository.findOne.mockResolvedValue(mockUser);
      userActivityLogRepository.create.mockReturnValue(mockLog);
      const error = new Error('DB error');
      userActivityLogRepository.save.mockRejectedValue(error);
      (handleException as unknown as jest.Mock).mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.create(dto, mockUser.id)).rejects.toThrow(InternalServerErrorException);
    });
    it('should handle edge case: empty userId', async () => {
      userRepository.findOne.mockResolvedValue(null);
      (handleException as unknown as jest.Mock).mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.create(dto, '')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findAll', () => {
    it('should return all logs (success)', async () => {
      userActivityLogRepository.find.mockResolvedValue([mockLog]);
      const result = await service.findAll();
      expect(userActivityLogRepository.find).toHaveBeenCalled();
      expect(result).toEqual([mockLog]);
    });
    it('should handle InternalServerErrorException', async () => {
      userActivityLogRepository.find.mockRejectedValue(new Error('DB error'));
      (handleException as unknown as jest.Mock).mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.findAll()).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('findOne', () => {
    it('should return a log by id (success)', async () => {
      userActivityLogRepository.findOne.mockResolvedValue(mockLog);
      const result = await service.findOne('log-1');
      expect(userActivityLogRepository.findOne).toHaveBeenCalledWith({ where: { id: 'log-1' } });
      expect(result).toBe(mockLog);
    });
    it('should throw NotFoundException if log not found', async () => {
      userActivityLogRepository.findOne.mockResolvedValue(null);
      (handleException as unknown as jest.Mock).mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.findOne('bad-id')).rejects.toThrow(NotFoundException);
    });
    it('should handle InternalServerErrorException', async () => {
      userActivityLogRepository.findOne.mockRejectedValue(new Error('DB error'));
      (handleException as unknown as jest.Mock).mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.findOne('log-1')).rejects.toThrow(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      userActivityLogRepository.findOne.mockResolvedValue(null);
      (handleException as unknown as jest.Mock).mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.findOne('')).rejects.toThrow(NotFoundException);
    });
    it('should handle edge case: negative id (string)', async () => {
      userActivityLogRepository.findOne.mockResolvedValue(null);
      (handleException as unknown as jest.Mock).mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.findOne('-1')).rejects.toThrow(NotFoundException);
    });
  });
});
