/**
 * Wave 66 W66-BE-AGG-01 — listProjectsWithoutResponsibleAgency unit spec.
 *
 * Coverage:
 *   - Empty plan (no NULL-FK rows)              → totalCount=0, items=[]
 *   - NULL-FK rows in main only                 → scopeBreakdown.main reflects truth
 *   - NULL-FK rows in edit only                 → scopeBreakdown.edit reflects truth
 *   - NULL-FK rows in change only               → scopeBreakdown.change reflects truth
 *   - NULL-FK rows in all 3 sources             → totalCount sums; items[] include all kinds
 *   - Disclosure copy is the canonical W57 rule #26 string on every row
 *
 * §17.2 advisory only / §17.3 read-only — the spec uses an in-memory
 * DataSource stub; no DB and no mutation paths.
 */

import { EXECUTIVE_TOOL_HANDLERS } from '../handlers/executive-tool-handlers';
import type { ExecutiveCallerContext, ExecutiveToolHandlerDeps } from '../handlers/handler-types';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { PENDING_RESPONSIBLE_AGENCY_DISCLOSURE } from '../../aggregation/constants/revision-round-label';

interface PgFixture {
  pgid: string;
  title: string;
  pagenumber: number | null;
  statusname: string | null;
  planid: string;
  planname: string;
  amphoename: string | null;
  laoname: string | null;
  budget: string | null;
}

interface RpgFixture {
  rpgid: string;
  title: string;
  pagenumber: number | null;
  statusname: string | null;
  planid: string;
  planname: string;
  dprid: string;
  revisionnumber: number;
  dprdescription: string | null;
  amphoename: string | null;
  laoname: string | null;
  budget: string | null;
  rt_name: string; // 'แก้ไข' or 'เปลี่ยนแปลง'
}

function makeQbStub(rows: unknown[], count: number) {
  const qb: Record<string, unknown> = {};
  const chain = () => qb;
  qb.select = chain;
  qb.addSelect = chain;
  qb.innerJoin = chain;
  qb.leftJoin = chain;
  qb.where = chain;
  qb.andWhere = chain;
  qb.orderBy = chain;
  qb.addOrderBy = chain;
  qb.limit = chain;
  qb.getCount = jest.fn(async () => count);
  qb.getRawMany = jest.fn(async () => rows);
  return qb;
}

function makeDataSource(opts: {
  pgRows: PgFixture[];
  editRows: RpgFixture[];
  changeRows: RpgFixture[];
}) {
  // Each call to getRepository().createQueryBuilder() returns a fresh QB.
  // The handler issues TWO calls per branch (count + list), so we rotate
  // pre-built QBs in the order: pgCount, pgList, editCount, editList,
  // changeCount, changeList. Branch order is fixed in the handler.
  const pgQbs = [
    makeQbStub([], opts.pgRows.length),
    makeQbStub(opts.pgRows, opts.pgRows.length),
  ];
  const rpgEditQbs = [
    makeQbStub([], opts.editRows.length),
    makeQbStub(opts.editRows, opts.editRows.length),
  ];
  const rpgChangeQbs = [
    makeQbStub([], opts.changeRows.length),
    makeQbStub(opts.changeRows, opts.changeRows.length),
  ];

  let pgIdx = 0;
  let rpgIdx = 0;
  const rpgQbs = [...rpgEditQbs, ...rpgChangeQbs];

  return {
    getRepository: (entity: unknown) => {
      if (entity === ProjectGroup) {
        return {
          createQueryBuilder: () => pgQbs[pgIdx++ % pgQbs.length],
        };
      }
      if (entity === RevisedProjectGroup) {
        return {
          createQueryBuilder: () => rpgQbs[rpgIdx++ % rpgQbs.length],
        };
      }
      throw new Error(`Unexpected entity in test: ${String(entity)}`);
    },
  };
}

const CTX: ExecutiveCallerContext = {
  userId: 'user-1',
  workHistoryId: 'wh-1',
  roleName: 'staff',
  workStatusName: 'approved',
};

const PLAN_ID = '11111111-1111-1111-1111-111111111111';

function buildDeps(
  ds: ReturnType<typeof makeDataSource>,
): ExecutiveToolHandlerDeps {
  // Tier B services / projectLineage are NOT touched by this handler;
  // pass them as undefined-shaped stubs cast through `unknown`.
  return {
    dataSource: ds as unknown as ExecutiveToolHandlerDeps['dataSource'],
  } as unknown as ExecutiveToolHandlerDeps;
}

