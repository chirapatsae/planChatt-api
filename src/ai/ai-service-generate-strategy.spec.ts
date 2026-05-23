/**
 * Wave LAO_STRATEGY_AI_PARITY — Node N2.
 *
 * Verifies the STRATEGY_BASED criteria-injection sibling gate added in
 * `AiService.generateProjectDetail`. Backend-gated to LAO callers
 * (D4=B): agency callers continue to receive a byte-identical
 * pre-Wave prompt even when their Strategy resolves to a registry
 * entry.
 *
 * Source of truth:
 *   - CLAUDE.md §1 LAO classification, §16 reportFormat, §17.2 advisory,
 *     §17.7 reportFormat branching, §17.9 prompt-injection discipline,
 *     §17.11 no role exemption
 *   - docs/tasks/wave-lao-strategy-ai-parity/N2-generate-prompt-injection.md
 *
 * Coverage matrix:
 *   1. ISSUE_BASED LAO regression — sibling gate MUST NOT trigger.
 *      The existing single-entry composer drives the prompt. Top-level
 *      STRATEGY_BASED FORMAT header MUST be absent.
 *   2. STRATEGY_BASED LAO + match=1 → `[CRITERIA]` injected via the
 *      multi-entry composer (which delegates to single-entry for N=1).
 *   3. STRATEGY_BASED LAO + match=2 → both per-entry sub-blocks plus
 *      `[ISSUE_BOUNDARY]` separator and STRATEGY_BASED `[FORMAT]` header.
 *   4. STRATEGY_BASED LAO + match=0 (STRAT005) → block silently skipped;
 *      prompt is the legacy `baseSystemPrompt` only.
 *   5. STRATEGY_BASED Agency (amphoeId=3001 + laoOrgId=3001027) → block
 *      MUST NOT be injected (D4=B backend gating) even though strategy
 *      resolves.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { AiService } from './ai.service';
import { SmartApprovePrecheckService } from './smart-approve-precheck.service';
import { AiContextService } from './ai-context.service';
import { AiUsageQuotasService } from 'src/ai-usage-quotas/ai-usage-quotas.service';
import { IssueCriteriaRegistryService } from './criteria/issue-criteria-registry.service';
import { IssueCriteriaGeoCheckService } from './criteria/issue-criteria-geo-check.service';
import { IssueCriteriaEvidenceCheckService } from './criteria/issue-criteria-evidence-check.service';
import { GeoFeatureLookupService } from './geo-feature-lookup.service';
import { GeoConflictService } from './conflict/geo-conflict.service';
import { AdminBoundaryLookupService } from './admin-boundary-lookup.service';
import { LandUseClassifierService } from './land-use-classifier.service';
import { FeasibilityGateService } from './feasibility/feasibility-gate.service';
import { AiUsageLogsService } from 'src/ai-usage-logs/ai-usage-logs.service';
import { PiiRedactorService } from 'src/common/pii/pii-redactor.service';
import { LLM_CLIENT } from './llm/llm-client.interface';
import { IssueRuleEntry } from './criteria/issue-criteria.types';

/**
 * Minimal STRAT002 fixture (single-entry resolution path).
 * Mirrors the `quality-of-life` registry entry but trimmed to the
 * fields read by the composer + service code under test.
 */
const STRAT002_QUALITY_OF_LIFE: IssueRuleEntry = {
  provinceCode: 'NAKHON_RATCHASIMA',
  issueKey: 'quality-of-life',
  issueDisplayName: 'ด้านการพัฒนาคุณภาพชีวิต',
  characteristics: ['โครงการด้านการศึกษา กีฬา นันทนาการ สาธารณสุข'],
  matchers: { exactNames: ['ด้านการพัฒนาคุณภาพชีวิต'], keywordContains: [] },
  subTypes: [{ code: '2.1', label: 'การศึกษา' }],
  criteria: [
    {
      id: 'C2.a',
      label: 'ดำเนินการในภาพรวมของจังหวัด',
      description: 'รายละเอียดเกณฑ์',
      weight: 1,
      criticality: 'advisory',
      evidenceRequired: false,
      enforcement: 'llm-prose',
    },
  ],
  rulesetVersion: '2026-04-18',
  sourceRefs: [],
};

