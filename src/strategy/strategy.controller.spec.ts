import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { StrategyController } from './strategy.controller';
import { StrategyService } from './strategy.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Strategy } from './entities/strategy.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { IssueCriteriaRegistryService } from 'src/ai/criteria/issue-criteria-registry.service';
import { IssueRuleEntry } from 'src/ai/criteria/issue-criteria.types';

/**
 * Strategy controller — Wave LAO-ISSUE-STRATEGY-PARITY N1.
 *
 * Covers the new `GET /v1/strategy/:id/criteria` endpoint at the
 * controller layer. The resolver method `findAllByStrategyName` is
 * mocked — its own behaviour (1-to-many, normalization, etc.) is
 * covered by the BE-RESOLVER unit tests in
 * `issue-criteria-registry.service.spec.ts`.
 *
 * Wiring contract (2026-05-21 reconciliation):
 *   1. Controller calls `strategyService.findOne(id)` which throws
 *      `NotFoundException` if the row is missing (404 path).
 *   2. Controller passes `strategy.name` into
 *      `IssueCriteriaRegistryService.findAllByStrategyName(name)` and
 *      receives `IssueRuleEntry[]`.
 *   3. Empty array is a valid 200 response (e.g., STRAT005 — Strategy
 *      exists but no regulatory criteria match).
 *
 * 401 (no auth) is enforced by `JwtAuthGuard` at the framework layer
 * and is covered by the global auth e2e suite — not re-asserted here.
 */
describe('StrategyController', () => {
  let controller: StrategyController;
  let strategyService: jest.Mocked<Pick<StrategyService, 'findOne'>>;
  let registry: jest.Mocked<
    Pick<
      IssueCriteriaRegistryService,
      'findAllByStrategyName' | 'getCurrentRulesetVersion'
    >
  >;

  const royalEntry: IssueRuleEntry = {
    provinceCode: 'NAKHON_RATCHASIMA',
    issueKey: 'royal-initiated',
    issueDisplayName: 'ด้านโครงการตามแนวทางพระราชดำริ',
    characteristics: [],
    matchers: { exactNames: [], keywordContains: [] },
    subTypes: [],
    criteria: [],
    rulesetVersion: '2026-04-18',
    sourceRefs: [],
  };

  const economic31: IssueRuleEntry = {
    ...royalEntry,
    issueKey: 'economic-3-1',
    issueDisplayName: 'ด้านพัฒนาเศรษฐกิจ — เพิ่มขีดความสามารถ',
  };
  const economic32: IssueRuleEntry = {
    ...royalEntry,
    issueKey: 'economic-3-2',
    issueDisplayName: 'ด้านพัฒนาเศรษฐกิจ — แหล่งน้ำเพื่อการเกษตร',
  };

  beforeEach(async () => {
    strategyService = {
      findOne: jest.fn(),
    };
    registry = {
      findAllByStrategyName: jest.fn(),
      getCurrentRulesetVersion: jest.fn().mockReturnValue('2026-04-18'),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [StrategyController],
      providers: [
        {
          provide: StrategyService,
          useValue: strategyService,
        },
        {
          provide: getRepositoryToken(Strategy),
          useValue: {},
        },
        {
          provide: getRepositoryToken(WorkHistory),
          useValue: {},
        },
        {
          provide: IssueCriteriaRegistryService,
          useValue: registry,
        },
      ],
    }).compile();

    controller = module.get<StrategyController>(StrategyController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('GET /v1/strategy/:id/criteria', () => {
    it('returns 200 + 1 entry when STRAT001 matches royal-initiated', async () => {
      strategyService.findOne.mockResolvedValue({
        id: 'STRAT001',
        name: 'ยุทธศาสตร์ด้านโครงการตามแนวพระราชดำริ',
      } as Strategy);
      registry.findAllByStrategyName.mockReturnValue([royalEntry]);

      const response = await controller.findCriteriaByStrategyId('STRAT001');

      expect(response).toEqual({
        strategyId: 'STRAT001',
        strategyName: 'ยุทธศาสตร์ด้านโครงการตามแนวพระราชดำริ',
        rulesetVersion: '2026-04-18',
        entries: [royalEntry],
        provinceCode: 'NAKHON_RATCHASIMA',
      });
      expect(strategyService.findOne).toHaveBeenCalledWith('STRAT001');
      expect(registry.findAllByStrategyName).toHaveBeenCalledWith(
        'ยุทธศาสตร์ด้านโครงการตามแนวพระราชดำริ',
      );
    });

    it('returns 200 + 2 entries when STRAT003 matches both economic rules', async () => {
      strategyService.findOne.mockResolvedValue({
        id: 'STRAT003',
        name: 'ยุทธศาสตร์ด้านการพัฒนาเศรษฐกิจ',
      } as Strategy);
      registry.findAllByStrategyName.mockReturnValue([economic31, economic32]);

      const response = await controller.findCriteriaByStrategyId('STRAT003');

      expect(response.entries).toHaveLength(2);
      expect(response.entries).toEqual(
        expect.arrayContaining([economic31, economic32]),
      );
      expect(response.strategyId).toBe('STRAT003');
      expect(response.rulesetVersion).toBe('2026-04-18');
      expect(response.provinceCode).toBe('NAKHON_RATCHASIMA');
    });

    it('returns 200 + empty array when Strategy exists but no rule matches (STRAT005)', async () => {
      strategyService.findOne.mockResolvedValue({
        id: 'STRAT005',
        name: 'ยุทธศาสตร์ด้านพัฒนาระบบการบริหารจัดการภาครัฐ',
      } as Strategy);
      registry.findAllByStrategyName.mockReturnValue([]);

      const response = await controller.findCriteriaByStrategyId('STRAT005');

      expect(response).toEqual({
        strategyId: 'STRAT005',
        strategyName: 'ยุทธศาสตร์ด้านพัฒนาระบบการบริหารจัดการภาครัฐ',
        rulesetVersion: '2026-04-18',
        entries: [],
        provinceCode: null,
      });
      expect(registry.getCurrentRulesetVersion).toHaveBeenCalledWith(
        'NAKHON_RATCHASIMA',
      );
    });

    it('propagates NotFoundException when Strategy id is unknown', async () => {
      strategyService.findOne.mockRejectedValue(
        new NotFoundException('Strategy with ID UNKNOWN not found'),
      );

      await expect(
        controller.findCriteriaByStrategyId('UNKNOWN'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(registry.findAllByStrategyName).not.toHaveBeenCalled();
    });
  });
});