describe('listProjectsWithoutResponsibleAgency (W66-BE-AGG-01)', () => {
  const handler = EXECUTIVE_TOOL_HANDLERS.listProjectsWithoutResponsibleAgency;

  it('empty plan — totalCount=0, items=[], scopeBreakdown all zero', async () => {
    const ds = makeDataSource({ pgRows: [], editRows: [], changeRows: [] });
    const result = await handler(
      { planId: PLAN_ID, scope: 'all', limit: 50 },
      CTX,
      buildDeps(ds),
    );
    expect(result.totalCount).toBe(0);
    expect(result.scopeBreakdown).toEqual({ main: 0, edit: 0, change: 0 });
    expect(result.items).toEqual([]);
    expect(result.planId).toBe(PLAN_ID);
  });

  it('NULL-FK in main only — main count populated, edit/change zero', async () => {
    const pgRows: PgFixture[] = [
      {
        pgid: 'pg-1',
        title: 'โครงการถนน A',
        pagenumber: 12,
        statusname: 'Approved',
        planid: PLAN_ID,
        planname: 'แผน A',
        amphoename: 'เมือง',
        laoname: 'ทต.A',
        budget: '500000',
      },
    ];
    const ds = makeDataSource({ pgRows, editRows: [], changeRows: [] });
    const result = await handler(
      { planId: PLAN_ID, scope: 'all', limit: 50 },
      CTX,
      buildDeps(ds),
    );
    expect(result.totalCount).toBe(1);
    expect(result.scopeBreakdown).toEqual({ main: 1, edit: 0, change: 0 });
    const items = result.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].projectKind).toBe('main');
    expect(items[0].projectId).toBe('pg-1');
    expect(items[0].revisionRoundLabel).toBeNull();
    expect(items[0].revisionRoundId).toBeNull();
    expect(items[0].responsibleAgencyDisclosure).toBe(
      PENDING_RESPONSIBLE_AGENCY_DISCLOSURE,
    );
    expect(items[0].budget).toBe(500000);
  });

  it('NULL-FK in edit only — edit count populated; revisionRoundLabel resolved', async () => {
    const editRows: RpgFixture[] = [
      {
        rpgid: 'rpg-edit-1',
        title: 'โครงการน้ำ B',
        pagenumber: 5,
        statusname: 'Pending',
        planid: PLAN_ID,
        planname: 'แผน A',
        dprid: 'dpr-edit-1',
        revisionnumber: 1,
        dprdescription: null,
        amphoename: 'พิมาย',
        laoname: 'ทต.B',
        budget: '120000',
        rt_name: 'แก้ไข',
      },
    ];
    const ds = makeDataSource({ pgRows: [], editRows, changeRows: [] });
    const result = await handler(
      { planId: PLAN_ID, scope: 'all', limit: 50 },
      CTX,
      buildDeps(ds),
    );
    expect(result.totalCount).toBe(1);
    expect(result.scopeBreakdown).toEqual({ main: 0, edit: 1, change: 0 });
    const items = result.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].projectKind).toBe('edit');
    expect(items[0].revisionRoundId).toBe('dpr-edit-1');
    expect(items[0].revisionRoundLabel).toBe('เล่มแก้ไขครั้งที่ 1');
    expect(items[0].responsibleAgencyDisclosure).toBe(
      PENDING_RESPONSIBLE_AGENCY_DISCLOSURE,
    );
  });

  it('NULL-FK in change only — change count populated; revisionRoundLabel resolved', async () => {
    const changeRows: RpgFixture[] = [
      {
        rpgid: 'rpg-change-1',
        title: 'โครงการสะพาน C',
        pagenumber: null,
        statusname: 'Verified',
        planid: PLAN_ID,
        planname: 'แผน A',
        dprid: 'dpr-change-1',
        revisionnumber: 2,
        dprdescription: '   ',
        amphoename: null,
        laoname: null,
        budget: '0',
        rt_name: 'เปลี่ยนแปลง',
      },
    ];
    const ds = makeDataSource({ pgRows: [], editRows: [], changeRows });
    const result = await handler(
      { planId: PLAN_ID, scope: 'all', limit: 50 },
      CTX,
      buildDeps(ds),
    );
    expect(result.totalCount).toBe(1);
    expect(result.scopeBreakdown).toEqual({ main: 0, edit: 0, change: 1 });
    const items = result.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].projectKind).toBe('change');
    expect(items[0].revisionRoundLabel).toBe('เล่มเปลี่ยนแปลงครั้งที่ 2');
    expect(items[0].pageNumber).toBeNull();
    expect(items[0].amphoeName).toBeNull();
    expect(items[0].laoName).toBeNull();
  });

  it('NULL-FK in all 3 sources — totalCount sums; scopeBreakdown matches; items cover all kinds', async () => {
    const pgRows: PgFixture[] = [
      {
        pgid: 'pg-A',
        title: 'A',
        pagenumber: 1,
        statusname: 'Approved',
        planid: PLAN_ID,
        planname: 'แผน A',
        amphoename: null,
        laoname: null,
        budget: '100',
      },
      {
        pgid: 'pg-B',
        title: 'B',
        pagenumber: 2,
        statusname: 'Approved',
        planid: PLAN_ID,
        planname: 'แผน A',
        amphoename: null,
        laoname: null,
        budget: '200',
      },
    ];
    const editRows: RpgFixture[] = [
      {
        rpgid: 'rpg-E1',
        title: 'E1',
        pagenumber: 3,
        statusname: 'Pending',
        planid: PLAN_ID,
        planname: 'แผน A',
        dprid: 'dpr-e1',
        revisionnumber: 1,
        dprdescription: 'รอบแก้ไขที่กำหนดเอง',
        amphoename: null,
        laoname: null,
        budget: '300',
        rt_name: 'แก้ไข',
      },
    ];
    const changeRows: RpgFixture[] = [
      {
        rpgid: 'rpg-C1',
        title: 'C1',
        pagenumber: 4,
        statusname: 'Pending',
        planid: PLAN_ID,
        planname: 'แผน A',
        dprid: 'dpr-c1',
        revisionnumber: 1,
        dprdescription: null,
        amphoename: null,
        laoname: null,
        budget: '400',
        rt_name: 'เปลี่ยนแปลง',
      },
    ];

    const ds = makeDataSource({ pgRows, editRows, changeRows });
    const result = await handler(
      { planId: PLAN_ID, scope: 'all', limit: 50 },
      CTX,
      buildDeps(ds),
    );
    expect(result.totalCount).toBe(4);
    expect(result.scopeBreakdown).toEqual({ main: 2, edit: 1, change: 1 });
    const items = result.items as Array<Record<string, unknown>>;
    const kinds = items.map((it) => it.projectKind).sort();
    expect(kinds).toEqual(['change', 'edit', 'main', 'main']);
    // Description-as-label fallback for the edit row.
    const editItem = items.find((it) => it.projectKind === 'edit');
    expect(editItem?.revisionRoundLabel).toBe('รอบแก้ไขที่กำหนดเอง');
    // Every row carries the canonical disclosure copy.
    for (const it of items) {
      expect(it.responsibleAgencyDisclosure).toBe(
        PENDING_RESPONSIBLE_AGENCY_DISCLOSURE,
      );
    }
  });

  it('province-wide call (planId omitted) — handler returns planId=null and counts walk all 3 branches', async () => {
    const pgRows: PgFixture[] = [
      {
        pgid: 'pg-x',
        title: 'X',
        pagenumber: null,
        statusname: 'Approved',
        planid: PLAN_ID,
        planname: 'แผน X',
        amphoename: null,
        laoname: null,
        budget: '0',
      },
    ];
    const ds = makeDataSource({ pgRows, editRows: [], changeRows: [] });
    const result = await handler({ scope: 'all' }, CTX, buildDeps(ds));
    expect(result.planId).toBeNull();
    expect(result.totalCount).toBe(1);
  });

  it('non-executive role — assertExecutiveRole rejects', async () => {
    const ds = makeDataSource({ pgRows: [], editRows: [], changeRows: [] });
    await expect(
      handler(
        { planId: PLAN_ID, scope: 'all' },
        { ...CTX, roleName: 'user' },
        buildDeps(ds),
      ),
    ).rejects.toThrow('EXECUTIVE_ROLE_REQUIRED');
  });
});