/**
 * STRAT003 fixture entry #1 (economic-3-1). Two entries resolve under
 * STRAT003 "ด้านการพัฒนาเศรษฐกิจ".
 */
const STRAT003_ECONOMIC_3_1: IssueRuleEntry = {
  provinceCode: 'NAKHON_RATCHASIMA',
  issueKey: 'economic-3-1',
  issueDisplayName: 'ด้านการพัฒนาเศรษฐกิจ — เกษตรกรรม',
  characteristics: ['โครงการส่งเสริมเกษตรกรรม'],
  matchers: { exactNames: ['ด้านการพัฒนาเศรษฐกิจ'], keywordContains: [] },
  subTypes: [],
  criteria: [
    {
      id: 'C3_1.a',
      label: 'เกณฑ์ผูกพันด้านเกษตร (blocking)',
      description: 'รายละเอียดเกณฑ์ผูกพัน',
      weight: 3,
      criticality: 'blocking',
      evidenceRequired: false,
      enforcement: 'llm-prose',
    },
  ],
  rulesetVersion: '2026-04-18',
  sourceRefs: [],
};

/** STRAT003 fixture entry #2 (economic-3-2). */
const STRAT003_ECONOMIC_3_2: IssueRuleEntry = {
  provinceCode: 'NAKHON_RATCHASIMA',
  issueKey: 'economic-3-2',
  issueDisplayName: 'ด้านการพัฒนาเศรษฐกิจ — อุตสาหกรรม',
  characteristics: ['โครงการส่งเสริมอุตสาหกรรม'],
  matchers: { exactNames: ['ด้านการพัฒนาเศรษฐกิจ'], keywordContains: [] },
  subTypes: [],
  criteria: [
    {
      id: 'C3_2.a',
      label: 'เกณฑ์อุตสาหกรรม',
      description: 'รายละเอียดเกณฑ์',
      weight: 2,
      criticality: 'preferred',
      evidenceRequired: false,
      enforcement: 'llm-prose',
    },
  ],
  rulesetVersion: '2026-04-18',
  sourceRefs: [],
};

