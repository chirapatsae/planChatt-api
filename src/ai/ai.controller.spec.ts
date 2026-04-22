import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { PreSubmitSnapshotService } from './pre-submit-snapshot.service';
import { StaffReviewCacheService } from './staff-review-cache.service';
import { StaffReviewPromptService } from './staff-review-prompt.service';
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

const mockStaffReviewCacheService = {
  getActiveRun: jest.fn(),
  createRun: jest.fn(),
  isStale: jest.fn(),
  // Wave 41 N8 P0 — controller-level fail-fast staff-lead gate.
  assertStaffLeadCaller: jest.fn(),
};

const mockStaffReviewPromptService = {
  buildStaffReviewPrompt: jest.fn(),
  executeStaffReview: jest.fn(),
};

const fakeReq = { user: { userId: 'user-1' } } as any;

describe('AiController', () => {
  let controller: AiController;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Wave 41 N8 P0 — default: controller-level staff-lead gate passes
    // for the fake req so the existing happy-path tests stay green.
    mockStaffReviewCacheService.assertStaffLeadCaller.mockResolvedValue({
      id: 'wh-A',
    });
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AiController],
      providers: [
        { provide: AiService, useValue: mockAiService },
        {
          provide: PreSubmitSnapshotService,
          useValue: mockPreSubmitSnapshotService,
        },
        {
          provide: StaffReviewCacheService,
          useValue: mockStaffReviewCacheService,
        },
        {
          provide: StaffReviewPromptService,
          useValue: mockStaffReviewPromptService,
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

  // ─────────────────────────────────────────────────────────────────────
  // Wave 41 N4 — POST /ai/staff-review/analyze · GET /ai/staff-review/:k/:id
  // ─────────────────────────────────────────────────────────────────────
  describe('Wave 41 N4 — staff review endpoints', () => {
    const targetId = '00000000-0000-4000-8000-000000000010';
    const contentHash = 'c'.repeat(64);
    const body: any = {
      reportFormat: 'STRATEGY_BASED',
      strategyName: 'S',
      tacticName: 'T',
      planName: 'P',
      project: {
        title: 'T1',
        objective: 'O1',
        goal: 'G1',
        expected: 'E1',
        indicator: 'I1',
        startLat: 14.9,
        startLng: 102.0,
        amphoeId: 3001,
        budgets: [{ year: 2025, quantity: 100000 }],
      },
      targetKind: 'project-group',
      targetId,
      projectId: targetId,
    };

    it('returns cached envelope when active run has same hash (cached:true)', async () => {
      mockStaffReviewPromptService.buildStaffReviewPrompt.mockResolvedValue({
        contentHash,
      });
      mockStaffReviewCacheService.getActiveRun.mockResolvedValue({
        run: {
          contentHash,
          reviewerWorkHistoryId: 'wh-A',
        },
        envelope: { score: 72, band: 'amber', stalenessPolicy: 'strict' },
        result: { overallScore: 72 },
      });

      const out = await controller.analyzeStaffReview(body, fakeReq);
      expect(out.cached).toBe(true);
      expect(out.reviewerWorkHistoryId).toBe('wh-A');
      expect(mockStaffReviewPromptService.executeStaffReview).not.toHaveBeenCalled();
      expect(mockStaffReviewCacheService.createRun).not.toHaveBeenCalled();
    });

    it('executes fresh LLM + createRun when no active row', async () => {
      mockStaffReviewPromptService.buildStaffReviewPrompt.mockResolvedValue({
        contentHash,
      });
      mockStaffReviewCacheService.getActiveRun.mockResolvedValue(null);
      mockStaffReviewPromptService.executeStaffReview.mockResolvedValue({
        overallScore: 80,
        readinessLabel: 'ควรปรับปรุง',
        rationale: 'rationale',
        strongPoint: 'sp',
        suggestions: [],
        checklistSummary: [],
        contentHash,
        model: 'gpt-4o',
      });
      mockStaffReviewCacheService.createRun.mockResolvedValue({
        score0100: 80,
        band: 'green',
        computedAt: new Date('2026-04-22T00:00:00Z'),
        contentHash,
        model: 'gpt-4o',
        endpoint: 'staff-review/analyze',
        reviewerWorkHistoryId: 'wh-A',
        resultJson: { overallScore: 80 },
      });

      const out = await controller.analyzeStaffReview(body, fakeReq);
      expect(out.cached).toBe(false);
      expect(out.envelope.stalenessPolicy).toBe('strict');
      expect(out.envelope.isStale).toBe(false);
      expect(mockStaffReviewPromptService.executeStaffReview).toHaveBeenCalledTimes(1);
      expect(mockStaffReviewCacheService.createRun).toHaveBeenCalledTimes(1);
    });

    it('recompute=true bypasses cache and forces a fresh LLM call', async () => {
      mockStaffReviewPromptService.buildStaffReviewPrompt.mockResolvedValue({
        contentHash,
      });
      mockStaffReviewPromptService.executeStaffReview.mockResolvedValue({
        overallScore: 50,
        readinessLabel: 'ต้องแก้ไขก่อนส่ง',
        rationale: 'r',
        strongPoint: 's',
        suggestions: [],
        checklistSummary: [],
        contentHash,
        model: 'gpt-4o',
      });
      mockStaffReviewCacheService.createRun.mockResolvedValue({
        score0100: 50,
        band: 'amber',
        computedAt: new Date(),
        contentHash,
        model: 'gpt-4o',
        endpoint: 'staff-review/analyze',
        reviewerWorkHistoryId: 'wh-A',
        resultJson: {},
      });

      const out = await controller.analyzeStaffReview(
        { ...body, recompute: true },
        fakeReq,
      );
      expect(out.cached).toBe(false);
      expect(mockStaffReviewCacheService.getActiveRun).not.toHaveBeenCalled();
      expect(mockStaffReviewPromptService.executeStaffReview).toHaveBeenCalledTimes(1);
    });

    it('POST: throws UnauthorizedException when req.user missing', async () => {
      await expect(
        controller.analyzeStaffReview(body, { user: undefined } as any),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('POST: non staff-lead caller (user role) is rejected BEFORE LLM call (Wave 41 N8 P0)', async () => {
      // Controller-level fail-fast: assertStaffLeadCaller throws 403 and
      // the prompt builder / LLM executor MUST NOT be invoked. Protects
      // reviewer AI quota from being burned by unauthorized callers.
      mockStaffReviewCacheService.assertStaffLeadCaller.mockRejectedValueOnce(
        new ForbiddenException(
          'เฉพาะเจ้าหน้าที่ (staff / admin / super-admin) เท่านั้นที่เรียกดูข้อมูลนี้ได้',
        ),
      );
      await expect(
        controller.analyzeStaffReview(body, fakeReq),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockStaffReviewPromptService.buildStaffReviewPrompt).not.toHaveBeenCalled();
      expect(mockStaffReviewPromptService.executeStaffReview).not.toHaveBeenCalled();
      expect(mockStaffReviewCacheService.createRun).not.toHaveBeenCalled();
      expect(mockStaffReviewCacheService.getActiveRun).not.toHaveBeenCalled();
    });

    it('GET: returns envelope + result for staff-lead caller', async () => {
      mockStaffReviewCacheService.getActiveRun.mockResolvedValue({
        run: { reviewerWorkHistoryId: 'wh-A', contentHash },
        envelope: { score: 72, band: 'amber', stalenessPolicy: 'strict' },
        result: { foo: 'bar' },
      });
      const out = await controller.getStaffReview(
        'project-group',
        targetId,
        fakeReq,
      );
      expect(out.envelope).not.toBeNull();
      // Narrow the union for the spec: at this point envelope is non-null.
      if (out.envelope) expect(out.envelope.score).toBe(72);
      expect(out.reviewerWorkHistoryId).toBe('wh-A');
    });

    it('GET: returns 200 with null envelope when no active run (empty-state contract)', async () => {
      mockStaffReviewCacheService.getActiveRun.mockResolvedValue(null);
      const out = await controller.getStaffReview(
        'project-group',
        targetId,
        fakeReq,
      );
      expect(out.envelope).toBeNull();
      expect(out.result).toBeNull();
      expect(out.reviewerWorkHistoryId).toBeNull();
    });

    it('GET: BadRequest for invalid targetKind', async () => {
      await expect(
        controller.getStaffReview('bogus-kind' as any, targetId, fakeReq),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('GET: 403 propagates from service (role gate in StaffReviewCacheService)', async () => {
      mockStaffReviewCacheService.getActiveRun.mockRejectedValue(
        new ForbiddenException('role'),
      );
      await expect(
        controller.getStaffReview('project-group', targetId, fakeReq),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
