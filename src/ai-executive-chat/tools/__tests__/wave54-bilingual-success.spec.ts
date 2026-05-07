/**
 * BE-W54-08 — Bilingual success-criteria reproduction harness (QA-W54-01
 * preview). Five prompts taken VERBATIM from
 * `docs/tasks/wave54/WAVE54_DISPATCH_PLAN.md` §4.
 *
 * Wave 54 §11.4 decision: prompt #4 is HYBRID — either
 * `detectWorkflowAgingProjects` (Wave 53 preserved) OR
 * `getExecutiveDashboardSnapshot` (Wave 54) is a valid resolution.
 *
 * This is a CONTRACT test, not a behavior test. The harness:
 *   1. Declares each prompt's hand-crafted tool-call sequence
 *      (deterministic mock LLM adapter).
 *   2. Executes the chosen Tier C handler once per prompt against the
 *      project's real handler implementation with Tier B mocks.
 *   3. Asserts `toolCalls.length <= 2` (hard cap from §4 table).
 *   4. Asserts the final envelope `shape` matches the expected tag.
 *
 * Any prompt whose sequence grows beyond 2 calls MUST fail the suite.
 *
 * Token-budget check (§11.5 + no-tiktoken gap): since this repo has
 * neither `tiktoken` nor a pre-Wave-54 git baseline, we record the
 * current prompt length as a forward-looking cap. A future wave may
 * tighten this upper bound, but for Wave 54 gating we assert the
 * prompt does not regress above a 2400-byte soft ceiling around the
 * captured length — enough headroom for one small copy edit without
 * gating legitimate work.
 */
import { Logger } from '@nestjs/common';

import { EXECUTIVE_TOOL_HANDLERS } from '../handlers/executive-tool-handlers';
import {
  EXECUTIVE_TOOL_NAMES,
  EXECUTIVE_TOOL_REGISTRY,
} from '../tool-registry';
import {
  EXECUTIVE_CHAT_SYSTEM_PROMPT,
  EXECUTIVE_CHAT_TOOL_INSTRUCTIONS,
} from '../../prompts/executive-chat-system-prompt';
import {
  ExecutiveCallerContext,
  ExecutiveToolHandlerDeps,
} from '../handlers/handler-types';
import type { ExecutiveEnvelope } from '../../aggregation/types';

// Silence Nest logger so test output stays clean.
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
});

const UUID_PLAN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function makeCtx(): ExecutiveCallerContext {
  return {
    userId: 'u',
    workHistoryId: 'wh',
    roleName: 'admin',
    workStatusName: 'approved',
  };
}

/**
 * Generic Tier B mock deps. `runDimensions` short-circuits to an empty
 * envelope so the handler call resolves deterministically without
 * invoking any real aggregation.
 */
function makeDeps(): ExecutiveToolHandlerDeps {
  const runDimensions = jest.fn(
    async (
      _tasks: unknown[],
      assemble: (r: unknown[]) => unknown,
      options: { shape: string },
    ) =>
      ({
        shape: options.shape,
        data: assemble([]),
        asOf: new Date().toISOString(),
        missingDimensions: [],
        advisories: [],
        partial: false,
      }) as unknown as ExecutiveEnvelope<unknown>,
  );
  return {
    dataSource: {} as never,
    unifiedProject: {
      // Return one project so the handler can resolve reportFormat.
      listUnifiedProjects: jest.fn().mockResolvedValue([
        {
          projectKind: 'main',
          projectId: 'p-1',
          name: 'โครงการ A',
          planId: UUID_PLAN,
          planReportFormat: 'STRATEGY_BASED',
          strategyId: 's-1',
          tacticId: 't-1',
          planLevelId: 'pl-1',
          indicator: 'kpi',
          developmentIssueId: null,
          // Wave 55 W55-BE-07 — required field; bilingual success test
          // does not branch on it so the fixture uses the safe default.
          originType: 'lao-coordinated',
        },
      ]),
    } as never,
    budget: {
      totalsForUnifiedProjects: jest.fn().mockResolvedValue(new Map()),
    } as never,
    status: {
      latestStatusFor: jest.fn().mockResolvedValue(new Map()),
    } as never,
    geo: {
      annotate: jest.fn().mockResolvedValue({
        labels: new Map(),
        missingDimensions: [],
        advisories: [],
      }),
    } as never,
    agency: {
      annotate: jest.fn().mockResolvedValue({
        labels: new Map(),
        missingDimensions: [],
        advisories: [],
      }),
    } as never,
    resilience: { runDimensions } as never,
  };
}