describe('AiService.generateProjectDetail — STRATEGY_BASED LAO criteria injection (Wave LAO_STRATEGY_AI_PARITY N2)', () => {
  let service: AiService;

  // LLM mock captures the system prompt for assertions.
  const mockLlm = {
    createChatCompletion: jest.fn(),
  };

  // Registry mock with both ISSUE_BASED and STRATEGY_BASED resolvers.
  const mockIssueCriteriaRegistry = {
    findByIssueId: jest.fn(),
    findByIssueName: jest.fn(),
    findAllByStrategyName: jest.fn(),
    listAllForProvince: jest.fn().mockReturnValue([]),
    getCurrentRulesetVersion: jest.fn().mockReturnValue('2026-04-18'),
  };

  const mockContextService = { enrichContext: jest.fn().mockResolvedValue(null) };
  const mockQuotasService = {
    checkAndLogUsage: jest.fn().mockResolvedValue(undefined),
    findQuotaIdByUserId: jest.fn().mockResolvedValue(undefined),
  };
  const mockPrecheckService = {};
  const mockGeoCheck = { evaluate: jest.fn().mockReturnValue([]) };
  const mockEvidenceCheck = { evaluate: jest.fn().mockReturnValue([]) };
  const mockGeoFeatureLookup = {
    resolveFeatureForPoint: jest.fn().mockReturnValue(null),
  };
  const mockGeoConflict = {
    resolveProjectType: jest.fn().mockReturnValue('unknown'),
    analyze: jest.fn(),
  };
  const mockAdminBoundaryLookup = {
    resolveAdminBoundary: jest.fn().mockReturnValue(null),
  };
  const mockLandUseClassifier = {
    classify: jest.fn().mockResolvedValue(null),
    peekCache: jest.fn().mockReturnValue(null),
  };
  const mockFeasibilityGate = {
    evaluate: jest.fn().mockReturnValue({ severity: 'pass', isFeasible: true }),
  };
  const mockUsageLogs = { create: jest.fn().mockResolvedValue({}) };
  // PiiRedactor: pass-through (returns input unchanged) so the captured
  // user-role prompt matches the source mainPrompt verbatim and we can
  // focus assertions on the system-role criteria block.
  const mockPiiRedactor = {
    redactText: jest.fn((text: string) => ({ output: text, redactions: [] })),
    redactForPrompt: jest.fn((payload: unknown) => ({
      output: payload,
      redactions: [],
    })),
  };

  // 2026-05-22 — WorkHistory repo mock for the §1-compliant LAO helper
  // `isLaoCaller(userId)`. Default returns a LAO row (amphoe=2999, lao=
  // 3001028). Agency-case tests override `findOne` to return the
  // (3001, 3001027) tuple. Per CLAUDE.md §1 isCurrent=true is required;
  // returning `null` would treat the caller as agency (fail-closed).
  const buildLaoWorkHistory = () => ({
    user: { id: 'user-1' },
    amphoe: { id: '2999' },
    localAdministrativeOrganization: { id: '3001028' },
    isCurrent: true,
  });
  const buildAgencyWorkHistory = () => ({
    user: { id: 'user-1' },
    amphoe: { id: '3001' },
    localAdministrativeOrganization: { id: '3001027' },
    isCurrent: true,
  });
  const mockWorkHistoryRepo = {
    findOne: jest.fn().mockResolvedValue(buildLaoWorkHistory()),
  };

  beforeAll(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    // Re-arm default LLM response (test-specific cases may overwrite).
    mockLlm.createChatCompletion.mockResolvedValue({
      choices: [{ message: { content: 'ตัวอย่างผลลัพธ์' } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });
    // Re-arm default LAO WorkHistory; agency-case test overrides.
    mockWorkHistoryRepo.findOne.mockResolvedValue(buildLaoWorkHistory());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiService,
        { provide: LLM_CLIENT, useValue: mockLlm },
        { provide: SmartApprovePrecheckService, useValue: mockPrecheckService },
        { provide: AiUsageQuotasService, useValue: mockQuotasService },
        { provide: AiContextService, useValue: mockContextService },
        {
          provide: IssueCriteriaRegistryService,
          useValue: mockIssueCriteriaRegistry,
        },
        { provide: IssueCriteriaGeoCheckService, useValue: mockGeoCheck },
        {
          provide: IssueCriteriaEvidenceCheckService,
          useValue: mockEvidenceCheck,
        },
        { provide: GeoFeatureLookupService, useValue: mockGeoFeatureLookup },
        { provide: GeoConflictService, useValue: mockGeoConflict },
        {
          provide: AdminBoundaryLookupService,
          useValue: mockAdminBoundaryLookup,
        },
        { provide: LandUseClassifierService, useValue: mockLandUseClassifier },
        { provide: FeasibilityGateService, useValue: mockFeasibilityGate },
        { provide: AiUsageLogsService, useValue: mockUsageLogs },
        { provide: PiiRedactorService, useValue: mockPiiRedactor },
        // 2026-05-22 reconcile — N3 added WorkHistory repo injection
        // to AiService for the §1-compliant `isLaoCaller(userId)` helper.
        // N2 now (Option B) uses the same helper, so this mock drives
        // both surfaces.
        {
          provide: getRepositoryToken(WorkHistory),
          useValue: mockWorkHistoryRepo,
        },
      ],
    }).compile();
    service = module.get<AiService>(AiService);
  });

  /**
   * Returns the system-role message content from the last LLM call.
   * Throws if the LLM was never called (used as a regression signal).
   */
  const captureSystemPrompt = (): string => {
    expect(mockLlm.createChatCompletion).toHaveBeenCalledTimes(1);
    const args = mockLlm.createChatCompletion.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const sys = args.messages.find((m) => m.role === 'system');
    if (!sys) throw new Error('no system message captured');
    return sys.content;
  };

  // -------------------------------------------------------------------
  // Test 1 — ISSUE_BASED LAO regression
  // -------------------------------------------------------------------
  it('ISSUE_BASED LAO regression — STRATEGY_BASED sibling gate is NOT triggered; single-entry composer drives prompt', async () => {
    mockIssueCriteriaRegistry.findByIssueId.mockResolvedValue({
      issue: { id: 'dev-issue-1', name: 'ด้านการพัฒนาคุณภาพชีวิต' },
      entry: STRAT002_QUALITY_OF_LIFE,
    });

    await service.generateProjectDetail(
      {
        reportFormat: 'ISSUE_BASED',
        developmentIssueId: 'dev-issue-1',
        // LAO classification: any amphoe/lao that is NOT (3001 + 3001027)
        amphoeId: '3002',
        localAdministrativeOrganizationId: '3002001',
        userPrompt: 'เพิ่มกิจกรรมการเรียนรู้',
      },
      'user-1',
    );

    const sys = captureSystemPrompt();
    // ISSUE_BASED single-entry composer emits the canonical [FORMAT]
    // ISSUE_BASED line (NOT the STRATEGY_BASED multi-entry header).
    expect(sys).toContain('[FORMAT]');
    expect(sys).toContain(
      'รายงานนี้เป็น ISSUE_BASED (ประเด็นการพัฒนา)',
    );
    expect(sys).toContain('[CRITERIA]');
    expect(sys).toContain('issueKey): quality-of-life');
    // STRATEGY_BASED top-level header MUST NOT appear.
    expect(sys).not.toContain('รายงานนี้เป็น STRATEGY_BASED');
    expect(sys).not.toContain('[ISSUE_BOUNDARY]');
    // STRATEGY_BASED registry path MUST NOT have been called.
    expect(mockIssueCriteriaRegistry.findAllByStrategyName).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------
  // Test 2 — STRATEGY_BASED LAO + match=1 (STRAT002)
  // -------------------------------------------------------------------
  it('STRATEGY_BASED LAO + match=1 (STRAT002) — [CRITERIA] block injected with quality-of-life issueKey', async () => {
    mockIssueCriteriaRegistry.findAllByStrategyName.mockReturnValue([
      STRAT002_QUALITY_OF_LIFE,
    ]);

    await service.generateProjectDetail(
      {
        reportFormat: 'STRATEGY_BASED',
        strategy: 'ยุทธศาสตร์การพัฒนาคุณภาพชีวิต',
        tactic: 'กลยุทธ์ 1',
        plan: 'แผนงาน 1',
        amphoeId: '3002',
        localAdministrativeOrganizationId: '3002001',
      },
      'user-1',
    );

    const sys = captureSystemPrompt();
    expect(mockIssueCriteriaRegistry.findAllByStrategyName).toHaveBeenCalledWith(
      'ยุทธศาสตร์การพัฒนาคุณภาพชีวิต',
    );
    expect(sys).toContain('[CRITERIA]');
    // For N=1 the multi-entry composer delegates to the single-entry
    // composer verbatim — so we see the single-entry [FORMAT] line
    // (which advertises ISSUE_BASED inside the per-entry sub-block).
    expect(sys).toContain('issueKey): quality-of-life');
    expect(sys).toContain('rulesetVersion): 2026-04-18');
    // N=1 → no boundary marker, no STRATEGY_BASED top header.
    expect(sys).not.toContain('[ISSUE_BOUNDARY]');
  });

  // -------------------------------------------------------------------
  // Test 3 — STRATEGY_BASED LAO + match=2 (STRAT003)
  // -------------------------------------------------------------------
  it('STRATEGY_BASED LAO + match=2 (STRAT003) — both economic sub-blocks emitted with [ISSUE_BOUNDARY] and STRATEGY_BASED [FORMAT] header', async () => {
    mockIssueCriteriaRegistry.findAllByStrategyName.mockReturnValue([
      STRAT003_ECONOMIC_3_1,
      STRAT003_ECONOMIC_3_2,
    ]);

    await service.generateProjectDetail(
      {
        reportFormat: 'STRATEGY_BASED',
        strategy: 'ยุทธศาสตร์ด้านการพัฒนาเศรษฐกิจ',
        tactic: 'กลยุทธ์ 3',
        plan: 'แผนงาน 3',
        amphoeId: '3003',
        localAdministrativeOrganizationId: '3003001',
      },
      'user-1',
    );

    const sys = captureSystemPrompt();
    // STRATEGY_BASED multi-entry top header carries strategyName + count.
    expect(sys).toContain(
      'รายงานนี้เป็น STRATEGY_BASED (ยุทธศาสตร์)',
    );
    expect(sys).toContain('ครอบคลุม 2 ประเด็นการพัฒนา');
    expect(sys).toContain('ยุทธศาสตร์ด้านการพัฒนาเศรษฐกิจ');
    // Both per-entry sub-blocks present (issueKey identifies each).
    expect(sys).toContain('issueKey): economic-3-1');
    expect(sys).toContain('issueKey): economic-3-2');
    // Boundary marker between them.
    expect(sys).toContain('[ISSUE_BOUNDARY]');
    // Blocking criticality preserved verbatim from the registry entry.
    expect(sys).toContain('C3_1.a');
    expect(sys).toContain('(blocking)');
  });

  // -------------------------------------------------------------------
  // Test 4 — STRATEGY_BASED LAO + match=0 (STRAT005)
  // -------------------------------------------------------------------
  it('STRATEGY_BASED LAO + match=0 (STRAT005) — block silently skipped; prompt has no [CRITERIA] section', async () => {
    mockIssueCriteriaRegistry.findAllByStrategyName.mockReturnValue([]);

    await service.generateProjectDetail(
      {
        reportFormat: 'STRATEGY_BASED',
        strategy: 'ยุทธศาสตร์ที่ไม่อยู่ในทะเบียน',
        tactic: 'กลยุทธ์ 5',
        plan: 'แผนงาน 5',
        amphoeId: '3002',
        localAdministrativeOrganizationId: '3002001',
      },
      'user-1',
    );

    const sys = captureSystemPrompt();
    // Registry was consulted (gate did fire) but produced no entries.
    expect(mockIssueCriteriaRegistry.findAllByStrategyName).toHaveBeenCalledWith(
      'ยุทธศาสตร์ที่ไม่อยู่ในทะเบียน',
    );
    // Prompt MUST be byte-identical to pre-Wave for STRAT005 — no
    // criteria section, no STRATEGY_BASED header, no issue boundary.
    expect(sys).not.toContain('[CRITERIA]');
    expect(sys).not.toContain('รายงานนี้เป็น STRATEGY_BASED');
    expect(sys).not.toContain('[ISSUE_BOUNDARY]');
  });

  // -------------------------------------------------------------------
  // Test 5 — STRATEGY_BASED Agency (D4=B gating)
  // -------------------------------------------------------------------
  it('STRATEGY_BASED Agency caller — sibling gate is NOT triggered; registry MUST NOT be consulted (D4=B)', async () => {
    // Agency classification per CLAUDE.md §1: WorkHistory.amphoe.id='3001'
    // AND WorkHistory.localAdministrativeOrganization.id='3001027'.
    // 2026-05-22 — N2 now resolves via `isLaoCaller(userId)` (matches N3),
    // so the test overrides the WorkHistory mock instead of relying on
    // client DTO fields.
    mockWorkHistoryRepo.findOne.mockResolvedValue(buildAgencyWorkHistory());

    await service.generateProjectDetail(
      {
        reportFormat: 'STRATEGY_BASED',
        strategy: 'ยุทธศาสตร์การพัฒนาคุณภาพชีวิต',
        tactic: 'กลยุทธ์ 1',
        plan: 'แผนงาน 1',
      },
      'user-agency',
    );

    const sys = captureSystemPrompt();
    // Backend LAO gate (D4=B) — STRATEGY_BASED registry MUST NOT have
    // been consulted at all for agency callers.
    expect(
      mockIssueCriteriaRegistry.findAllByStrategyName,
    ).not.toHaveBeenCalled();
    // Output prompt is the byte-identical pre-Wave baseSystemPrompt.
    expect(sys).not.toContain('[CRITERIA]');
    expect(sys).not.toContain('รายงานนี้เป็น STRATEGY_BASED');
    expect(sys).not.toContain('[ISSUE_BOUNDARY]');
  });
});
