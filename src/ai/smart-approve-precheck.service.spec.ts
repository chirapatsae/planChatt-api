import { Test, TestingModule } from '@nestjs/testing';
import { SmartApprovePrecheckService } from './smart-approve-precheck.service';
import { SmartApproveReferenceService } from './smart-approve-reference.service';
import { GeoBoundaryService } from './geo-boundary.service';
import { SmartApproveRequestDto } from './dto/smart-approve.dto';

describe('SmartApprovePrecheckService', () => {
  let service: SmartApprovePrecheckService;

  const createValidDto = (overrides: Partial<SmartApproveRequestDto> = {}) =>
    ({
      strategyName: 'ยุทธศาสตร์ตัวอย่าง',
      tacticName: 'กลยุทธ์ตัวอย่าง',
      planName: 'แผนงานตัวอย่าง',
      project: {
        title: 'โครงการตัวอย่าง',
        objective: 'วัตถุประสงค์ของโครงการที่ยาวเพียงพอสำหรับการทดสอบให้ผ่านเกณฑ์ความยาว',
        goal: 'เป้าหมายของโครงการที่ยาวเพียงพอและชัดเจนเพื่อให้ผ่านเกณฑ์การตรวจสอบ',
        indicator: 'มีตัวชี้วัดที่ชัดเจน',
        expected: 'ผลที่คาดว่าจะได้รับครบถ้วน',
        startLat: 14.9799,
        startLng: 102.0978,
        amphoeId: 3001,
        budgets: [{ year: 2025, quantity: 100000 }],
      },
      ...overrides,
    }) as SmartApproveRequestDto;

  const geoBoundaryServiceMock = {
    isPointInsideAmphoe: jest.fn().mockReturnValue(true),
  } as unknown as GeoBoundaryService;

  const createReferenceServiceMock = (
    overrides: Partial<SmartApproveReferenceService> = {},
  ) =>
    ({
      findStrategyByName: jest.fn().mockReturnValue({
        id: 'STRAT001',
        name: 'ยุทธศาสตร์ตัวอย่าง',
      }),
      findTacticByName: jest.fn().mockReturnValue({
        id: 'TACT001',
        name: 'กลยุทธ์ตัวอย่าง',
        strategy_id: 'STRAT001',
      }),
      findPlanByName: jest.fn().mockReturnValue({
        id: 'PLAN001',
        name: 'แผนงานตัวอย่าง',
      }),
      getStrategyById: jest.fn().mockReturnValue({
        id: 'STRAT001',
        name: 'ยุทธศาสตร์ตัวอย่าง',
      }),
      getTacticsForStrategy: jest.fn().mockReturnValue([
        { id: 'TACT001', name: 'กลยุทธ์ตัวอย่าง', strategy_id: 'STRAT001' },
      ]),
      getPlansForTactic: jest.fn().mockReturnValue([
        { id: 'PLAN001', name: 'แผนงานตัวอย่าง' },
      ]),
      isPlanLinkedToTactic: jest.fn().mockReturnValue(true),
      getLocalOrganizationById: jest.fn(),
      ...overrides,
    }) as unknown as SmartApproveReferenceService;

  const setupModule = async (
    referenceServiceMock: SmartApproveReferenceService,
  ) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SmartApprovePrecheckService,
        { provide: SmartApproveReferenceService, useValue: referenceServiceMock },
        { provide: GeoBoundaryService, useValue: geoBoundaryServiceMock },
      ],
    }).compile();

    service = module.get<SmartApprovePrecheckService>(
      SmartApprovePrecheckService,
    );
  };

  it('should pass when strategy/tactic/plan names align with reference data', async () => {
    await setupModule(createReferenceServiceMock());
    const result = service.evaluate(createValidDto());

    expect(result.response.categories.strategy.status).toBe('ผ่าน');
    expect(result.response.categories.strategy.details).toContain('เชื่อมโยงกันถูกต้อง');
  });

  it('should fail when tactic belongs to a different strategy', async () => {
    const referenceServiceMock = createReferenceServiceMock({
      findStrategyByName: jest.fn().mockReturnValue({
        id: 'STRAT999',
        name: 'ยุทธศาสตร์อีกด้าน',
      }) as any,
      findTacticByName: jest.fn().mockReturnValue({
        id: 'TACT001',
        name: 'กลยุทธ์ตัวอย่าง',
        strategy_id: 'STRAT001',
      }) as any,
      getStrategyById: jest.fn().mockReturnValue({
        id: 'STRAT001',
        name: 'ยุทธศาสตร์ตัวอย่าง',
      }) as any,
      getTacticsForStrategy: jest.fn().mockReturnValue([
        { id: 'TACT999', name: 'กลยุทธ์ใน STRAT999', strategy_id: 'STRAT999' },
      ]) as any,
    });

    await setupModule(referenceServiceMock);
    const result = service.evaluate(createValidDto());

    expect(result.response.categories.strategy.status).toBe('ไม่ผ่าน');
    expect(result.response.categories.strategy.details).toContain('อยู่ภายใต้ยุทธศาสตร์');
    expect(result.response.categories.strategy.suggestions).toEqual(
      expect.arrayContaining([expect.stringContaining('เลือกกลยุทธ์ที่อยู่ในยุทธศาสตร์')]),
    );
  });

  it('should fail when plan is not linked to the tactic', async () => {
    const referenceServiceMock = createReferenceServiceMock({
      isPlanLinkedToTactic: jest.fn().mockReturnValue(false) as any,
      getPlansForTactic: jest.fn().mockReturnValue([
        { id: 'PLAN002', name: 'แผนงานที่ถูกต้อง' },
      ]) as any,
    });

    await setupModule(referenceServiceMock);
    const result = service.evaluate(createValidDto());

    expect(result.response.categories.strategy.status).toBe('ไม่ผ่าน');
    expect(result.response.categories.strategy.details).toContain('ไม่ได้เชื่อมกับกลยุทธ์');
    expect(result.response.categories.strategy.suggestions).toEqual(
      expect.arrayContaining([expect.stringContaining('เลือกแผนงานที่รองรับกลยุทธ์')]),
    );
  });
});
