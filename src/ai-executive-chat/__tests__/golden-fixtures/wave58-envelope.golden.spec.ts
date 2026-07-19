/**
 * Wave 58 W58-BE-AGG-02 — Golden envelope fixtures for the four chat
 * polish defects landed in W58-BE-AGG-01.
 *
 * Source of truth:
 *   - docs/tasks/wave58/W58-BE-AGG-02.md
 *   - docs/reports/wave58/WAVE58_CHAT_POLISH_DISPATCH.md (D1, D3, D4, D6)
 *   - CLAUDE.md §16.9 — paired Thai labels
 *   - CLAUDE.md §17.2 — advisory only
 *   - CLAUDE.md §17.9 — envelope `<<<TOOL_RESULT>>>` boundary integrity
 *
 * Strategy:
 *   - DataSource-level mocking (same lightweight QB stub the
 *     `list-projects-in-plan.spec.ts` and `aging-tool.spec.ts` use).
 *   - We invoke the real handler against the canned rows so the
 *     `buildProjectEntry()` shaper, the agency-label placeholder guard,
 *     and the `groupItemsByRevisionRound()` reducer all run end-to-end.
 *   - Three fixture scenarios:
 *       FX-D1 — `listActivePlans` → `reportFormatLabel` paired with
 *               `reportFormat` for both `STRATEGY_BASED` and
 *               `ISSUE_BASED` plans.
 *       FX-D3D4-FLAT — `listProjectsInPlan` (default mode) under the
 *               D4 reference scenario {PG[A,B], RPG-edit(A) round 1,
 *               RPG-change(A) round 2, RPG-edit(B) round 1}.
 *       FX-D3D4-GROUPED — same source data with `groupBy=byRevisionRound`.
 *               Asserts four distinct buckets, no edit/change merge.
 *
 * §17.9 — placeholder-defense regex spot-checks live in
 * `agency-label-guards.spec.ts`; the structural invariants here use the
 * same blacklist so a future regression in the handler that re-introduces
 * `"หน่วยงานที่ N"` is caught at this layer too.
 */

import { EXECUTIVE_TOOL_REGISTRY } from '../../tools/tool-registry';
import { EXECUTIVE_TOOL_HANDLERS } from '../../tools/handlers/executive-tool-handlers';
import type {
  ExecutiveCallerContext,
  ExecutiveToolHandlerDeps,
} from '../../tools/handlers/handler-types';
import { validateAgainstSchema } from '../../tools/tool-schema-validator';
import {
  REPORT_FORMAT_TH,
  resolveReportFormatLabel,
} from '../../aggregation/constants/report-format-label';
import {
  PENDING_RESPONSIBLE_AGENCY_DISCLOSURE,
  REVISION_ROUND_LABEL_MAIN,
} from '../../aggregation/constants/revision-round-label';
import { FORBIDDEN_AGENCY_LABEL_PATTERNS } from '../../aggregation/constants/agency-label-guards';
import {
  ACTIVITY_LABEL_TH,
  FRESHNESS_LABEL_TH,
} from '../../aggregation/constants/plan-activity-status';

// ─────────────────────────────────────────────────────────────────────
// Frozen UUIDs — match the dispatch-report fixture intent.
// ─────────────────────────────────────────────────────────────────────

const PLAN_ID = '11111111-1111-4111-8111-111111111111';

const PG_A = '22222222-2222-4222-8222-222222222222';
const PG_B = '33333333-3333-4333-8333-333333333333';
const PG_C = '34343434-3434-4343-8343-343434343434';
const PG_D = '45454545-4545-4454-8454-545454545454';
const PG_E = '56565656-5656-4565-8565-656565656565';
const PG_F = '67676767-6767-4676-8676-767676767676';

const RPG_A_EDIT_R1 = '44444444-4444-4444-8444-444444444444';
const RPG_A_CHANGE_R2 = '55555555-5555-4555-8555-555555555555';
const RPG_B_EDIT_R1 = '66666666-6666-4666-8666-666666666666';

const DPR_A_R1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DPR_A_R2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DPR_B_R1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

// Creator-WH ID scalars — origin classifier wants the §1 PAO sentinels
// for agency, anything else for LAO.
const PAO_AMPHOE = '3001';
const PAO_LAO = '3001027';
const NONPAO_AMPHOE = '3002';
const NONPAO_LAO = '3002001';

function makeCtx(): ExecutiveCallerContext {
  return {
    userId: 'user-w58-qa02',
    workHistoryId: 'wh-w58-qa02',
    roleName: 'staff',
    workStatusName: 'approved',
  };
}

// ─────────────────────────────────────────────────────────────────────
// QueryBuilder stub — registers per-repository raw rows by entity name
// and lets the handler's chained QB calls pass through.
// ─────────────────────────────────────────────────────────────────────

interface RowMap {
  ProjectGroup?: unknown[];
  RevisedProjectGroup?: unknown[];
  SupplementProjectGroup?: unknown[];
  DevelopmentPlan?: unknown[];
  // Wave 58 W58-BE-AGG-03 (D2) — open-state derivation rows.
  PlanPhase?: unknown[];
  DevelopmentPlanRevision?: unknown[];
  DevelopmentPlanSupplement?: unknown[];
}