/**
 * Tool-call record — emulates the transcript the LLM WOULD produce
 * for each prompt. `listActivePlans` is listed as an optional hop-1
 * lookup, but this contract test does not need to execute it; we only
 * assert the COUNT (<= 2) and that the final Tier C tool produces an
 * envelope with the expected shape.
 */
type ToolCall = {
  tool: string;
  /** Params the LLM would provide — shape-checked against registry. */
  params: Record<string, unknown>;
};

type Prompt = {
  id: number;
  thai: string;
  english: string;
  toolCalls: ToolCall[];
  /**
   * Prompt #4 accepts EITHER tool. `expectedShapeRx` matches the final
   * envelope's shape field; for prompt #4 we use a regex that allows
   * both outcomes (Wave 53 aging tool → no shape field is emitted by
   * the legacy tool, but the Wave 54 dashboard returns
   * 'dashboardSnapshot'). The harness only enforces the shape when
   * `expectedShape` is set; prompt #4 relies on `finalToolNameRx`.
   */
  expectedShape?: string;
  finalToolNameRx: RegExp;
};

const PROMPTS: Prompt[] = [
  {
    id: 1,
    thai: 'โครงการในเล่มแก้ไขปีนี้มีอะไรบ้าง',
    english: 'What are the projects in this year’s revision book?',
    toolCalls: [
      { tool: 'listActivePlans', params: {} },
      {
        tool: 'getPlanOverview',
        params: { planId: UUID_PLAN, scope: ['revision'] },
      },
    ],
    expectedShape: 'planOverview',
    finalToolNameRx: /^getPlanOverview$/,
  },
  {
    id: 2,
    thai: 'งบประมาณรวมของทุกเล่มในแผนนี้เท่าไร',
    english: 'What is the total budget across all books in this plan?',
    toolCalls: [
      { tool: 'listActivePlans', params: {} },
      {
        tool: 'getPlanOverview',
        params: { planId: UUID_PLAN, scope: ['all'], includeBudget: true },
      },
    ],
    expectedShape: 'planOverview',
    finalToolNameRx: /^getPlanOverview$/,
  },
  {
    id: 3,
    thai: 'อำเภอไหนมีโครงการมากที่สุด',
    english: 'Which amphoe has the most projects?',
    toolCalls: [
      {
        tool: 'getExecutiveDashboardSnapshot',
        params: {
          scope: ['all'],
          includeGeo: true,
          groupBy: ['amphoe'],
        },
      },
    ],
    expectedShape: 'dashboardSnapshot',
    finalToolNameRx: /^getExecutiveDashboardSnapshot$/,
  },
  {
    id: 4,
    thai: 'โครงการที่ค้างนานผิดปกติคืออะไร',
    english: 'Which projects are stuck abnormally long?',
    // HYBRID per §11.4 — either tool is acceptable. We pick the
    // Wave 54 dashboard variant for deterministic shape assertion,
    // but the `finalToolNameRx` tolerates either.
    toolCalls: [
      {
        tool: 'getExecutiveDashboardSnapshot',
        params: {
          scope: ['all'],
          includeStatus: true,
          groupBy: ['status'],
        },
      },
    ],
    expectedShape: 'dashboardSnapshot',
    finalToolNameRx:
      /^(detectWorkflowAgingProjects|getExecutiveDashboardSnapshot)$/,
  },
  {
    id: 5,
    thai: 'แผนนี้อยู่ในยุทธศาสตร์อะไร',
    english: 'Which strategy does this plan belong to?',
    toolCalls: [
      { tool: 'listActivePlans', params: {} },
      {
        tool: 'getPlanOverview',
        params: {
          planId: UUID_PLAN,
          scope: ['all'],
          includeClassification: true,
        },
      },
    ],
    expectedShape: 'planOverview',
    finalToolNameRx: /^getPlanOverview$/,
  },
];

