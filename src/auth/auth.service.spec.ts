import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from 'src/users/entities/user.entity';
import { UsersService } from 'src/users/users.service';
import {
  UnauthorizedException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { hashCitizenId } from 'src/util/encryption.util';

jest.mock('jsonwebtoken');
jest.mock('src/util/encryption.util', () => ({
  hashCitizenId: jest.fn(),
}));

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('AuthService', () => {
  let service: AuthService;
  let userRepository: jest.Mocked<Repository<User>>;
  let userService: jest.Mocked<UsersService>;
  let jwtService: jest.Mocked<JwtService>;

  const mockUserRepository = () => ({
    findOne: jest.fn(),
  });
  const mockUserService = () => ({
    create: jest.fn(),
    update: jest.fn(),
  });
  const mockJwtService = () => ({
    sign: jest.fn(),
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useFactory: mockUserRepository },
        { provide: UsersService, useFactory: mockUserService },
        { provide: JwtService, useFactory: mockJwtService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    userRepository = module.get(getRepositoryToken(User));
    userService = module.get(UsersService);
    jwtService = module.get(JwtService);
    jest.clearAllMocks();
  });

  const validDecoded = {
    sub: 'subid',
    iss: 'https://imauth.bora.dopa.go.th',
    pid: '1234567890123',
    title: 'Mr.',
    given_name: 'John',
    family_name: 'Doe',
  };
  const validIdToken = 'valid.token';
  const validDivisionId = 'div-1';
  const validDivisionName = 'Division Name';
  const hashedCid = 'hashed-cid';
  const userId = '1';
  const mockAmphoe = {
    id: 'amp-1',
    name: 'Amphoe',
    createAt: new Date('2023-01-01'),
    deletedAt: undefined,
    workHistory: [],
    localAdministrativeOrganization: [],
    workHistoryResponsibleAdmins: [],
  };
  const minimalUser = {
    id: userId,
    citizenId: '1234567890123',
    citizenIdHash: hashedCid,
    prefix: 'Mr.',
    firstname: 'John',
    lastname: 'Doe',
    email: 'john@example.com',
    phone: '0123456789',
    isFirstLogin: false,
    deletedAt: undefined,
    createAt: new Date('2023-01-01'),
    workHistory: [],
    createdWorkHistory: [],
    updatedWorkHistory: [],
    position: [],
    userActivityLogs: [],
  };
  const workHistory = [
    {
      id: '10',
      createdAt: new Date('2023-01-01'),
      workStatus: {
        id: 'ws-1',
        name: 'approved',
        createdAt: new Date('2023-01-01'),
        deletedAt: undefined,
        workHistory: [],
      },
      governmentAgencies: {
        id: 'gov-1',
        name: 'Gov Agency',
        deletedAt: undefined,
        createdAt: new Date('2023-01-01'),
        workHistory: [],
        responsibleAgencyProjectGroup: [],
      },
      amphoe: mockAmphoe,
      localAdministrativeOrganization: {
        id: 'lao-1',
        name: 'LAO',
        type: 'type',
        createdAt: new Date('2023-01-01'),
        deleteAt: null,
        amphoe: mockAmphoe,
        workHistory: [],
        originAgencyProjectGroup: [],
      },
      role: {
        id: 'role-1',
        name: 'admin',
        deletedAt: undefined,
        createdAt: new Date('2023-01-01'),
        workHistory: [],
      },
      user: minimalUser,
      createdBy: undefined,
      deletedAt: undefined,
      updatedAt: new Date('2023-01-01'),
      updatedBy: undefined,
      workHistoryResponsibleAdmins: [],
      budgetPlan: [],
      creatorStrategy: [],
      deletorStrategy: [],
      creatorProjectGroup: [],
      responsibleProjectGroup: [],
      creatorTactic: [],
      deletorTactic: [],
      creatorPlan: [],
      deletorPlan: [],
      creatorTrackingStatus: [],
      deletorTrackingStatus: [],
      creatorStatus: [],
      deletorStatus: [],
    },
  ];
  const user = {
    id: userId,
    citizenId: '1234567890123',
    citizenIdHash: hashedCid,
    prefix: 'Mr.',
    firstname: 'John',
    lastname: 'Doe',
    email: 'john@example.com',
    phone: '0123456789',
    isFirstLogin: false,
    deletedAt: undefined,
    createAt: new Date('2023-01-01'),
    workHistory,
    createdWorkHistory: [],
    updatedWorkHistory: [],
    position: [],
    userActivityLogs: [],
  };

  describe('handleOAuthLogin', () => {
    beforeEach(() => {
      (jwt.decode as jest.Mock).mockReset();
      (hashCitizenId as jest.Mock).mockReset();
    });

    it('should login existing user and return accessToken (success)', async () => {
      (jwt.decode as jest.Mock).mockReturnValue(validDecoded);
      (hashCitizenId as jest.Mock).mockReturnValue(hashedCid);
      userRepository.findOne.mockResolvedValue({ ...user, userActivityLogs: [] });
      userService.update.mockResolvedValue({ ...user, userActivityLogs: [] });
      jwtService.sign.mockReturnValue('signed-token');

      const result = await service.handleOAuthLogin(
        validIdToken,
        validDivisionId,
        validDivisionName,
      );
      expect(result).toHaveProperty('accessToken', 'signed-token');
      expect(result.user).toMatchObject({
        id: userId,
        divisionId: workHistory[0].governmentAgencies.id,
        divisionName: workHistory[0].governmentAgencies.name,
        role: 'admin',
        workStatus: 'approved',
      });
      expect(userService.update).toHaveBeenCalled();
      expect(userService.create).not.toHaveBeenCalled();
    });

    it('should create new user if not found', async () => {
      (jwt.decode as jest.Mock).mockReturnValue(validDecoded);
      (hashCitizenId as jest.Mock).mockReturnValue(hashedCid);
      userRepository.findOne.mockResolvedValue(null);
      userService.create.mockResolvedValue({ ...user, isFirstLogin: true });
      jwtService.sign.mockReturnValue('signed-token');

      const result = await service.handleOAuthLogin(
        validIdToken,
        validDivisionId,
        validDivisionName,
      );
      expect(userService.create).toHaveBeenCalled();
      expect(result.isFirstLogin).toBe(true);
      expect(result.user.divisionId).toBe(validDivisionId);
      expect(result.user.divisionName).toBe(validDivisionName);
    });

    it('should throw UnauthorizedException if idToken is invalid', async () => {
      (jwt.decode as jest.Mock).mockReturnValue(null);
      await expect(
        service.handleOAuthLogin('', validDivisionId, validDivisionName),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('should throw UnauthorizedException if issuer is invalid', async () => {
      (jwt.decode as jest.Mock).mockReturnValue({
        ...validDecoded,
        iss: 'invalid-issuer',
      });
      await expect(
        service.handleOAuthLogin(
          validIdToken,
          validDivisionId,
          validDivisionName,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('should throw InternalServerErrorException on DB error', async () => {
      (jwt.decode as jest.Mock).mockReturnValue(validDecoded);
      (hashCitizenId as jest.Mock).mockReturnValue(hashedCid);
      userRepository.findOne.mockRejectedValue(new Error('DB error'));
      await expect(
        service.handleOAuthLogin(
          validIdToken,
          validDivisionId,
          validDivisionName,
        ),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('should throw InternalServerErrorException on unexpected error', async () => {
      (jwt.decode as jest.Mock).mockImplementation(() => {
        throw new Error('decode error');
      });
      await expect(
        service.handleOAuthLogin(
          validIdToken,
          validDivisionId,
          validDivisionName,
        ),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('should handle user with no workHistory gracefully', async () => {
      (jwt.decode as jest.Mock).mockReturnValue(validDecoded);
      (hashCitizenId as jest.Mock).mockReturnValue(hashedCid);
      userRepository.findOne.mockResolvedValue({ ...user, workHistory: [] });
      userService.update.mockResolvedValue({ ...user, workHistory: [] });
      jwtService.sign.mockReturnValue('signed-token');
      const result = await service.handleOAuthLogin(
        validIdToken,
        validDivisionId,
        validDivisionName,
      );
      expect(result.user.workHistoryId).toBeNull();
      expect(result.user.role).toBe('user');
      expect(result.user.workStatus).toBe('pending');
    });

    it('should handle empty string/edge case inputs', async () => {
      (jwt.decode as jest.Mock).mockReturnValue(validDecoded);
      (hashCitizenId as jest.Mock).mockReturnValue(hashedCid);
      userRepository.findOne.mockResolvedValue({ ...user });
      userService.update.mockResolvedValue({ ...user });
      jwtService.sign.mockReturnValue('signed-token');
      // Empty divisionId
      const result = await service.handleOAuthLogin(
        validIdToken,
        '',
        validDivisionName,
      );
      expect(result.user.divisionId).toBe(workHistory[0].governmentAgencies.id);
      // Empty divisionName
      const result2 = await service.handleOAuthLogin(
        validIdToken,
        validDivisionId,
        '',
      );
      expect(result2.user.divisionName).toBe(
        workHistory[0].governmentAgencies.name,
      );
    });

    it('should handle negative/zero/invalid user id edge cases', async () => {
      (jwt.decode as jest.Mock).mockReturnValue(validDecoded);
      (hashCitizenId as jest.Mock).mockReturnValue(hashedCid);
      userRepository.findOne.mockResolvedValue({ ...user, id: '0' });
      userService.update.mockResolvedValue({ ...user, id: '0' });
      jwtService.sign.mockReturnValue('signed-token');
      const result = await service.handleOAuthLogin(
        validIdToken,
        validDivisionId,
        validDivisionName,
      );
      expect(result.user.id).toBe('0');
    });
  });
});
