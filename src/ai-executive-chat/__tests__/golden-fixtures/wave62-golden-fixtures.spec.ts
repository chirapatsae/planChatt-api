/**
 * Wave 62 W62-QA-01 — Golden fixture suite covering the five W62 deltas:
 *
 *   Q-G20 — HEAD-only default for single-project lookup.
 *           The system prompt MUST instruct the LLM to render only the
 *           HEAD row (filtered to `isHead === true`) and append a hint
 *           line `"มีทั้งหมด N รอบการแก้ไข — ขอ 'ไทม์ไลน์' เพื่อดูทุกรอบ"`
 *           when the lineage has multiple rounds. (Rule #36 — system
 *           prompt regression.)
 *
 *   Q-G21 — Timeline-trigger fall-through. Trigger words "ทุกรอบ" /
 *           "ทุกเวอร์ชัน" / "ไทม์ไลน์" / "ประวัติทั้งหมด" / "ทุกเล่ม" route
 *           to lineage tools (getProjectLineage / Mode A book
 *           completeness), NOT to the single-card render path.
 *           (Rule #36 + Rule #34 — disambiguation rule.)
 *
 *   Q-G22 — Verbose-trigger expansion. Trigger words "รายละเอียดทั้งหมด" /
 *           "full detail" join the existing verbose vocabulary and route
 *           to the format-aware verbose render. (Rule #36 + Rule #30.)
 *
 *   Q-G23 — STRATEGY_BASED format-aware envelope. A row whose parent
 *           plan is STRATEGY_BASED MUST emit `indicator` populated +
 *           `developmentIssueLabel: null`. (§16.5 / §17.7, Rule #37.)
 *
 *   Q-G24 — ISSUE_BASED format-aware envelope. A row whose parent plan
 *           is ISSUE_BASED MUST emit `developmentIssueLabel` populated +
 *           `indicator: null`. (§16.5 / §17.7, Rule #37.)
 *
 * Strategy:
 *   - Q-G20 / Q-G21 / Q-G22 are PROMPT-TEXT REGRESSION specs — they
 *     assert that the canonical system prompt carries the rule strings
 *     and trigger vocabulary verbatim. Pinned via `toContain` so the
 *     specs never depend on LLM nondeterminism (matches the
 *     fixture-strategy described in `docs/tasks/wave62/W62-QA-01.md`
 *     §11.E1 — "asserts on the prompt INPUT").
 *
 *   - Q-G23 / Q-G24 are ENVELOPE-SHAPE specs against the
 *     `buildProjectEntry()` end-to-end pipeline as exercised by
 *     `listProjectsInPlan` with a mocked `getRawMany`. These specs run
 *     the actual production path so any regression in
 *     `coerceReportFormat` / format-branching triggers a failure.
 *
 * §17 compliance:
 *   - §17.2 advisory only — every assertion is read-only.
 *   - §17.3 audit separation — no writes.
 *   - §17.7 — Q-G23 / Q-G24 exercise the format branching at the
 *     envelope assembler.
 *   - §17.9 — Thai literals are static (anchored on
 *     `EXECUTIVE_CHAT_SYSTEM_PROMPT` exports).
 *   - §17.11 — `makeCtx()` produces a `staff` role.
 *
 * Wave 54 no-raw-SQL gate:
 *   - These specs do NOT introduce raw SQL. Mocks intercept the
 *     query-builder chain entirely.
 */

import { EXECUTIVE_TOOL_HANDLERS } from '../../tools/handlers/executive-tool-handlers';
import { EXECUTIVE_CHAT_SYSTEM_PROMPT } from '../../prompts/executive-chat-system-prompt';
import {
  ExecutiveCallerContext,
  ExecutiveToolHandlerDeps,
} from '../../tools/handlers/handler-types';

// ─────────────────────────────────────────────────────────────────────
// UUID constants — co-prime with the W57 / W60 fixture trees.
// ─────────────────────────────────────────────────────────────────────

