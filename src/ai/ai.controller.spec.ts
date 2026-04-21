import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { PreSubmitSnapshotService } from './pre-submit-snapshot.service';
import { PromptSuggestionsDto } from './dto/prompt-suggestions.dto';

const mockAiService = {
  generateProjectDetail: jest.fn(),
  regenerateField: jest.fn(),
  analyzeProjectForSmartApprove: jest.fn(),
  generatePromptSuggestions: jest.fn(),
  // Wave 35 N1 — lightweight deterministic preview.
  buildGeoPreview: jest.fn(),
};

const mockPreSubmitSnapshotService = {
  createSnapshot: jest.fn(),
  getActiveSnapshot: jest.fn(),
  getOwnerSnapshot: jest.fn(),
};

const fakeReq = { user: { userId: 'user-1' } } as any;

describe('AiController', () => {
  let controller: AiController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AiController],
      providers: [
        { provide: AiService, useValue: mockAiService },
        {
          provide: PreSubmitSnapshotService,
          useValue: mockPreSubmitSnapshotService,
        },
      ],
    }).compile();

    controller = module.get<AiController>(AiController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('POST prompt-suggestions', () => {
    const body: PromptSuggestionsDto = {
      reportFormat: 'STRATEGY_BASED',
      strategyName: 'ยุทธศาสตร์ 1',
    };

    it('returns suggestions array from service (happy path)', async () => {
      mockAiService.generatePromptSuggestions.mockResolvedValue({
        suggestions: ['เน้นการมีส่วนร่วม', 'เพิ่มตัวชี้วัดเชิงคุณภาพ'],
        usage: null,
        cost: 0,
      });

      const result = await controller.promptSuggestions(body, fakeReq);
      expect(result).toEqual({
        suggestions: ['เน้นการมีส่วนร่วม', 'เพิ่มตัวชี้วัดเชิงคุณภาพ'],
      });
      expect(mockAiService.generatePromptSuggestions).toHaveBeenCalledWith(
        body,
      );
    });

    it('returns empty suggestions when service returns empty pool', async () => {
      mockAiService.generatePromptSuggestions.mockResolvedValue({
        suggestions: [],
        usage: null,
        cost: 0,
      });

      const result = await controller.promptSuggestions(body, fakeReq);
      expect(result).toEqual({ suggestions: [] });
    });

    it('throws UnauthorizedException when no user on request', async () => {
      await expect(
        controller.promptSuggestions(body, { user: undefined } as any),
      ).rejects.toThrow(UnauthorizedException);
      expect(mockAiService.generatePromptSuggestions).not.toHaveBeenCalled();
    });
  });

  // Wave 33.6 N2 — controller envelope changes for FeasibilityGate
  // verdict. These tests cover: block short-circuit omission of
  // briefing/briefingRefs/content/usage; pass/warn passthrough at top
  // level; STRATEGY_BASED byte-identical envelope; defensive sanitizer.
  describe('POST generate-project-detail — Wave 33.6 N2 feasibility envelope', () => {
    const baseBody = {
      reportFormat: 'ISSUE_BASED',
      subTypeCode: 'RS-ROAD-01',
    } as any;

    // Minimal fake LLM output used by non-block paths. The controller
    // runs parseSection against this text so it must contain the
    // section headers the controller expects.
    const fakeRawResult = [
      'ชื่อโครงการ: ทดสอบ',
      'วัตถุประสงค์: เพื่อทดสอบ',
      'เป้าหมาย: เป้าทดสอบ',
      'ผลที่คาดว่าจะได้รับ: ผลทดสอบ',
      'ตัวชี้วัด: ตัวชี้วัดทดสอบ',
      'ข้อมูลที่มี: ข้อมูลทดสอบ',
      'เหตุผลที่คิดโครงการนี้: เหตุผลทดสอบ',
      'ความเหมาะสมของพื้นที่: เหมาะสม',
      'ป้ายพื้นที่: พื้นที่ทดสอบ',
    ].join('\n');

    it('block path — returns feasibility envelope only, omits briefing/briefingRefs/content/usage', async () => {
      mockAiService.generateProjectDetail.mockResolvedValue({
        content: null,
        usage: null,
        feasibility: {
          isFeasible: false,
          severity: 'block',
          reason: 'พื้นที่นี้ไม่เหมาะสม',
          recommendations: ['พิจารณาพื้นที่อื่น'],
          triggeredRule: 'RESERVOIR_ROAD_LIKE',
        },
        aiSkipped: true,
      });

      const result: any = await controller.generate(baseBody, fakeReq);

      // Top-level feasibility with severity block
      expect(result.feasibility).toBeDefined();
      expect(result.feasibility.severity).toBe('block');
      expect(result.feasibility.isFeasible).toBe(false);
      expect(result.feasibility.triggeredRule).toBe('RESERVOIR_ROAD_LIKE');
      expect(result.aiSkipped).toBe(true);

      // Explicit absence of result-card payload
      expect(result.content).toBeUndefined();
      expect(result.briefing).toBeUndefined();
      expect(result.briefingRefs).toBeUndefined();
      expect(result.title).toBeUndefined();
      expect(result.objective).toBeUndefined();

      // usage nulled, cost 0 per §7.3 of task file
      expect(result.usage).toBeNull();
      expect(result.cost).toBe(0);
    });

    it('pass path — includes top-level feasibility alongside normal envelope', async () => {
      mockAiService.generateProjectDetail.mockResolvedValue({
        content: fakeRawResult,
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        feasibility: { isFeasible: true, severity: 'pass' },
      });

      const result: any = await controller.generate(baseBody, fakeReq);

      expect(result.feasibility).toEqual({
        isFeasible: true,
        severity: 'pass',
      });
      // Normal envelope preserved
      expect(result.title).toBe('ทดสอบ');
      expect(result.objective).toBeDefined();
      expect(result.usage).toBeDefined();
    });

    it('warn path — includes top-level feasibility alongside normal envelope', async () => {
      mockAiService.generateProjectDetail.mockResolvedValue({
        content: fakeRawResult,
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        feasibility: { isFeasible: true, severity: 'warn' },
      });

      const result: any = await controller.generate(baseBody, fakeReq);

      expect(result.feasibility).toEqual({
        isFeasible: true,
        severity: 'warn',
      });
      expect(result.title).toBe('ทดสอบ');
    });

    it('STRATEGY_BASED — envelope has NO feasibility key when service returns no feasibility', async () => {
      mockAiService.generateProjectDetail.mockResolvedValue({
        content: fakeRawResult,
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        // feasibility omitted (N1 service returns null for STRATEGY_BASED)
      });

      const result: any = await controller.generate(
        { ...baseBody, reportFormat: 'STRATEGY_BASED' },
        fakeReq,
      );

      expect(result.feasibility).toBeUndefined();
      expect('feasibility' in result).toBe(false);
      expect(result.title).toBe('ทดสอบ');
    });

    it('Wave 35 N1 handler is registered on the controller (grep guard)', () => {
      expect(typeof (controller as any).geoPreview).toBe('function');
    });

    it('block path — sanitizer strips [GEO_GROUND_TRUTH] marker from reason defensively', async () => {
      mockAiService.generateProjectDetail.mockResolvedValue({
        content: null,
        usage: null,
        feasibility: {
          isFeasible: false,
          severity: 'block',
          reason: '[GEO_GROUND_TRUTH] พื้นที่ไม่เหมาะสม',
          recommendations: ['[GEO_GROUND_TRUTH] พิจารณาพื้นที่อื่น'],
          triggeredRule: 'RESERVOIR_ROAD_LIKE',
        },
        aiSkipped: true,
      });

      const result: any = await controller.generate(baseBody, fakeReq);

      expect(result.feasibility.reason).not.toContain('[GEO_GROUND_TRUTH]');
      expect(result.feasibility.recommendations[0]).not.toContain(
        '[GEO_GROUND_TRUTH]',
      );
    });
  });

  // Wave 35 N1 — `POST /ai/geo-preview` controller contract. The
  // underlying buildGeoPreview logic is unit-tested against AiService
  // (see ai.service.spec.ts). Controller specs focus on wiring:
  // DTO → service call → envelope passthrough + auth guard.
  describe('POST geo-preview (Wave 35 N1)', () => {
    const issueBasedBody = {
      lat: 14.9798,
      lng: 102.0978,
      subTypeCode: '4.1',
      reportFormat: 'ISSUE_BASED' as const,
    };

    it('throws UnauthorizedException when no user on request', async () => {
      await expect(
        controller.geoPreview(issueBasedBody, { user: undefined } as any),
      ).rejects.toThrow(UnauthorizedException);
      expect(mockAiService.buildGeoPreview).not.toHaveBeenCalled();
    });

    it('STRATEGY_BASED — delegates to service; service short-circuits to minimal envelope', async () => {
      const strategyEnvelope = {
        geoFeature: null,
        adminBoundary: null,
        landUseHint: null,
        geoAnalysis: null,
        feasibility: { isFeasible: true, severity: 'pass' as const },
      };
      mockAiService.buildGeoPreview.mockReturnValue(strategyEnvelope);

      const body = { ...issueBasedBody, reportFormat: 'STRATEGY_BASED' as const };
      const result = await controller.geoPreview(body, fakeReq);

      expect(result).toEqual(strategyEnvelope);
      expect(mockAiService.buildGeoPreview).toHaveBeenCalledWith({
        lat: body.lat,
        lng: body.lng,
        subTypeCode: body.subTypeCode,
        reportFormat: 'STRATEGY_BASED',
      });
    });

    it('ISSUE_BASED reservoir + road-like — returns service block verdict', async () => {
      const blockEnvelope = {
        geoFeature: {
          featureId: 'res-1',
          featureType: 'reservoir',
          nameTh: 'อ่างเก็บน้ำลำตะคอง',
        },
        adminBoundary: null,
        landUseHint: null,
        geoAnalysis: null,
        feasibility: {
          isFeasible: false,
          severity: 'block' as const,
          reason: 'ไม่สามารถสร้างถนนกลางอ่างเก็บน้ำ',
        },
      };
      mockAiService.buildGeoPreview.mockReturnValue(blockEnvelope);

      const result = await controller.geoPreview(issueBasedBody, fakeReq);
      expect(result.feasibility.severity).toBe('block');
      expect(result.geoFeature?.featureType).toBe('reservoir');
    });

    it('ISSUE_BASED land pin — returns pass verdict with null geoAnalysis', async () => {
      const passEnvelope = {
        geoFeature: null,
        adminBoundary: null,
        landUseHint: null,
        geoAnalysis: null,
        feasibility: { isFeasible: true, severity: 'pass' as const },
      };
      mockAiService.buildGeoPreview.mockReturnValue(passEnvelope);

      const result = await controller.geoPreview(issueBasedBody, fakeReq);
      expect(result.feasibility.severity).toBe('pass');
      expect(result.geoAnalysis).toBeNull();
    });

    it('ISSUE_BASED without subTypeCode — passes undefined through to service', async () => {
      const envelope = {
        geoFeature: null,
        adminBoundary: null,
        landUseHint: null,
        geoAnalysis: null,
        feasibility: { isFeasible: true, severity: 'pass' as const },
      };
      mockAiService.buildGeoPreview.mockReturnValue(envelope);

      const body = {
        lat: 14.9798,
        lng: 102.0978,
        reportFormat: 'ISSUE_BASED' as const,
      };
      await controller.geoPreview(body, fakeReq);

      expect(mockAiService.buildGeoPreview).toHaveBeenCalledWith({
        lat: body.lat,
        lng: body.lng,
        subTypeCode: undefined,
        reportFormat: 'ISSUE_BASED',
      });
    });

    it('never invokes generateProjectDetail or the classifier-heavy paths', async () => {
      mockAiService.buildGeoPreview.mockReturnValue({
        geoFeature: null,
        adminBoundary: null,
        landUseHint: null,
        geoAnalysis: null,
        feasibility: { isFeasible: true, severity: 'pass' as const },
      });

      await controller.geoPreview(issueBasedBody, fakeReq);

      expect(mockAiService.generateProjectDetail).not.toHaveBeenCalled();
      expect(mockAiService.analyzeProjectForSmartApprove).not.toHaveBeenCalled();
    });
  });
});
