import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AiUsageLogsController } from './ai-usage-logs.controller';
import { AiUsageLogsService } from './ai-usage-logs.service';
import { AiUsageLog } from './entities/ai-usage-log.entity';
import { AiUsageLogResponseDto } from './dto/ai-usage-log-response.dto';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';

describe('AiUsageLogsController', () => {
  let controller: AiUsageLogsController;

  const mockRepository = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AiUsageLogsController],
      providers: [
        AiUsageLogsService,
        {
          provide: getRepositoryToken(AiUsageLog),
          useValue: mockRepository,
        },
      ],
    }).compile();

    controller = module.get<AiUsageLogsController>(AiUsageLogsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});

/**
 * Wave 36 N3 — controller-level tests for the new `/:id/detail`
 * owner-scoped endpoint. These tests verify the ownership gating
 * enforced in the service (`findDetailForUser`) propagates correctly
 * through the controller, including the 404-on-non-owner policy
 * (§17.3 enumeration hardening) and 401-on-missing-user-claims
 * behavior. The `JwtAuthGuard` itself is not exercised here — we
 * simulate authenticated / unauthenticated by populating / omitting
 * `req.user` the same way `JwtAuthGuard.handleRequest` would.
 */
describe('AiUsageLogsController — GET /:id/detail (Wave 36 N3)', () => {
  let controller: AiUsageLogsController;
  let service: { findDetailForUser: jest.Mock };

  const OWNER_USER_ID = 'user-owner-uuid';
  const OTHER_USER_ID = 'user-other-uuid';
  const LOG_ID = '11111111-1111-1111-1111-111111111111';

  const ownerLogDto: AiUsageLogResponseDto = {
    id: LOG_ID,
    usageType: 'PRE_SUBMIT_REVIEW',
    inputTextLength: 100,
    outputTextLength: 50,
    costBaht: 0.12,
    usedAt: new Date('2026-04-21T00:00:00Z'),
    endpoint: 'pre-submit-review',
    summaryTh: 'สรุปภาษาไทย',
    requestPayload: { foo: 'bar' },
    responsePayload: { score: 85 },
    targetId: '22222222-2222-2222-2222-222222222222',
    targetKind: 'project_group',
    actorWorkHistoryId: '33333333-3333-3333-3333-333333333333',
    durationMs: 1234,
    error: null,
  };

  beforeEach(async () => {
    service = {
      findDetailForUser: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AiUsageLogsController],
      providers: [
        {
          provide: AiUsageLogsService,
          useValue: service,
        },
      ],
    }).compile();

    controller = module.get<AiUsageLogsController>(AiUsageLogsController);
  });

  function makeReq(user: JwtPayloadUser | undefined) {
    return { user } as Request & { user: JwtPayloadUser };
  }

  it('returns the full DTO with new fields when caller owns the log', async () => {
    service.findDetailForUser.mockResolvedValue(ownerLogDto);
    const req = makeReq({
      userId: OWNER_USER_ID,
      citizenId: '1234567890123',
      role: 'user',
    });

    const result = await controller.getDetailForOwner(LOG_ID, req);

    expect(service.findDetailForUser).toHaveBeenCalledWith(LOG_ID, OWNER_USER_ID);
    expect(result).toEqual(ownerLogDto);
    // Wave 36 N1 extended fields must be populated
    expect(result.endpoint).toBe('pre-submit-review');
    expect(result.summaryTh).toBe('สรุปภาษาไทย');
    expect(result.requestPayload).toEqual({ foo: 'bar' });
    expect(result.responsePayload).toEqual({ score: 85 });
    expect(result.targetId).toBe('22222222-2222-2222-2222-222222222222');
    expect(result.targetKind).toBe('project_group');
    expect(result.actorWorkHistoryId).toBe('33333333-3333-3333-3333-333333333333');
    expect(result.durationMs).toBe(1234);
  });

  it('returns 404 (not 403) when the log belongs to a different user', async () => {
    // Service throws NotFoundException for non-owner (ownership
    // mismatch) to prevent ID enumeration — §17.3 hardening.
    service.findDetailForUser.mockRejectedValue(
      new NotFoundException('Usage log not found'),
    );
    const req = makeReq({
      userId: OTHER_USER_ID,
      citizenId: '1234567890123',
      role: 'user',
    });

    await expect(controller.getDetailForOwner(LOG_ID, req)).rejects.toThrow(
      NotFoundException,
    );
    expect(service.findDetailForUser).toHaveBeenCalledWith(LOG_ID, OTHER_USER_ID);
  });

  it('returns 404 when the log does not exist', async () => {
    service.findDetailForUser.mockRejectedValue(
      new NotFoundException('Usage log not found'),
    );
    const req = makeReq({
      userId: OWNER_USER_ID,
      citizenId: '1234567890123',
      role: 'user',
    });

    await expect(controller.getDetailForOwner(LOG_ID, req)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws UnauthorizedException when req.user is missing', async () => {
    const req = makeReq(undefined);

    await expect(controller.getDetailForOwner(LOG_ID, req)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(service.findDetailForUser).not.toHaveBeenCalled();
  });
});