const UUID_PLAN_STRATEGY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const UUID_PLAN_ISSUE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const UUID_PG_STRATEGY = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const UUID_PG_ISSUE = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function makeCtx(): ExecutiveCallerContext {
  return {
    userId: 'user-w62-qa01',
    workHistoryId: 'wh-w62-qa01',
    roleName: 'staff',
    workStatusName: 'approved',
  };
}

// ─────────────────────────────────────────────────────────────────────
// Mock raw-row factory — mirrors the
// `tools/__tests__/list-projects-in-plan.spec.ts` pattern. Each entry is
// the union of fields the handler's `addSelect` projection emits for the
// PG branch (W62-BE-AGG-02 extended set).
// ─────────────────────────────────────────────────────────────────────

interface FakeMainRow {
  pgid: string;
  title: string;
  statusname: string | null;
  amphoeid: number | null;
  agencyid: number | null;
  agencyname: string | null;
  creatoramphoeid: number | null;
  creatorlaoid: number | null;
  budget: string | null;
  pagenumber: number | null;
  objective: string | null;
  amphoename: string | null;
  laoname: string | null;
  startlat: number | string | null;
  startlng: number | string | null;
  endlat: number | string | null;
  endlng: number | string | null;
  goal: string | null;
  expected: string | null;
  indicator: string | null;
  developmentissuename: string | null;
  reportformat: string | null;
}