describe('BE-W54-08 / Wave 54 bilingual success-criteria prompts (§4)', () => {
  describe('registry parity — every tool referenced in the prompt table is registered', () => {
    const referenced = new Set<string>();
    for (const p of PROMPTS) {
      for (const c of p.toolCalls) referenced.add(c.tool);
    }
    // Prompt #4 alt path — also assert the aging tool exists.
    referenced.add('detectWorkflowAgingProjects');

    it.each([...referenced])('%s is in EXECUTIVE_TOOL_NAMES', (name) => {
      expect(EXECUTIVE_TOOL_NAMES).toContain(name);
      expect(
        EXECUTIVE_TOOL_REGISTRY[name as keyof typeof EXECUTIVE_TOOL_REGISTRY],
      ).toBeDefined();
    });
  });

  describe('each prompt resolves in <= 2 tool calls (§4 hard cap)', () => {
    it.each(PROMPTS.map((p) => [p.id, p.thai, p]))(
      '#%s — %s',
      async (_id, _thai, p) => {
        const prompt = p;
        expect(prompt.toolCalls.length).toBeLessThanOrEqual(2);
        expect(prompt.toolCalls.length).toBeGreaterThanOrEqual(1);
        const finalCall = prompt.toolCalls[prompt.toolCalls.length - 1];
        expect(finalCall.tool).toMatch(prompt.finalToolNameRx);
      },
    );
  });

  describe('each prompt final Tier C tool produces the expected envelope shape', () => {
    it.each(PROMPTS.filter((p) => p.expectedShape))(
      '#$id — final tool returns shape=$expectedShape',
      async (p) => {
        const finalCall = p.toolCalls[p.toolCalls.length - 1];
        const handler =
          EXECUTIVE_TOOL_HANDLERS[
            finalCall.tool as keyof typeof EXECUTIVE_TOOL_HANDLERS
          ];
        expect(typeof handler).toBe('function');
        const env = (await handler(
          finalCall.params,
          makeCtx(),
          makeDeps(),
        )) as unknown as ExecutiveEnvelope<unknown>;
        expect(env.shape).toBe(p.expectedShape);
        expect(Array.isArray(env.missingDimensions)).toBe(true);
        expect(Array.isArray(env.advisories)).toBe(true);
        expect(typeof env.partial).toBe('boolean');
      },
    );
  });

  describe('bilingual coverage — both Thai and English variants recorded', () => {
    it.each(PROMPTS)('#$id prompt has both Thai and English captured', (p) => {
      expect(p.thai.length).toBeGreaterThan(0);
      expect(p.english.length).toBeGreaterThan(0);
      // Thai prompts MUST be the verbatim §4 source — sanity-check
      // that the prompt contains at least one Thai codepoint.
      expect(/[\u0E00-\u0E7F]/.test(p.thai)).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Token-budget check — char-count proxy.
  //
  // The repo has no `tiktoken` dep and no git baseline for the Wave 53
  // system prompt, so we snapshot the CURRENT length and enforce a
  // forward-looking cap. 2400 extra chars ≈ 600 tokens of headroom,
  // matching the spec's "<= baseline + 600 tokens" rule.
  // ─────────────────────────────────────────────────────────────────
  describe('system prompt + tool instructions — token budget (char proxy)', () => {
    // Hard forward-looking cap. No `tiktoken` and no git baseline, so we
    // pin a byte ceiling that leaves ~600 tokens (≈ 2400 chars) of
    // headroom above the post-update length. Any future wave that grows
    // the prompt beyond this cap MUST bump this constant deliberately —
    // the check is here to catch accidental regressions.
    //
    // Wave 54 baseline: 8000 (≈ 600 tokens headroom over W54 post-update).
    // Wave 57 bump: 14000. W57-BE-PROMPT-01 added 13 routing rules
    // (#14–#26: DPR-as-book disambiguation, default province scope,
    // fiscal year, status rollup, HEAD-only disclosure, reportFormat-
    // first classification, dual-bucket fallback, project-own
    // attribution for amphoe/lao/responsibleAgency). Post-W57 length
    // ~11.8 KB; 14 KB cap leaves ~600 tokens headroom for further rule
    // additions before the prompt MUST be split into per-turn
    // tool-instruction injections (§W57 risk note).
    // Wave 58 bump: 16384. W58-BE-PROMPT-01a added rules #27a–#27d
    // (raw-enum suppression, agency-name attribution, revision-round
    // grouping, cross-turn plan continuity) plus tool-description
    // disclosure of the new Wave 58 envelope fields. Bump credited to
    // Wave 58 to keep ~600 tokens of headroom for the planned #28
    // plan-status vocabulary lock (W58-BE-PROMPT-01b).
    // Wave 58 bump (W58-BE-PROMPT-01b): 18432. Adds rule #27e (page-
    // number disclosure) + rule #28 (Option B two-badge plan-status
    // vocabulary lock) + tool-description envelope disclosure for
    // planActivityStatus and pageNumber. ~2 KB net growth; cap raised
    // to keep ~600-token headroom.
    // Wave 59 bump (W59-BE-PROMPT-01): 20480. Adds rule #27f (D-B
    // objective disclosure with 200-char truncation), rule #27g (D-C
    // location triple — amphoeName / laoName / geoCoordinates), and
    // rule #29 (D-A listActivePlans default scope flip — all books,
    // latestOnly opt-in) + tool-description envelope disclosure for
    // objective/objectiveTruncated/amphoeName/laoName/geoCoordinates
    // and the listActivePlans default-scope flip. ~2 KB net growth;
    // cap raised 18432 → 20480 to keep ~600-token headroom.
    // Wave 60 bump (rule #30 verbose-mode default): 23552. Adds rule #30
    // (default project-bullet shape — verbose mode opt-in, restricts
    // optional fields like objective/location/classification from being
    // emitted by default) + rewrite of #27f to be DEFAULT-OFF. ~1.4 KB
    // net growth; cap raised 20480 → 23552 to keep ~600-token headroom.
    // Wave 60b bump (rule #31 book-completeness mode): 25600. Adds rule
    // #31 (groupBy='byBookCompleteness' vs 'byRevisionRound' selector
    // for listProjectsInPlan) + tool-description envelope disclosure for
    // the new groupBy modes + per-item isHead flag. ~1.8 KB net growth;
    // cap raised 23552 → 25600 to keep ~600-token headroom.
    // Wave 62 bump (rules #36 + #37): 36864. Adds rule #36 (HEAD-only
    // default + timeline/verbose disambiguation: ทุก+(รอบ|เวอร์ชัน) →
    // TIMELINE, otherwise VERBOSE; expanded trigger word lists) and
    // rule #37 (format-aware verbose render — STRATEGY_BASED ตัวชี้วัด /
    // ISSUE_BASED ประเด็นการพัฒนา + goal/expected/indicator/
    // developmentIssueLabel envelope disclosure on listProjectsInPlan).
    // ~3.5 KB net growth; cap raised 32768 → 36864 to keep ~600-token
    // headroom.
    // Wave 66 bump (W66-BE-PROMPT-01): 45056. Adds rule #27h
    // (cross-turn count continuity), rule #38 (NULL responsibleAgency
    // hard routing → listProjectsWithoutResponsibleAgency), and rule
    // #38b (forbid envelope-field prose translation — `inReviewCount`
    // ≠ "รอแก้ไข") + tool-description cross-reference on
    // getTeamWorkloadSummary. ~3 KB net growth; cap raised
    // 40960 → 45056 to keep ~600-token headroom.
    // Wave 67 bump (W67-PROMPT-RULE-39): 49152. Adds rule #39
    // (status drill-down render template — opt-in via trigger words
    // "แยกเล่ม" / "รายชื่อ" / "ละเอียด" / etc.; renders book × sub-book
    // × status group × project list from new envelope field
    // `data.statusBreakdownByBook`). Also adds the W67 vocabulary
    // refresh in rules #11 / #11b (8-status canonical incl. Rejected,
    // executiveStatus 4-group view) and the rule #16 disambiguation
    // (รออนุมัติ excludes Pending). ~1.5 KB net growth; cap raised
    // 45056 → 49152 to keep ~650-token headroom.
    // Wave 67 bump (W67-FIX-C): 51200. Extends rule #39 with
    // per-project context annotation (`บรรจุในเล่ม X หน้า N`) and
    // cross-lineage trail (`* บรรจุในเล่ม Y หน้า M (เชื่อมโยงด้วย FK |
    // ชื่อโครงการ)`). Adds new rule #40 — always-on
    // "ข้อเสนอแนะเพิ่มเติม:" follow-up suggestions block (2-3 questions
    // per turn; "?" form mandatory; §17.2 advisory-only). ~330-byte
    // net growth measured (49480 - 49152 = 328); cap raised
    // 49152 → 51200 to keep ~430-token headroom.
    // Wave 67 bump (W67-AMPHOE-FIX-PROMPT-01, Path A): 53248. Adds
    // rule #25a (listAmphoes resolver mandatory before any
    // filters.amphoeIds — closes the "0 บาท" zero-results regression
    // where the LLM sent Thai literals like ["อำเภอเมืองนครราชสีมา"]
    // verbatim) plus a one-line listAmphoes entry in
    // EXECUTIVE_CHAT_TOOL_INSTRUCTIONS. ~800-byte net growth; cap
    // raised 51200 → 53248 to keep ~600-token headroom.
    // Wave 67 bump (W67-LAO-RESOLVER): 55296. Adds rule #25b
    // (listLaos resolver mandatory before any filters.laoIds —
    // mirror of #25a; chains listAmphoes → listLaos for "อปท ใน
    // [อำเภอ X]" queries; bans Thai literals as laoIds) plus a
    // one-line listLaos entry in EXECUTIVE_CHAT_TOOL_INSTRUCTIONS.
    // ~700-byte net growth; cap raised 53248 → 55296 to keep
    // ~600-token headroom.
    // Wave 67 bump (W67-PAO-EXEC-STAGE + COORDINATOR-LAO + AGENCY-
    // RESOLVER, 2026-04-27): 57344. Credits rule #25c v3 rewrite
    // (project-LAO → execution-stage semantic with
    // hasResponsibleAgency + isBooked filters), rule #39 extension
    // for coordinatorLaoName per-project annotation, and the new
    // rule #25d (listAgencies resolver mandatory before
    // filters.agencyIds; closes the "ขอดูโครงการของกองยุทธ" gap).
    // ~2 KB net growth across these three sub-waves; cap raised
    // 55296 → 57344 to keep ~600-token headroom.
    // W68-FIX-03 (2026-04-28): cap raised 57344 → 59392 to credit
    // rule #12a (INVALID_TOOL_INPUT recovery — tells LLM to retry
    // tool calls when args fail schema validation, especially
    // gpt-4o-mini sending plan names instead of UUIDs). ~750-byte
    // net growth; ~600-token headroom preserved.
    // W68-FIX-04 (2026-04-28): cap raised 59392 → 62464 to credit
    // (a) rule #25d strong rewrite — verbatim 10-row synonym table
    // (กองยุทธ/คลัง/ปลัด/กจ/ช่าง/สวัสดิ/เลขา/ศึกษา/ตรวจสอบ/สาธารณสุข
    // canonical names + aliases), MANDATORY tag, "ห้าม skip
    // listAgencies hop", production-regression negative example, and
    // Q5 prompt-side self-check (server-side advisory equivalent);
    // (b) NEW rule #41 — count-first preamble mandating "พบ N {หน่วย}"
    // line before any list / breakdown / drill / detail / projects
    // render. Net growth ~2.5 KB; cap raised 59392 → 62464 to keep
    // ~600-token headroom.
    // W68-FIX-09 (2026-04-28): cap raised 62464 → 64512 to credit
    // rule #39 strengthening — extended trigger word list, MANDATORY
    // language, and negative example for the "ดูรายชื่อ" regression.
    // Net growth ~500 bytes; ~600-token headroom preserved.
    // W68-FIX-11 (2026-04-28): cap raised 64512 → 67584 to credit rule
    // #25b Path A type-aware lookup with fallback + listLaos `type` param
    // disclosure in tool catalog. ~1.5KB net growth across both surfaces.
    // W71-BE-PROMPT-01 (2026-04-28): cap raised 67584 → 70656 to credit
    // rule #39 W71 per-project budget annotation block (MANDATORY budget
    // render between `หน้า {pageNumber}` and optional `ประสานจาก: ...`,
    // FORBIDDEN-strings list, zero-budget literal `ไม่มีงบประมาณ` rule,
    // anti-prose-translation lock extension for `projects[i].budget`,
    // plus the two render-template lines extended with
    // `| งบประมาณ: {projects[i].budgetText}`). ~2KB net growth; cap
    // raised 67584 → 70656 to keep ~600-token headroom. Pairs with
    // W71-BE-PROJECT-BUDGET (aggregator change).
    const TOTAL_BYTES_CAP = 70656;

    const PROMPT_BYTES = EXECUTIVE_CHAT_SYSTEM_PROMPT.length;
    const TOOLS_BYTES = EXECUTIVE_CHAT_TOOL_INSTRUCTIONS.length;
    const TOTAL_BYTES = PROMPT_BYTES + TOOLS_BYTES;

    it(`current system prompt + tool instructions are below ${TOTAL_BYTES_CAP} chars`, () => {
      expect(TOTAL_BYTES).toBeLessThanOrEqual(TOTAL_BYTES_CAP);
    });

    it('current system prompt is non-empty and bilingual-aware', () => {
      expect(PROMPT_BYTES).toBeGreaterThan(100);
      expect(TOOLS_BYTES).toBeGreaterThan(100);
      // The Thai-reply rule MUST be present (§17 framing).
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/ภาษาไทย/);
    });

    it('tool-instructions reference Wave 54 Tier C tools', () => {
      expect(EXECUTIVE_CHAT_TOOL_INSTRUCTIONS).toContain('getPlanOverview');
      expect(EXECUTIVE_CHAT_TOOL_INSTRUCTIONS).toContain(
        'getExecutiveDashboardSnapshot',
      );
      expect(EXECUTIVE_CHAT_TOOL_INSTRUCTIONS).toContain(
        'getCrossPlanInsights',
      );
    });
  });
});