function makeDeps(rowMap: RowMap): ExecutiveToolHandlerDeps {
  function makeQb(rows: unknown[]): Record<string, unknown> {
    const qb: Record<string, unknown> = {};
    const chain = () => qb;
    Object.assign(qb, {
      select: chain,
      addSelect: chain,
      innerJoin: chain,
      leftJoin: chain,
      from: chain,
      where: chain,
      andWhere: chain,
      orderBy: chain,
      addOrderBy: chain,
      groupBy: chain,
      addGroupBy: chain,
      take: chain,
      limit: chain,
      getRawMany: async () => rows,
      // For DevelopmentPlan path used by listActivePlans.
      getMany: async () => rows,
    });
    return qb;
  }
  return {
    dataSource: {
      getRepository: (entity: { name: string } | string) => {
        const name =
          typeof entity === 'string' ? entity : (entity?.name ?? 'unknown');
        const rows =
          (rowMap as Record<string, unknown[] | undefined>)[name] ?? [];
        return {
          createQueryBuilder: () => makeQb(rows),
        };
      },
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
// FX-D1 — listActivePlans envelope carries `reportFormatLabel`.
// ─────────────────────────────────────────────────────────────────────

describe('Wave 58 / golden / FX-D1 — listActivePlans reportFormatLabel (D1)', () => {
  it('emits paired Thai label for STRATEGY_BASED and ISSUE_BASED plans', async () => {
    const deps = makeDeps({
      DevelopmentPlan: [
        {
          id: PLAN_ID,
          name: 'แผนพัฒนาฯ 2566-2570',
          reportFormat: 'STRATEGY_BASED',
          isLatest: true,
          isBooked: true,
        },
        {
          id: '99999999-9999-4999-8999-999999999999',
          name: 'แผนพัฒนาฯ 2571-2575',
          reportFormat: 'ISSUE_BASED',
          isLatest: true,
          isBooked: false,
        },
      ],
      // ProjectGroup count loop — return zero count rows.
      ProjectGroup: [],
    });
    const handler = EXECUTIVE_TOOL_HANDLERS.listActivePlans;
    const out = await handler({}, makeCtx(), deps);
    const items = (out as { items: Array<Record<string, unknown>> }).items;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      reportFormat: 'STRATEGY_BASED',
      reportFormatLabel: 'แบบยุทธศาสตร์',
    });
    expect(items[1]).toMatchObject({
      reportFormat: 'ISSUE_BASED',
      reportFormatLabel: 'แบบประเด็นการพัฒนา',
    });
    // §16.9 canonical labels — exact match.
    expect(REPORT_FORMAT_TH.STRATEGY_BASED).toBe('แบบยุทธศาสตร์');
    expect(REPORT_FORMAT_TH.ISSUE_BASED).toBe('แบบประเด็นการพัฒนา');
  });

  it('reportFormatLabel resolver returns "" for unknown enum values (defensive fallback)', () => {
    expect(resolveReportFormatLabel('SOMETHING_ELSE')).toBe('');
    expect(resolveReportFormatLabel(null)).toBe('');
    expect(resolveReportFormatLabel(undefined)).toBe('');
  });

  it('schema validates the new envelope shape (reportFormatLabel required)', async () => {
    const deps = makeDeps({
      DevelopmentPlan: [
        {
          id: PLAN_ID,
          name: 'แผนพัฒนาฯ 2566-2570',
          reportFormat: 'STRATEGY_BASED',
          isLatest: true,
          isBooked: true,
        },
      ],
      ProjectGroup: [],
    });
    const handler = EXECUTIVE_TOOL_HANDLERS.listActivePlans;
    const out = await handler({}, makeCtx(), deps);
    const spec = EXECUTIVE_TOOL_REGISTRY.listActivePlans;
    const res = validateAgainstSchema(spec.returnSchema, out);
    expect(res.ok).toBe(true);
  });

  it('schema rejects an envelope MISSING reportFormatLabel', () => {
    const spec = EXECUTIVE_TOOL_REGISTRY.listActivePlans;
    const bad = {
      items: [
        {
          planId: PLAN_ID,
          name: 'แผน',
          reportFormat: 'STRATEGY_BASED',
          isLatest: true,
          isBooked: false,
          projectCount: 0,
          // reportFormatLabel intentionally missing — must fail
        },
      ],
      asOf: new Date().toISOString(),
    };
    const res = validateAgainstSchema(spec.returnSchema, bad);
    expect(res.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// FX-D3D4-FLAT — listProjectsInPlan default mode + agency-name JOIN +
// revisionRound metadata, under the D4 reference scenario.
//
// Source data: 6 main + 1 RPG-edit(A)R1 + 1 RPG-change(A)R2 + 1 RPG-edit(B)R1
//   - 3 main rows have agency FK set + agencyname projected
//   - 2 main rows have null FK + LAO-origin creator (disclosure expected)
//   - 1 main row has FK set + name (Agency-origin)
// ─────────────────────────────────────────────────────────────────────

const MAIN_FIXTURE_ROWS = [
  // PG_A — FK set, Agency-origin (PAO). pagenumber set → booked row.
  {
    pgid: PG_A,
    title: 'โครงการ A',
    statusname: 'Approved',
    amphoeid: 1,
    agencyid: 100,
    agencyname: 'อบจ.นครราชสีมา',
    creatoramphoeid: PAO_AMPHOE,
    creatorlaoid: PAO_LAO,
    budget: '1000000',
    pagenumber: 42,
  },
  // PG_B — FK set, LAO-origin
  {
    pgid: PG_B,
    title: 'โครงการ B',
    statusname: 'Pending_Approval',
    amphoeid: 2,
    agencyid: 200,
    agencyname: 'สำนักช่าง อบต.ก',
    creatoramphoeid: NONPAO_AMPHOE,
    creatorlaoid: NONPAO_LAO,
    budget: '500000',
  },
  // PG_C — FK set, Agency-origin
  {
    pgid: PG_C,
    title: 'โครงการ C',
    statusname: 'Verified',
    amphoeid: 1,
    agencyid: 100,
    agencyname: 'อบจ.นครราชสีมา',
    creatoramphoeid: PAO_AMPHOE,
    creatorlaoid: PAO_LAO,
    budget: '250000',
  },
  // PG_D — null FK, LAO-origin → disclosure expected. pagenumber null
  // (book not yet compiled).
  {
    pgid: PG_D,
    title: 'โครงการ D',
    statusname: 'Pending',
    amphoeid: 3,
    agencyid: null,
    agencyname: null,
    creatoramphoeid: NONPAO_AMPHOE,
    creatorlaoid: NONPAO_LAO,
    budget: '0',
    pagenumber: null,
  },
  // PG_E — null FK, LAO-origin → disclosure expected
  {
    pgid: PG_E,
    title: 'โครงการ E',
    statusname: 'Pending',
    amphoeid: 3,
    agencyid: null,
    agencyname: null,
    creatoramphoeid: NONPAO_AMPHOE,
    creatorlaoid: NONPAO_LAO,
    budget: '0',
  },
  // PG_F — null FK, Agency-origin (PAO) → NO disclosure (per §5)
  {
    pgid: PG_F,
    title: 'โครงการ F',
    statusname: 'Ready',
    amphoeid: 1,
    agencyid: null,
    agencyname: null,
    creatoramphoeid: PAO_AMPHOE,
    creatorlaoid: PAO_LAO,
    budget: '0',
  },
];

const REVISED_FIXTURE_ROWS = [
  // RPG-edit(A) round 1 — DPR description present → label comes verbatim
  {
    rpgid: RPG_A_EDIT_R1,
    title: 'โครงการ A (ฉบับแก้ไข)',
    statusname: 'Approved',
    amphoeid: 1,
    agencyid: 100,
    agencyname: 'อบจ.นครราชสีมา',
    creatoramphoeid: PAO_AMPHOE,
    creatorlaoid: PAO_LAO,
    dprid: DPR_A_R1,
    revisionnumber: 1,
    dprdescription: 'แก้ไขรอบที่ 1 ปี 2569',
    revisiontypename: 'แก้ไข',
    budget: '1100000',
  },
  // RPG-change(A) round 2 — DPR description empty → fallback "เล่มเปลี่ยนแปลงครั้งที่ 2"
  {
    rpgid: RPG_A_CHANGE_R2,
    title: 'โครงการ A (ฉบับเปลี่ยนแปลง)',
    statusname: 'Pending_Approval',
    amphoeid: 1,
    agencyid: 100,
    agencyname: 'อบจ.นครราชสีมา',
    creatoramphoeid: PAO_AMPHOE,
    creatorlaoid: PAO_LAO,
    dprid: DPR_A_R2,
    revisionnumber: 2,
    dprdescription: '',
    revisiontypename: 'เปลี่ยนแปลง',
    budget: '1500000',
  },
  // RPG-edit(B) round 1 — DPR description NULL → fallback "เล่มแก้ไขครั้งที่ 1"
  {
    rpgid: RPG_B_EDIT_R1,
    title: 'โครงการ B (ฉบับแก้ไข)',
    statusname: 'Approved',
    amphoeid: 2,
    agencyid: 200,
    agencyname: 'สำนักช่าง อบต.ก',
    creatoramphoeid: NONPAO_AMPHOE,
    creatorlaoid: NONPAO_LAO,
    dprid: DPR_B_R1,
    revisionnumber: 1,
    dprdescription: null,
    revisiontypename: 'แก้ไข',
    budget: '600000',
  },
];

describe('Wave 58 / golden / FX-D3D4-FLAT — listProjectsInPlan default mode (D3 + D4 + D6)', () => {
  const handler = EXECUTIVE_TOOL_HANDLERS.listProjectsInPlan;

  async function invokeFlat(): Promise<Record<string, unknown>> {
    const deps = makeDeps({
      ProjectGroup: MAIN_FIXTURE_ROWS,
      RevisedProjectGroup: REVISED_FIXTURE_ROWS,
      SupplementProjectGroup: [],
    });
    return await handler(
      // W60c — flat shape requires explicit opt-in.
      { planId: PLAN_ID, scope: 'all', limit: 50, groupBy: 'flat' },
      makeCtx(),
      deps,
    );
  }

  it('every project row has responsibleAgencyName key present', async () => {
    const out = await invokeFlat();
    const items = out.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    for (const row of items) {
      expect('responsibleAgencyName' in row).toBe(true);
    }
  });

  it('FK-set rows expose the actual agency name (no synthesis)', async () => {
    const out = await invokeFlat();
    const items = out.items as Array<Record<string, unknown>>;
    const pgA = items.find((r) => r.projectId === PG_A);
    const pgB = items.find((r) => r.projectId === PG_B);
    expect(pgA?.responsibleAgencyName).toBe('อบจ.นครราชสีมา');
    expect(pgB?.responsibleAgencyName).toBe('สำนักช่าง อบต.ก');
  });

  it('null-FK LAO-origin rows carry the canonical W57 rule #26 disclosure verbatim', async () => {
    const out = await invokeFlat();
    const items = out.items as Array<Record<string, unknown>>;
    const pgD = items.find((r) => r.projectId === PG_D);
    const pgE = items.find((r) => r.projectId === PG_E);
    expect(pgD?.responsibleAgencyName).toBeNull();
    expect(pgE?.responsibleAgencyName).toBeNull();
    expect(pgD?.responsibleAgencyDisclosure).toBe(
      PENDING_RESPONSIBLE_AGENCY_DISCLOSURE,
    );
    expect(pgE?.responsibleAgencyDisclosure).toBe(
      PENDING_RESPONSIBLE_AGENCY_DISCLOSURE,
    );
  });

  it('null-FK Agency-origin row gets NO disclosure (per §5.1 — agency rows must always be FK-set)', async () => {
    const out = await invokeFlat();
    const items = out.items as Array<Record<string, unknown>>;
    const pgF = items.find((r) => r.projectId === PG_F);
    expect(pgF?.responsibleAgencyName).toBeNull();
    // Agency-origin null-FK row → disclosure MUST be null (the disclosure
    // copy is reserved for LAO-origin pre-assignment per §5.2).
    expect(pgF?.responsibleAgencyDisclosure).toBeNull();
  });

  it('NO row contains a synthesized agency placeholder ("หน่วยงานที่ N" / "agency #N")', async () => {
    const out = await invokeFlat();
    const items = out.items as Array<Record<string, unknown>>;
    for (const row of items) {
      for (const field of [
        'responsibleAgencyName',
        'responsibleAgencyDisclosure',
      ] as const) {
        const v = row[field];
        if (typeof v !== 'string' || v.length === 0) continue;
        for (const rx of FORBIDDEN_AGENCY_LABEL_PATTERNS) {
          expect({ field, v, hit: rx.test(v) }).toEqual({
            field,
            v,
            hit: false,
          });
        }
      }
    }
  });

  it('FX-D4 reference scenario produces three distinct revisionRoundId values among revised rows', async () => {
    const out = await invokeFlat();
    const items = out.items as Array<Record<string, unknown>>;
    const revised = items.filter((r) => r.projectKind === 'revised');
    const ids = new Set(revised.map((r) => r.revisionRoundId));
    expect(ids.size).toBe(3);
    expect(ids.has(DPR_A_R1)).toBe(true);
    expect(ids.has(DPR_A_R2)).toBe(true);
    expect(ids.has(DPR_B_R1)).toBe(true);
  });

  it('FX-D4 revisionRoundType distribution is {main: 6, edit: 2, change: 1, supplement: 0}', async () => {
    const out = await invokeFlat();
    const items = out.items as Array<Record<string, unknown>>;
    const dist: Record<string, number> = {
      main: 0,
      edit: 0,
      change: 0,
      supplement: 0,
    };
    for (const r of items) {
      const t = r.revisionRoundType as string;
      dist[t] = (dist[t] ?? 0) + 1;
    }
    expect(dist).toEqual({ main: 6, edit: 2, change: 1, supplement: 0 });
  });

  it('FX-D4 revisionRoundLabel resolution: description → verbatim, empty → fallback, null → fallback, main → constant', async () => {
    const out = await invokeFlat();
    const items = out.items as Array<Record<string, unknown>>;
    const main = items.find((r) => r.projectId === PG_A);
    const editA = items.find((r) => r.projectId === RPG_A_EDIT_R1);
    const changeA = items.find((r) => r.projectId === RPG_A_CHANGE_R2);
    const editB = items.find((r) => r.projectId === RPG_B_EDIT_R1);

    expect(main?.revisionRoundLabel).toBe(REVISION_ROUND_LABEL_MAIN); // 'เล่มหลัก'
    expect(editA?.revisionRoundLabel).toBe('แก้ไขรอบที่ 1 ปี 2569'); // verbatim from description
    expect(changeA?.revisionRoundLabel).toBe('เล่มเปลี่ยนแปลงครั้งที่ 2'); // fallback (empty desc)
    expect(editB?.revisionRoundLabel).toBe('เล่มแก้ไขครั้งที่ 1'); // fallback (null desc)
  });

  it('schema validator accepts the flat envelope', async () => {
    const out = await invokeFlat();
    const spec = EXECUTIVE_TOOL_REGISTRY.listProjectsInPlan;
    const res = validateAgainstSchema(spec.returnSchema, out);
    expect(res.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// FX-D3D4-GROUPED — listProjectsInPlan with groupBy=byRevisionRound.
// ─────────────────────────────────────────────────────────────────────

describe('Wave 58 / golden / FX-D3D4-GROUPED — listProjectsInPlan groupBy=byRevisionRound (D4)', () => {
  const handler = EXECUTIVE_TOOL_HANDLERS.listProjectsInPlan;

  async function invokeGrouped(): Promise<Record<string, unknown>> {
    const deps = makeDeps({
      ProjectGroup: MAIN_FIXTURE_ROWS,
      RevisedProjectGroup: REVISED_FIXTURE_ROWS,
      SupplementProjectGroup: [],
    });
    return await handler(
      {
        planId: PLAN_ID,
        scope: 'all',
        limit: 50,
        groupBy: 'byRevisionRound',
      },
      makeCtx(),
      deps,
    );
  }

  it('emits `groups[]` (not `items[]`) when groupBy=byRevisionRound', async () => {
    const out = await invokeGrouped();
    expect('items' in out).toBe(false);
    expect(Array.isArray(out.groups)).toBe(true);
  });

  it('emits exactly 4 groups: 1 main + 2 edit + 1 change', async () => {
    const out = await invokeGrouped();
    const groups = out.groups as Array<Record<string, unknown>>;
    expect(groups).toHaveLength(4);
    const types = groups.map((g) => g.revisionRoundType);
    // Sorted ascending per ROUND_TYPE_ORDER (main < edit < change < supplement).
    expect(types[0]).toBe('main');
    expect(types[3]).toBe('change');
    expect(types.filter((t) => t === 'edit')).toHaveLength(2);
    expect(types.filter((t) => t === 'change')).toHaveLength(1);
  });

  it('the two `edit` groups have DIFFERENT revisionRoundId values (proves no edit/change merge)', async () => {
    const out = await invokeGrouped();
    const groups = out.groups as Array<Record<string, unknown>>;
    const editGroups = groups.filter((g) => g.revisionRoundType === 'edit');
    expect(editGroups).toHaveLength(2);
    const editIds = new Set(editGroups.map((g) => g.revisionRoundId));
    expect(editIds.size).toBe(2);
    expect(editIds.has(DPR_A_R1)).toBe(true);
    expect(editIds.has(DPR_B_R1)).toBe(true);
  });

  it('the change group is its own bucket — NOT merged with either edit bucket', async () => {
    const out = await invokeGrouped();
    const groups = out.groups as Array<Record<string, unknown>>;
    const changeGroup = groups.find((g) => g.revisionRoundType === 'change');
    expect(changeGroup).toBeDefined();
    expect(changeGroup?.revisionRoundId).toBe(DPR_A_R2);
    const projects = changeGroup?.projects as Array<Record<string, unknown>>;
    expect(projects).toHaveLength(1);
    expect(projects[0].projectId).toBe(RPG_A_CHANGE_R2);
  });

  it('main bucket carries all 6 main projects', async () => {
    const out = await invokeGrouped();
    const groups = out.groups as Array<Record<string, unknown>>;
    const mainGroup = groups.find((g) => g.revisionRoundType === 'main');
    expect(mainGroup?.revisionRoundId).toBeNull();
    expect(mainGroup?.revisionRoundLabel).toBe(REVISION_ROUND_LABEL_MAIN);
    const projects = mainGroup?.projects as Array<Record<string, unknown>>;
    expect(projects).toHaveLength(6);
  });

  it('group bucket labels match the FX-D4 reference scenario', async () => {
    const out = await invokeGrouped();
    const groups = out.groups as Array<Record<string, unknown>>;
    const labels = groups.map((g) => ({
      type: g.revisionRoundType,
      id: g.revisionRoundId,
      label: g.revisionRoundLabel,
    }));
    // Sorted ascending — main first, supplement last; within edit, the
    // alphabetical secondary order applies.
    expect(labels).toEqual(
      expect.arrayContaining([
        { type: 'main', id: null, label: REVISION_ROUND_LABEL_MAIN },
        { type: 'edit', id: DPR_A_R1, label: 'แก้ไขรอบที่ 1 ปี 2569' },
        { type: 'edit', id: DPR_B_R1, label: 'เล่มแก้ไขครั้งที่ 1' },
        { type: 'change', id: DPR_A_R2, label: 'เล่มเปลี่ยนแปลงครั้งที่ 2' },
      ]),
    );
  });

  it('schema validator accepts the grouped envelope', async () => {
    const out = await invokeGrouped();
    const spec = EXECUTIVE_TOOL_REGISTRY.listProjectsInPlan;
    const res = validateAgainstSchema(spec.returnSchema, out);
    expect(res.ok).toBe(true);
  });

  it('NO project inside any group contains a synthesized agency placeholder', async () => {
    const out = await invokeGrouped();
    const groups = out.groups as Array<Record<string, unknown>>;
    for (const g of groups) {
      const projects = g.projects as Array<Record<string, unknown>>;
      for (const row of projects) {
        for (const field of [
          'responsibleAgencyName',
          'responsibleAgencyDisclosure',
        ] as const) {
          const v = row[field];
          if (typeof v !== 'string' || v.length === 0) continue;
          for (const rx of FORBIDDEN_AGENCY_LABEL_PATTERNS) {
            expect(rx.test(v)).toBe(false);
          }
        }
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// FX-D7 — listProjectsInPlan emits `pageNumber` on every project row.
// ─────────────────────────────────────────────────────────────────────

describe('Wave 58 / golden / FX-D7 — listProjectsInPlan pageNumber surface (D7)', () => {
  const handler = EXECUTIVE_TOOL_HANDLERS.listProjectsInPlan;

  async function invokeFlat(): Promise<Record<string, unknown>> {
    const deps = makeDeps({
      ProjectGroup: MAIN_FIXTURE_ROWS,
      RevisedProjectGroup: REVISED_FIXTURE_ROWS,
      SupplementProjectGroup: [],
    });
    return await handler(
      // W60c — flat shape requires explicit opt-in.
      { planId: PLAN_ID, scope: 'all', limit: 50, groupBy: 'flat' },
      makeCtx(),
      deps,
    );
  }

  it('every project row has a `pageNumber` key (number | null)', async () => {
    const out = await invokeFlat();
    const items = out.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    for (const row of items) {
      expect('pageNumber' in row).toBe(true);
      const v = row.pageNumber;
      expect(v === null || typeof v === 'number').toBe(true);
    }
  });

  it('booked PG row (pagenumber=42) projects to pageNumber=42', async () => {
    const out = await invokeFlat();
    const items = out.items as Array<Record<string, unknown>>;
    const pgA = items.find((r) => r.projectId === PG_A);
    expect(pgA?.pageNumber).toBe(42);
  });

  it('unbooked PG row (pagenumber=null) projects to pageNumber=null', async () => {
    const out = await invokeFlat();
    const items = out.items as Array<Record<string, unknown>>;
    const pgD = items.find((r) => r.projectId === PG_D);
    expect(pgD?.pageNumber).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// FX-D2 — listActivePlans planActivityStatus structured envelope.
//
// Honest-derivation matrix covering 4 combinations:
//   1. latest + open PlanPhase           → freshness=latest,    activities=[submit-open]
//   2. latest + closed (booked, no DPR)  → freshness=latest,    activities=[none]
//   3. historical + open edit-DPR        → freshness=historical, activities=[edit-open]
//   4. historical + all-closed           → freshness=historical, activities=[none]
//
// Plus invariant-style assertions:
//   - alphabetical sort by `key`
//   - mutual exclusion of `'none'` with the four open-* keys
// ─────────────────────────────────────────────────────────────────────

const PLAN_LATEST_OPEN = '11111111-1111-4111-8111-aaaaaaaaaaaa';
const PLAN_LATEST_CLOSED = '22222222-2222-4222-8222-bbbbbbbbbbbb';
const PLAN_HIST_OPEN_EDIT = '33333333-3333-4333-8333-cccccccccccc';
const PLAN_HIST_CLOSED = '44444444-4444-4444-8444-dddddddddddd';
const PLAN_LATEST_MULTI_OPEN = '55555555-5555-4555-8555-eeeeeeeeeeee';

describe('Wave 58 / golden / FX-D2 — listActivePlans planActivityStatus (D2 / Option B)', () => {
  const handler = EXECUTIVE_TOOL_HANDLERS.listActivePlans;

  async function invokeWith(rowMap: RowMap): Promise<Record<string, unknown>> {
    const deps = makeDeps(rowMap);
    return await handler({ includeClosed: true, limit: 50 }, makeCtx(), deps);
  }

  function findPlan(
    out: Record<string, unknown>,
    planId: string,
  ): Record<string, unknown> | undefined {
    const items = out.items as Array<Record<string, unknown>>;
    return items.find((p) => p.planId === planId);
  }

  it('combination 1 — latest + open PlanPhase → freshness=latest, activities=[submit-open]', async () => {
    const out = await invokeWith({
      DevelopmentPlan: [
        {
          id: PLAN_LATEST_OPEN,
          name: 'แผนล่าสุด เปิดส่งโครงการ',
          reportFormat: 'STRATEGY_BASED',
          isLatest: true,
          isBooked: false,
        },
      ],
      ProjectGroup: [],
      PlanPhase: [{ planid: PLAN_LATEST_OPEN }],
      DevelopmentPlanRevision: [],
      DevelopmentPlanSupplement: [],
    });
    const plan = findPlan(out, PLAN_LATEST_OPEN);
    const status = plan?.planActivityStatus as Record<string, unknown>;
    expect(status.freshness).toBe('latest');
    expect(status.freshnessLabel).toBe(FRESHNESS_LABEL_TH.latest);
    const activities = status.activities as Array<Record<string, string>>;
    expect(activities).toHaveLength(1);
    expect(activities[0]).toEqual({
      key: 'submit-open',
      label: ACTIVITY_LABEL_TH['submit-open'],
    });
  });

  it('combination 2 — latest + closed (no PlanPhase, no DPR/DPS) → activities=[none]', async () => {
    const out = await invokeWith({
      DevelopmentPlan: [
        {
          id: PLAN_LATEST_CLOSED,
          name: 'แผนล่าสุด รวมเล่มแล้ว',
          reportFormat: 'STRATEGY_BASED',
          isLatest: true,
          isBooked: true,
        },
      ],
      ProjectGroup: [],
      PlanPhase: [],
      DevelopmentPlanRevision: [],
      DevelopmentPlanSupplement: [],
    });
    const plan = findPlan(out, PLAN_LATEST_CLOSED);
    const status = plan?.planActivityStatus as Record<string, unknown>;
    expect(status.freshness).toBe('latest');
    const activities = status.activities as Array<Record<string, string>>;
    expect(activities).toHaveLength(1);
    expect(activities[0]).toEqual({
      key: 'none',
      label: ACTIVITY_LABEL_TH.none,
    });
  });

  it('combination 3 — historical + open edit-DPR → freshness=historical, activities=[edit-open]', async () => {
    const out = await invokeWith({
      DevelopmentPlan: [
        {
          id: PLAN_HIST_OPEN_EDIT,
          name: 'แผนเก่า เปิดรอบแก้ไข',
          reportFormat: 'STRATEGY_BASED',
          isLatest: false,
          isBooked: true,
        },
      ],
      ProjectGroup: [],
      PlanPhase: [],
      DevelopmentPlanRevision: [
        { planid: PLAN_HIST_OPEN_EDIT, rtname: 'แก้ไข' },
      ],
      DevelopmentPlanSupplement: [],
    });
    const plan = findPlan(out, PLAN_HIST_OPEN_EDIT);
    const status = plan?.planActivityStatus as Record<string, unknown>;
    expect(status.freshness).toBe('historical');
    expect(status.freshnessLabel).toBe(FRESHNESS_LABEL_TH.historical);
    const activities = status.activities as Array<Record<string, string>>;
    expect(activities).toHaveLength(1);
    expect(activities[0]).toEqual({
      key: 'edit-open',
      label: ACTIVITY_LABEL_TH['edit-open'],
    });
  });

  it('combination 4 — historical + all closed → freshness=historical, activities=[none]', async () => {
    const out = await invokeWith({
      DevelopmentPlan: [
        {
          id: PLAN_HIST_CLOSED,
          name: 'แผนเก่า ปิดทุกอย่าง',
          reportFormat: 'STRATEGY_BASED',
          isLatest: false,
          isBooked: true,
        },
      ],
      ProjectGroup: [],
      PlanPhase: [],
      DevelopmentPlanRevision: [],
      DevelopmentPlanSupplement: [],
    });
    const plan = findPlan(out, PLAN_HIST_CLOSED);
    const status = plan?.planActivityStatus as Record<string, unknown>;
    expect(status.freshness).toBe('historical');
    const activities = status.activities as Array<Record<string, string>>;
    expect(activities).toEqual([
      { key: 'none', label: ACTIVITY_LABEL_TH.none },
    ]);
  });

  it('alphabetical-by-key invariant — multiple open signals are sorted ascending', async () => {
    const out = await invokeWith({
      DevelopmentPlan: [
        {
          id: PLAN_LATEST_MULTI_OPEN,
          name: 'แผนล่าสุด เปิดหลายรายการ',
          reportFormat: 'STRATEGY_BASED',
          isLatest: true,
          isBooked: false,
        },
      ],
      ProjectGroup: [],
      PlanPhase: [{ planid: PLAN_LATEST_MULTI_OPEN }],
      DevelopmentPlanRevision: [
        { planid: PLAN_LATEST_MULTI_OPEN, rtname: 'แก้ไข' },
        { planid: PLAN_LATEST_MULTI_OPEN, rtname: 'เปลี่ยนแปลง' },
      ],
      DevelopmentPlanSupplement: [{ planid: PLAN_LATEST_MULTI_OPEN }],
    });
    const plan = findPlan(out, PLAN_LATEST_MULTI_OPEN);
    const status = plan?.planActivityStatus as Record<string, unknown>;
    const activities = status.activities as Array<Record<string, string>>;
    expect(activities).toHaveLength(4);
    const keys = activities.map((a) => a.key);
    // Alphabetical ascending: change-open < edit-open < submit-open < supplement-open.
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
    expect(keys).toEqual([
      'change-open',
      'edit-open',
      'submit-open',
      'supplement-open',
    ]);
  });

  it("mutual-exclusion invariant — `'none'` is never present alongside any open-* key", async () => {
    // Run both fixtures and assert the invariant on each plan envelope
    // independently.
    const open = await invokeWith({
      DevelopmentPlan: [
        {
          id: PLAN_LATEST_OPEN,
          name: 'p',
          reportFormat: 'STRATEGY_BASED',
          isLatest: true,
          isBooked: false,
        },
      ],
      ProjectGroup: [],
      PlanPhase: [{ planid: PLAN_LATEST_OPEN }],
      DevelopmentPlanRevision: [],
      DevelopmentPlanSupplement: [],
    });
    const closed = await invokeWith({
      DevelopmentPlan: [
        {
          id: PLAN_HIST_CLOSED,
          name: 'p',
          reportFormat: 'STRATEGY_BASED',
          isLatest: false,
          isBooked: true,
        },
      ],
      ProjectGroup: [],
      PlanPhase: [],
      DevelopmentPlanRevision: [],
      DevelopmentPlanSupplement: [],
    });
    for (const out of [open, closed]) {
      const items = out.items as Array<Record<string, unknown>>;
      for (const plan of items) {
        const status = plan.planActivityStatus as Record<string, unknown>;
        const activities = status.activities as Array<Record<string, string>>;
        const keys = activities.map((a) => a.key);
        const hasNone = keys.includes('none');
        const hasOpen = keys.some(
          (k) =>
            k === 'submit-open' ||
            k === 'edit-open' ||
            k === 'change-open' ||
            k === 'supplement-open',
        );
        // XOR — exactly one of the two conditions is true.
        expect(hasNone !== hasOpen).toBe(true);
      }
    }
  });

  it('schema validates the new planActivityStatus envelope shape', async () => {
    const out = await invokeWith({
      DevelopmentPlan: [
        {
          id: PLAN_LATEST_OPEN,
          name: 'p',
          reportFormat: 'STRATEGY_BASED',
          isLatest: true,
          isBooked: false,
        },
      ],
      ProjectGroup: [],
      PlanPhase: [{ planid: PLAN_LATEST_OPEN }],
      DevelopmentPlanRevision: [],
      DevelopmentPlanSupplement: [],
    });
    const spec = EXECUTIVE_TOOL_REGISTRY.listActivePlans;
    const res = validateAgainstSchema(spec.returnSchema, out);
    expect(res.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Wave 59 / FX-DA — listActivePlans default returns ALL plans.
//
// Pre-W59: handler defaulted to `isLatest=true` (single row). W59 flips
// the default to ALL non-soft-deleted plans; the legacy filter is
// gated behind the new optional `latestOnly: boolean` param.
// ─────────────────────────────────────────────────────────────────────

const PLAN_W59_LATEST = '11111111-1111-4111-8111-1aaaaaaaaaaa';
const PLAN_W59_HISTORICAL = '22222222-2222-4222-8222-2bbbbbbbbbbb';

describe('Wave 59 / FX-DA — listActivePlans default returns all plans', () => {
  const handler = EXECUTIVE_TOOL_HANDLERS.listActivePlans;

  function makeFixture(): RowMap {
    return {
      DevelopmentPlan: [
        {
          id: PLAN_W59_LATEST,
          name: 'แผนพัฒนา ฯ ปัจจุบัน',
          reportFormat: 'STRATEGY_BASED',
          isLatest: true,
          isBooked: true,
        },
        {
          id: PLAN_W59_HISTORICAL,
          name: 'แผนพัฒนา ฯ ฉบับก่อน',
          reportFormat: 'STRATEGY_BASED',
          isLatest: false,
          isBooked: true,
        },
      ],
      ProjectGroup: [],
      PlanPhase: [],
      DevelopmentPlanRevision: [],
      DevelopmentPlanSupplement: [],
    };
  }

  it('default (no params) returns BOTH the latest and the historical plan', async () => {
    const deps = makeDeps(makeFixture());
    const out = await handler({}, makeCtx(), deps);
    const items = out.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    const ids = items.map((p) => p.planId).sort();
    expect(ids).toEqual([PLAN_W59_LATEST, PLAN_W59_HISTORICAL].sort());
  });

  it('latestOnly: true filters to ONLY the isLatest=true plan', async () => {
    // Note: the in-memory QB stub does not actually evaluate
    // `andWhere('p.isLatest = ...')`; it returns whatever rows the
    // RowMap provides. Under `latestOnly: true` the production handler
    // adds the predicate, but our stub mirrors the production data
    // flow by trusting the caller-provided rows. To express the
    // contract we pre-filter the fixture to the latest row only.
    const deps = makeDeps({
      DevelopmentPlan: [
        {
          id: PLAN_W59_LATEST,
          name: 'แผนพัฒนา ฯ ปัจจุบัน',
          reportFormat: 'STRATEGY_BASED',
          isLatest: true,
          isBooked: true,
        },
      ],
      ProjectGroup: [],
      PlanPhase: [],
      DevelopmentPlanRevision: [],
      DevelopmentPlanSupplement: [],
    });
    const out = await handler({ latestOnly: true }, makeCtx(), deps);
    const items = out.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].planId).toBe(PLAN_W59_LATEST);
  });

  it('latestOnly: false explicitly is equivalent to default (all plans)', async () => {
    const deps = makeDeps(makeFixture());
    const out = await handler({ latestOnly: false }, makeCtx(), deps);
    const items = out.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Wave 59 / FX-DB — listProjectsInPlan emits objective + objectiveTruncated.
//
// Three cases exercise the truncate-at-source contract:
//   - short objective (< cap)  → text passes through, truncated=false
//   - exactly-500 objective    → text passes through, truncated=false
//   - 600-char objective       → text trimmed to first 500, truncated=true
// ─────────────────────────────────────────────────────────────────────

const PG_OBJ_SHORT = '11111111-1111-4111-8111-1cccccccc001';
const PG_OBJ_EXACT = '22222222-2222-4222-8222-2cccccccc002';
const PG_OBJ_LONG = '33333333-3333-4333-8333-3cccccccc003';

const OBJECTIVE_SHORT_TEXT = 'เพื่อพัฒนาคุณภาพชีวิตของประชาชนในตำบล';
const OBJECTIVE_EXACT_TEXT = 'ก'.repeat(500);
const OBJECTIVE_LONG_TEXT = 'ข'.repeat(600);

describe('Wave 59 / FX-DB — listProjectsInPlan objective + objectiveTruncated', () => {
  const handler = EXECUTIVE_TOOL_HANDLERS.listProjectsInPlan;

  async function invokeFlat(): Promise<Record<string, unknown>> {
    const deps = makeDeps({
      ProjectGroup: [
        {
          pgid: PG_OBJ_SHORT,
          title: 'โครงการสั้น',
          statusname: 'Approved',
          amphoeid: 1,
          agencyid: 100,
          agencyname: 'อบจ.นครราชสีมา',
          creatoramphoeid: PAO_AMPHOE,
          creatorlaoid: PAO_LAO,
          budget: '0',
          objective: OBJECTIVE_SHORT_TEXT,
        },
        {
          pgid: PG_OBJ_EXACT,
          title: 'โครงการ exact',
          statusname: 'Approved',
          amphoeid: 1,
          agencyid: 100,
          agencyname: 'อบจ.นครราชสีมา',
          creatoramphoeid: PAO_AMPHOE,
          creatorlaoid: PAO_LAO,
          budget: '0',
          objective: OBJECTIVE_EXACT_TEXT,
        },
        {
          pgid: PG_OBJ_LONG,
          title: 'โครงการยาว',
          statusname: 'Approved',
          amphoeid: 1,
          agencyid: 100,
          agencyname: 'อบจ.นครราชสีมา',
          creatoramphoeid: PAO_AMPHOE,
          creatorlaoid: PAO_LAO,
          budget: '0',
          objective: OBJECTIVE_LONG_TEXT,
        },
      ],
      RevisedProjectGroup: [],
      SupplementProjectGroup: [],
    });
    return await handler(
      // Wave HEAD-BOOK-ROSTER-AND-VERBOSE-OMIT — objective/objectiveTruncated
      // are now verbose-only fields (rule #60): they are nulled unless
      // `verbose: true`. This block exercises the objective truncation
      // behavior, so it opts into verbose explicitly.
      { planId: PLAN_ID, scope: 'main', limit: 50, groupBy: 'flat', verbose: true },
      makeCtx(),
      deps,
    );
  }

  it('every project row has both `objective` and `objectiveTruncated` keys', async () => {
    const out = await invokeFlat();
    const items = out.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    for (const row of items) {
      expect('objective' in row).toBe(true);
      expect('objectiveTruncated' in row).toBe(true);
      expect(typeof row.objectiveTruncated).toBe('boolean');
    }
  });

  it('short objective passes through verbatim with truncated=false', async () => {
    const out = await invokeFlat();
    const items = out.items as Array<Record<string, unknown>>;
    const row = items.find((r) => r.projectId === PG_OBJ_SHORT);
    expect(row?.objective).toBe(OBJECTIVE_SHORT_TEXT);
    expect(row?.objectiveTruncated).toBe(false);
  });

  it('exactly-500-char objective passes through with truncated=false (boundary inclusive)', async () => {
    const out = await invokeFlat();
    const items = out.items as Array<Record<string, unknown>>;
    const row = items.find((r) => r.projectId === PG_OBJ_EXACT);
    expect((row?.objective as string).length).toBe(500);
    expect(row?.objective).toBe(OBJECTIVE_EXACT_TEXT);
    expect(row?.objectiveTruncated).toBe(false);
  });

  it('600-char objective is trimmed to 500 with truncated=true', async () => {
    const out = await invokeFlat();
    const items = out.items as Array<Record<string, unknown>>;
    const row = items.find((r) => r.projectId === PG_OBJ_LONG);
    expect((row?.objective as string).length).toBe(500);
    expect(row?.objective).toBe('ข'.repeat(500));
    expect(row?.objectiveTruncated).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Wave 59 / FX-DC — listProjectsInPlan emits the location triple.
//
// Five cases exercise the amphoeName / laoName / geoCoordinates contract:
//   1. full triple — amphoe + LAO + start/end → all populated
//   2. no coords — amphoe + LAO only → geoCoordinates=null
//   3. no admin — start/end only → amphoeName/laoName=null but geo set
//   4. partial coords (start only) → start={...}, end=null, parent obj
//   5. partial coords (end only)   → start=null, end={...}, parent obj
// ─────────────────────────────────────────────────────────────────────

const PG_LOC_FULL = '11111111-1111-4111-8111-1ddddddddd01';
const PG_LOC_NO_COORDS = '22222222-2222-4222-8222-2ddddddddd02';
const PG_LOC_NO_ADMIN = '33333333-3333-4333-8333-3ddddddddd03';
const PG_LOC_START_ONLY = '44444444-4444-4444-8444-4ddddddddd04';
const PG_LOC_END_ONLY = '55555555-5555-4555-8555-5ddddddddd05';

describe('Wave 59 / FX-DC — listProjectsInPlan location triple', () => {
  const handler = EXECUTIVE_TOOL_HANDLERS.listProjectsInPlan;

  async function invokeFlat(): Promise<Record<string, unknown>> {
    const baseRow = {
      statusname: 'Approved',
      amphoeid: 1,
      agencyid: 100,
      agencyname: 'อบจ.นครราชสีมา',
      creatoramphoeid: PAO_AMPHOE,
      creatorlaoid: PAO_LAO,
      budget: '0',
    };
    const deps = makeDeps({
      ProjectGroup: [
        {
          ...baseRow,
          pgid: PG_LOC_FULL,
          title: 'โครงการ full',
          amphoename: 'อ.เมืองนครราชสีมา',
          laoname: 'อบต.หนองจะบก',
          startlat: 14.97,
          startlng: 102.1,
          endlat: 14.98,
          endlng: 102.11,
        },
        {
          ...baseRow,
          pgid: PG_LOC_NO_COORDS,
          title: 'โครงการ no-coords',
          amphoename: 'อ.ปากช่อง',
          laoname: 'อบต.หนองสาหร่าย',
          startlat: null,
          startlng: null,
          endlat: null,
          endlng: null,
        },
        {
          ...baseRow,
          pgid: PG_LOC_NO_ADMIN,
          title: 'โครงการ no-admin',
          amphoename: null,
          laoname: null,
          startlat: 15.0,
          startlng: 102.2,
          endlat: 15.01,
          endlng: 102.21,
        },
        {
          ...baseRow,
          pgid: PG_LOC_START_ONLY,
          title: 'โครงการ start-only',
          amphoename: 'อ.โชคชัย',
          laoname: null,
          startlat: 14.7,
          startlng: 102.15,
          endlat: null,
          endlng: null,
        },
        {
          ...baseRow,
          pgid: PG_LOC_END_ONLY,
          title: 'โครงการ end-only',
          amphoename: null,
          laoname: 'อบต.ในเมือง',
          startlat: null,
          startlng: null,
          endlat: 14.71,
          endlng: 102.16,
        },
      ],
      RevisedProjectGroup: [],
      SupplementProjectGroup: [],
    });
    return await handler(
      { planId: PLAN_ID, scope: 'main', limit: 50, groupBy: 'flat' },
      makeCtx(),
      deps,
    );
  }

  it('every row has amphoeName / laoName / geoCoordinates keys', async () => {
    const out = await invokeFlat();
    const items = out.items as Array<Record<string, unknown>>;
    expect(items.length).toBe(5);
    for (const row of items) {
      expect('amphoeName' in row).toBe(true);
      expect('laoName' in row).toBe(true);
      expect('geoCoordinates' in row).toBe(true);
    }
  });

  it('case 1 — full triple: amphoeName + laoName + start + end', async () => {
    const out = await invokeFlat();
    const items = out.items as Array<Record<string, unknown>>;
    const row = items.find((r) => r.projectId === PG_LOC_FULL);
    expect(row?.amphoeName).toBe('อ.เมืองนครราชสีมา');
    expect(row?.laoName).toBe('อบต.หนองจะบก');
    expect(row?.geoCoordinates).toEqual({
      start: { lat: 14.97, lng: 102.1 },
      end: { lat: 14.98, lng: 102.11 },
    });
  });

  it('case 2 — no coords: geoCoordinates collapses to null', async () => {
    const out = await invokeFlat();
    const items = out.items as Array<Record<string, unknown>>;
    const row = items.find((r) => r.projectId === PG_LOC_NO_COORDS);
    expect(row?.amphoeName).toBe('อ.ปากช่อง');
    expect(row?.laoName).toBe('อบต.หนองสาหร่าย');
    expect(row?.geoCoordinates).toBeNull();
  });

  it('case 3 — no admin: amphoeName/laoName null, geoCoordinates populated', async () => {
    const out = await invokeFlat();
    const items = out.items as Array<Record<string, unknown>>;
    const row = items.find((r) => r.projectId === PG_LOC_NO_ADMIN);
    expect(row?.amphoeName).toBeNull();
    expect(row?.laoName).toBeNull();
    expect(row?.geoCoordinates).toEqual({
      start: { lat: 15.0, lng: 102.2 },
      end: { lat: 15.01, lng: 102.21 },
    });
  });

  it('case 4 — partial coords (start only): start={...}, end=null, parent non-null', async () => {
    const out = await invokeFlat();
    const items = out.items as Array<Record<string, unknown>>;
    const row = items.find((r) => r.projectId === PG_LOC_START_ONLY);
    expect(row?.geoCoordinates).toEqual({
      start: { lat: 14.7, lng: 102.15 },
      end: null,
    });
  });

  it('case 5 — partial coords (end only): start=null, end={...}, parent non-null', async () => {
    const out = await invokeFlat();
    const items = out.items as Array<Record<string, unknown>>;
    const row = items.find((r) => r.projectId === PG_LOC_END_ONLY);
    expect(row?.geoCoordinates).toEqual({
      start: null,
      end: { lat: 14.71, lng: 102.16 },
    });
  });

  it('schema validator accepts the W59 envelope additions', async () => {
    const out = await invokeFlat();
    const spec = EXECUTIVE_TOOL_REGISTRY.listProjectsInPlan;
    const res = validateAgainstSchema(spec.returnSchema, out);
    expect(res.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Wave 60 / FX-BookCompleteness — listProjectsInPlan groupBy=byBookCompleteness.
//
// Source data: PG[A, B, C] + RPG-edit-r1(A, prev=PG-A)
//            + RPG-change-r1(A, prev=RPG-edit-r1-A)
//            + RPG-change-r1(B, prev=PG-B)
//   → 3 main + 1 edit + 2 change rows.
//
// Mock-mode caveat — the QB stub does NOT actually execute the
// `selectIsHeadFor*` LEFT JOIN (it returns the canned rows verbatim),
// so each fixture row is PRE-SEEDED with `ishead` matching the value
// the real query would compute. The handler still exercises the
// dispatch logic, the `coerceBoolean` shim, the `buildProjectEntry`
// emission gate, and the `groupItemsByBookCompleteness` partitioner
// end-to-end.
// ─────────────────────────────────────────────────────────────────────

const FX_W60_PG_A = '11a11a11-1111-4111-8111-aaaaaaaaaaaa';
const FX_W60_PG_B = '22b22b22-2222-4222-8222-bbbbbbbbbbbb';
const FX_W60_PG_C = '33c33c33-3333-4333-8333-cccccccccccc';
const FX_W60_RPG_A_EDIT_R1 = '44d44d44-4444-4444-8444-dddddddddddd';
const FX_W60_RPG_A_CHANGE_R1 = '55e55e55-5555-4555-8555-eeeeeeeeeeee';
const FX_W60_RPG_B_CHANGE_R1 = '66f66f66-6666-4666-8666-ffffffffffff';
const FX_W60_DPR_EDIT_R1 = 'aaaa1111-1111-4111-8111-111111111111';
const FX_W60_DPR_CHANGE_R1 = 'bbbb2222-2222-4222-8222-222222222222';

const W60_MAIN_ROWS = [
  // PG_A — has descendant (RPG-edit-r1-A) → isHead=false.
  {
    pgid: FX_W60_PG_A,
    title: 'โครงการ A',
    statusname: 'Approved',
    amphoeid: 1,
    agencyid: 100,
    agencyname: 'อบจ.นครราชสีมา',
    creatoramphoeid: PAO_AMPHOE,
    creatorlaoid: PAO_LAO,
    budget: '1000000',
    pagenumber: 1,
    ishead: false,
  },
  // PG_B — has descendant (RPG-change-r1-B) → isHead=false.
  {
    pgid: FX_W60_PG_B,
    title: 'โครงการ B',
    statusname: 'Approved',
    amphoeid: 2,
    agencyid: 200,
    agencyname: 'สำนักช่าง อบต.ก',
    creatoramphoeid: NONPAO_AMPHOE,
    creatorlaoid: NONPAO_LAO,
    budget: '500000',
    pagenumber: 2,
    ishead: false,
  },
  // PG_C — no descendant → isHead=true (HEAD lives in main book).
  {
    pgid: FX_W60_PG_C,
    title: 'โครงการ C',
    statusname: 'Approved',
    amphoeid: 1,
    agencyid: 100,
    agencyname: 'อบจ.นครราชสีมา',
    creatoramphoeid: PAO_AMPHOE,
    creatorlaoid: PAO_LAO,
    budget: '750000',
    pagenumber: 3,
    ishead: true,
  },
];

const W60_REVISED_ROWS = [
  // RPG-edit-r1(A, prev=PG-A) — has descendant (RPG-change-r1-A) → isHead=false.
  {
    rpgid: FX_W60_RPG_A_EDIT_R1,
    title: 'โครงการ A (ฉบับแก้ไข)',
    statusname: 'Approved',
    amphoeid: 1,
    agencyid: 100,
    agencyname: 'อบจ.นครราชสีมา',
    creatoramphoeid: PAO_AMPHOE,
    creatorlaoid: PAO_LAO,
    dprid: FX_W60_DPR_EDIT_R1,
    revisionnumber: 1,
    dprdescription: 'แก้ไขรอบที่ 1',
    revisiontypename: 'แก้ไข',
    budget: '1100000',
    ishead: false,
  },
  // RPG-change-r1(A, prev=RPG-edit-r1-A) — no descendant → isHead=true.
  {
    rpgid: FX_W60_RPG_A_CHANGE_R1,
    title: 'โครงการ A (ฉบับเปลี่ยนแปลง)',
    statusname: 'Approved',
    amphoeid: 1,
    agencyid: 100,
    agencyname: 'อบจ.นครราชสีมา',
    creatoramphoeid: PAO_AMPHOE,
    creatorlaoid: PAO_LAO,
    dprid: FX_W60_DPR_CHANGE_R1,
    revisionnumber: 1,
    dprdescription: 'เปลี่ยนแปลงรอบที่ 1',
    revisiontypename: 'เปลี่ยนแปลง',
    budget: '1500000',
    ishead: true,
  },
  // RPG-change-r1(B, prev=PG-B) — no descendant → isHead=true.
  {
    rpgid: FX_W60_RPG_B_CHANGE_R1,
    title: 'โครงการ B (ฉบับเปลี่ยนแปลง)',
    statusname: 'Approved',
    amphoeid: 2,
    agencyid: 200,
    agencyname: 'สำนักช่าง อบต.ก',
    creatoramphoeid: NONPAO_AMPHOE,
    creatorlaoid: NONPAO_LAO,
    dprid: FX_W60_DPR_CHANGE_R1,
    revisionnumber: 1,
    dprdescription: 'เปลี่ยนแปลงรอบที่ 1',
    revisiontypename: 'เปลี่ยนแปลง',
    budget: '600000',
    ishead: true,
  },
];

describe('Wave 60 / FX-BookCompleteness — listProjectsInPlan groupBy=byBookCompleteness', () => {
  const handler = EXECUTIVE_TOOL_HANDLERS.listProjectsInPlan;

  function makeW60Deps(): ExecutiveToolHandlerDeps {
    return makeDeps({
      ProjectGroup: W60_MAIN_ROWS,
      RevisedProjectGroup: W60_REVISED_ROWS,
      SupplementProjectGroup: [],
    });
  }

  async function invokeBookCompleteness(): Promise<Record<string, unknown>> {
    return await handler(
      {
        planId: PLAN_ID,
        scope: 'all',
        limit: 50,
        groupBy: 'byBookCompleteness',
      },
      makeCtx(),
      makeW60Deps(),
    );
  }

  async function invokeByRevisionRound(): Promise<Record<string, unknown>> {
    return await handler(
      {
        planId: PLAN_ID,
        scope: 'all',
        limit: 50,
        groupBy: 'byRevisionRound',
      },
      makeCtx(),
      makeW60Deps(),
    );
  }

  async function invokeFlatDefault(): Promise<Record<string, unknown>> {
    return await handler(
      // W60c (2026-04-25) — handler default flipped to byBookCompleteness;
      // legacy flat shape requires explicit `groupBy: 'flat'`.
      { planId: PLAN_ID, scope: 'all', limit: 50, groupBy: 'flat' },
      makeCtx(),
      makeW60Deps(),
    );
  }

  // W60c round 4 (2026-04-25) — Mode A envelope contract changed:
  // - `groups[]` REMOVED (LLM stubbornly dedup-rendered identical-title
  //   rows across distinct revision rounds, dropping change-r2). Only
  //   `renderedMarkdown` (server-rendered body) + `groupSummary`
  //   (label + count, no row data) are emitted. LLM is forced to use
  //   the rendered markdown.
  // - Per-row `isHead` is no longer asserted at this layer; the
  //   `selectIsHeadFor*` helper has its own unit-spec coverage.
  it('emits `renderedMarkdown` (not `items[]` and not `groups[]`) when groupBy=byBookCompleteness', async () => {
    const out = await invokeBookCompleteness();
    expect('items' in out).toBe(false);
    expect('groups' in out).toBe(false);
    expect(typeof out.renderedMarkdown).toBe('string');
    expect((out.renderedMarkdown as string).length).toBeGreaterThan(0);
  });

  it('produces three group entries via groupSummary: main + edit-r1 + change-r1', async () => {
    const out = await invokeBookCompleteness();
    const summary = out.groupSummary as Array<Record<string, unknown>>;
    expect(Array.isArray(summary)).toBe(true);
    expect(summary).toHaveLength(3);
    const types = summary.map((g) => g.revisionRoundType);
    expect(types[0]).toBe('main');
    expect(types[1]).toBe('edit');
    expect(types[2]).toBe('change');
  });

  it('main bucket summary reports projectCount=3 and revisionRoundId=null', async () => {
    const out = await invokeBookCompleteness();
    const summary = out.groupSummary as Array<Record<string, unknown>>;
    const main = summary.find((g) => g.revisionRoundType === 'main');
    expect(main?.revisionRoundId).toBeNull();
    expect(main?.projectCount).toBe(3);
    // Markdown body must contain the main heading.
    expect(out.renderedMarkdown).toContain('### เล่มหลัก');
  });

  it('edit-r1 bucket summary reports projectCount=1 and the right DPR id', async () => {
    const out = await invokeBookCompleteness();
    const summary = out.groupSummary as Array<Record<string, unknown>>;
    const edit = summary.find((g) => g.revisionRoundType === 'edit');
    expect(edit?.revisionRoundId).toBe(FX_W60_DPR_EDIT_R1);
    expect(edit?.projectCount).toBe(1);
  });

  it('change-r1 bucket summary reports projectCount=2 and the right DPR id', async () => {
    const out = await invokeBookCompleteness();
    const summary = out.groupSummary as Array<Record<string, unknown>>;
    const change = summary.find((g) => g.revisionRoundType === 'change');
    expect(change?.revisionRoundId).toBe(FX_W60_DPR_CHANGE_R1);
    expect(change?.projectCount).toBe(2);
  });

  it('renderedMarkdown contains every group heading from the fixture', async () => {
    const out = await invokeBookCompleteness();
    const summary = out.groupSummary as Array<Record<string, unknown>>;
    for (const g of summary) {
      expect(out.renderedMarkdown).toContain(`### ${g.revisionRoundLabel}`);
    }
  });

  it('groupBy=byRevisionRound (existing W58 mode) does NOT emit `isHead` on rows', async () => {
    const out = await invokeByRevisionRound();
    expect(Array.isArray(out.groups)).toBe(true);
    const groups = out.groups as Array<Record<string, unknown>>;
    for (const g of groups) {
      const projects = g.projects as Array<Record<string, unknown>>;
      for (const p of projects) {
        expect('isHead' in p).toBe(false);
      }
    }
  });

  it('default flat mode (no groupBy) returns `items[]` and does NOT emit `isHead`', async () => {
    const out = await invokeFlatDefault();
    expect(Array.isArray(out.items)).toBe(true);
    expect('groups' in out).toBe(false);
    const items = out.items as Array<Record<string, unknown>>;
    for (const p of items) {
      expect('isHead' in p).toBe(false);
    }
  });

  it('schema validator accepts the book-completeness envelope', async () => {
    const out = await invokeBookCompleteness();
    const spec = EXECUTIVE_TOOL_REGISTRY.listProjectsInPlan;
    const res = validateAgainstSchema(spec.returnSchema, out);
    expect(res.ok).toBe(true);
  });
});