function makeDeps(rows: FakeMainRow[]): ExecutiveToolHandlerDeps {
  const qb: Record<string, unknown> = {};
  const chain = () => qb;
  Object.assign(qb, {
    select: chain,
    addSelect: chain,
    leftJoin: chain,
    innerJoin: chain,
    from: chain,
    where: chain,
    andWhere: chain,
    orderBy: chain,
    addOrderBy: chain,
    groupBy: chain,
    addGroupBy: chain,
    limit: chain,
    take: chain,
    getRawMany: async () => rows,
  });
  return {
    dataSource: {
      getRepository: () => ({
        createQueryBuilder: () => qb,
      }),
    } as unknown as ExecutiveToolHandlerDeps['dataSource'],
    unifiedProject: {} as never,
    budget: {} as never,
    status: {} as never,
    geo: {} as never,
    agency: {} as never,
    resilience: {} as never,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Spec body
// ─────────────────────────────────────────────────────────────────────

describe('Wave 62 W62-QA-01 / golden fixture suite', () => {
  // ───────────────────────────────────────────────────────────────
  // Q-G20 — HEAD-only default + multi-round hint line.
  // Asserts the rule #36 prompt body carries the HEAD-only doctrine
  // and the canonical Thai hint string.
  // ───────────────────────────────────────────────────────────────
  describe('Q-G20 — HEAD-only default single-card render (rule #36)', () => {
    it('rule #36 mandates HEAD-only filter for single-project lookup', () => {
      // The exact directive must be present so a reviewer can grep for
      // it in regression checks.
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('isHead === true');
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain(
        'render เฉพาะ HEAD-of-lineage row',
      );
    });

    it('rule #36 emits the canonical multi-round hint line', () => {
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain(
        "มีทั้งหมด N รอบการแก้ไข — ขอ 'ไทม์ไลน์' เพื่อดูทุกรอบ",
      );
    });

    it('rule #36 documents the §14 lineage immutability rationale', () => {
      // The rationale block ties the HEAD-only behavior to §14, which
      // is the integrity invariant — not a UI choice.
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('§14');
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('Lineage Immutability');
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Q-G21 — Timeline-trigger fall-through. The disambiguation rule
  // ("ทุก" + ("รอบ" | "เวอร์ชัน") → TIMELINE) MUST be verbatim in the
  // prompt, plus the new Wave 62 trigger vocabulary.
  // ───────────────────────────────────────────────────────────────
  describe('Q-G21 — Timeline-trigger fall-through (rule #36 / #34)', () => {
    it('rule #36 carries the Wave 62 timeline trigger vocabulary', () => {
      // Each trigger word must appear at least once.
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('"ทุกรอบ"');
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('"ทุกเวอร์ชัน"');
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('"ประวัติทั้งหมด"');
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('"ทุกเล่ม"');
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('"ทุกรอบแก้ไข"');
    });

    it('rule #36 carries the EXPLICIT DISAMBIGUATION RULE', () => {
      // The disambiguation rule is the load-bearing assertion — without
      // it the LLM conflates "ทุกคอลัม" (verbose) with "ทุกรอบ"
      // (timeline) and breaks the user-feedback contract that drove
      // Wave 62.
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain(
        'EXPLICIT DISAMBIGUATION RULE',
      );
      // The two-arm rule body must be emitted verbatim.
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('TIMELINE mode');
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('VERBOSE mode');
    });

    it('rule #36 documents both positive and negative examples', () => {
      // Positive: "ทุกรอบ" → TIMELINE.
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(
        /ขอข้อมูลโครงการ X ทุกรอบ.*TIMELINE/u,
      );
      // Negative: "ทุกคอลัมน์" → VERBOSE (not timeline).
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(
        /ขอข้อมูลโครงการ X ทุกคอลัมน์.*VERBOSE/u,
      );
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Q-G22 — Verbose-trigger expansion. The new triggers
  // ("รายละเอียดทั้งหมด" / "full detail") MUST be in the verbose
  // vocabulary list.
  // ───────────────────────────────────────────────────────────────
  describe('Q-G22 — Verbose-trigger expansion (rule #36 / #30)', () => {
    it('rule #36 carries the Wave 62 verbose trigger vocabulary', () => {
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('"รายละเอียดทั้งหมด"');
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('"full detail"');
    });

    it('rule #36 retains the existing verbose triggers (regression)', () => {
      // Wave 62 ADDS to the list; pre-existing triggers must remain.
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('"ทุกคอลัมน์"');
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('"ทุกฟิลด์"');
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('"พร้อมรายละเอียด"');
    });

    it('rule #37 enumerates the verbose-mode field-label table', () => {
      // The Thai labels in the table must remain stable — any
      // change requires a CLAUDE.md §16.9 revision.
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('วัตถุประสงค์');
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('เป้าหมาย');
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('ผลที่คาดว่าจะได้รับ');
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('ตัวชี้วัด');
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('ประเด็นการพัฒนา');
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Q-G23 — STRATEGY_BASED format-aware envelope. The handler's
  // `buildProjectEntry()` MUST emit `indicator` populated + the
  // `developmentIssueLabel` field collapsed to null even though the
  // raw row carries a developmentissuename (defensive against §16.5
  // legacy drift).
  // ───────────────────────────────────────────────────────────────
  describe('Q-G23 — STRATEGY_BASED format-aware envelope (rule #37)', () => {
    it('emits indicator populated and developmentIssueLabel:null', async () => {
      const handler = EXECUTIVE_TOOL_HANDLERS.listProjectsInPlan;
      const deps = makeDeps([
        {
          pgid: UUID_PG_STRATEGY,
          title: 'โครงการกลยุทธ์',
          statusname: 'Approved',
          amphoeid: 3001,
          agencyid: 5001,
          agencyname: 'อบจ.นครราชสีมา',
          creatoramphoeid: 3001,
          creatorlaoid: 3001027,
          budget: '1500000',
          pagenumber: 12,
          objective: 'พัฒนาเศรษฐกิจชุมชน',
          amphoename: 'อำเภอเมืองนครราชสีมา',
          laoname: 'อบต. หนองบัวศาลา',
          startlat: 14.97,
          startlng: 102.07,
          endlat: null,
          endlng: null,
          goal: 'เพิ่มรายได้ครัวเรือน 10%',
          expected: 'ครัวเรือนเข้าถึงตลาดเพิ่มขึ้น',
          indicator: 'จำนวนครัวเรือนที่เข้าร่วม',
          // §16.5 drift simulation — even if a legacy ISSUE label is
          // present in the JOIN result, the handler MUST collapse it
          // because reportFormat='STRATEGY_BASED'.
          developmentissuename: 'ประเด็นเก่าที่ไม่ควรปรากฏ',
          reportformat: 'STRATEGY_BASED',
        },
      ]);

      const out = await handler(
        { planId: UUID_PLAN_STRATEGY, groupBy: 'flat' },
        makeCtx(),
        deps,
      );
      const items = (out.items as Array<Record<string, unknown>>) ?? [];
      expect(items).toHaveLength(1);
      const row = items[0];

      // §17.7 + §16.5 invariant — indicator populated.
      expect(row.indicator).toBe('จำนวนครัวเรือนที่เข้าร่วม');
      // §16.5 invariant — developmentIssueLabel collapsed to null even
      // though the raw row carried data.
      expect(row.developmentIssueLabel).toBeNull();

      // Wave 62 W62-BE-AGG-01 — the four new always-present keys.
      expect(row.goal).toBe('เพิ่มรายได้ครัวเรือน 10%');
      expect(row.goalTruncated).toBe(false);
      expect(row.expected).toBe('ครัวเรือนเข้าถึงตลาดเพิ่มขึ้น');
      expect(row.expectedTruncated).toBe(false);
    });

    it('truncates goal/expected at 500 chars (W59 truncateObjective reuse)', async () => {
      const handler = EXECUTIVE_TOOL_HANDLERS.listProjectsInPlan;
      const longText = 'ก'.repeat(700);
      const deps = makeDeps([
        {
          pgid: UUID_PG_STRATEGY,
          title: 'โครงการ goal-long',
          statusname: 'Approved',
          amphoeid: 3001,
          agencyid: null,
          agencyname: null,
          creatoramphoeid: 3001,
          creatorlaoid: 3001027,
          budget: '0',
          pagenumber: null,
          objective: null,
          amphoename: null,
          laoname: null,
          startlat: null,
          startlng: null,
          endlat: null,
          endlng: null,
          goal: longText,
          expected: longText,
          indicator: 'kpi-x',
          developmentissuename: null,
          reportformat: 'STRATEGY_BASED',
        },
      ]);
      const out = await handler(
        { planId: UUID_PLAN_STRATEGY, groupBy: 'flat' },
        makeCtx(),
        deps,
      );
      const row = (out.items as Array<Record<string, unknown>>)[0];
      // W59 truncateObjective caps at 500 chars and sets the boolean
      // `truncated` flag (no ellipsis appended per AGG-01 findings).
      expect(typeof row.goal).toBe('string');
      expect((row.goal as string).length).toBeLessThanOrEqual(500);
      expect(row.goalTruncated).toBe(true);
      expect((row.expected as string).length).toBeLessThanOrEqual(500);
      expect(row.expectedTruncated).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Q-G24 — ISSUE_BASED format-aware envelope. The mirror case:
  // `developmentIssueLabel` populated, `indicator` collapsed to null
  // even if the raw row carries indicator data.
  // ───────────────────────────────────────────────────────────────
  describe('Q-G24 — ISSUE_BASED format-aware envelope (rule #37)', () => {
    it('emits developmentIssueLabel populated and indicator:null', async () => {
      const handler = EXECUTIVE_TOOL_HANDLERS.listProjectsInPlan;
      const deps = makeDeps([
        {
          pgid: UUID_PG_ISSUE,
          title: 'โครงการประเด็น',
          statusname: 'Approved',
          amphoeid: 3001,
          agencyid: 5001,
          agencyname: 'อบจ.นครราชสีมา',
          creatoramphoeid: 3001,
          creatorlaoid: 3001027,
          budget: '500000',
          pagenumber: 5,
          objective: 'ลดภาวะยากจน',
          amphoename: 'อำเภอเมืองนครราชสีมา',
          laoname: 'อบต. โพธิ์กลาง',
          startlat: null,
          startlng: null,
          endlat: null,
          endlng: null,
          goal: 'ลดสัดส่วนคนยากจน 5%',
          expected: 'คุณภาพชีวิตชุมชนดีขึ้น',
          // §16.5 drift simulation — legacy indicator value MUST be
          // suppressed because reportFormat='ISSUE_BASED'.
          indicator: 'KPI-เก่าที่ไม่ควรปรากฏ',
          developmentissuename: 'ประเด็นที่ 1 — สังคมเข้มแข็ง',
          reportformat: 'ISSUE_BASED',
        },
      ]);

      const out = await handler(
        { planId: UUID_PLAN_ISSUE, groupBy: 'flat' },
        makeCtx(),
        deps,
      );
      const items = (out.items as Array<Record<string, unknown>>) ?? [];
      expect(items).toHaveLength(1);
      const row = items[0];

      // §17.7 + §16.5 invariant — developmentIssueLabel populated.
      expect(row.developmentIssueLabel).toBe('ประเด็นที่ 1 — สังคมเข้มแข็ง');
      // §16.5 invariant — indicator collapsed to null.
      expect(row.indicator).toBeNull();

      // The other extended fields stay format-agnostic.
      expect(row.goal).toBe('ลดสัดส่วนคนยากจน 5%');
      expect(row.expected).toBe('คุณภาพชีวิตชุมชนดีขึ้น');
    });

    it('collapses BOTH indicator and developmentIssueLabel to null when reportFormat is missing', async () => {
      const handler = EXECUTIVE_TOOL_HANDLERS.listProjectsInPlan;
      const deps = makeDeps([
        {
          pgid: UUID_PG_ISSUE,
          title: 'โครงการ legacy',
          statusname: 'Approved',
          amphoeid: 3001,
          agencyid: null,
          agencyname: null,
          creatoramphoeid: 3001,
          creatorlaoid: 3001027,
          budget: '0',
          pagenumber: null,
          objective: null,
          amphoename: null,
          laoname: null,
          startlat: null,
          startlng: null,
          endlat: null,
          endlng: null,
          goal: null,
          expected: null,
          indicator: 'kpi-x',
          developmentissuename: 'issue-x',
          // Missing parent plan / legacy data → coerceReportFormat → null
          reportformat: null,
        },
      ]);
      const out = await handler(
        { planId: UUID_PLAN_ISSUE, groupBy: 'flat' },
        makeCtx(),
        deps,
      );
      const row = (out.items as Array<Record<string, unknown>>)[0];
      // Defensive null when reportFormat cannot be resolved.
      expect(row.indicator).toBeNull();
      expect(row.developmentIssueLabel).toBeNull();
    });

    it('rule #37 contains the format-branching DO-NOT directives', () => {
      // The DO NOT block is the load-bearing assertion that prevents
      // the LLM from cross-rendering ตัวชี้วัด on an ISSUE_BASED row
      // (and vice versa).
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain(
        'DO NOT** render `ตัวชี้วัด` (indicator) สำหรับ row ที่อยู่ในแผน ISSUE_BASED',
      );
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain(
        'DO NOT** render `ประเด็นการพัฒนา` (developmentIssueLabel) สำหรับ row ที่อยู่ในแผน STRATEGY_BASED',
      );
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Cross-cutting — Wave 62 §17 compliance regressions.
  // ───────────────────────────────────────────────────────────────
  describe('Wave 62 cross-cutting §17 invariants', () => {
    it('§17.7 rule #37 explicitly references reportFormatLabel branching', () => {
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('reportFormatLabel');
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('แบบยุทธศาสตร์');
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('แบบประเด็นการพัฒนา');
    });

    it('rule #37 enforces null-omit discipline (no "ไม่ระบุ" placeholder)', () => {
      // Per §17.10 / W59 — null fields MUST be omitted entirely; the
      // anti-pattern is rendering "วัตถุประสงค์: -" or "ตัวชี้วัด: ไม่ระบุ".
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('omit ทั้งบรรทัด');
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('silence is correct');
    });
  });
});
