import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { StaffHomeService } from './staff-home.service';
import { TrackingStatus } from '../tracking-status/entities/tracking-status.entity';
import { WorkHistory } from '../work-history/entities/work-history.entity';

/**
 * PHASE2-BE-01 — Staff Home aging/overdue aggregator.
 * BE-01 (wave-staff-home-actionable) — drill-down enrichment.
 *
 * Validates the authority gate (§3 / §2), the fail-closed area scope
 * (§3 / §4.1), the bucket classification (DOCS-02 contract), AND the BE-01
 * enrichment fields (bookKind / bookLabel / actionRoute / pageNumber /
 * topItems). The query is mocked at the QueryBuilder boundary — this is a
 * read-only aggregator, so the test asserts ZERO writes (the service only
 * ever calls `getRawMany`; no save/insert/update/delete repo method exists
 * on the mocks).
 */
describe('StaffHomeService (PHASE2-BE-01 + BE-01 enrichment)', () => {
  let service: StaffHomeService;
  let workHistoryRepo: jest.Mocked<Pick<Repository<WorkHistory>, 'findOne'>>;
  /** Raw rows returned per createQueryBuilder() call, in call order. */
  let rawRowsByCall: Array<Array<Record<string, unknown>>>;
  let createQueryBuilderCalls: number;

  const daysAgo = (n: number): Date => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    // pull slightly past midnight to make ceil deterministic
    d.setHours(d.getHours() - 1);
    return d;
  };

  /** Build a raw row with the post-enrichment SELECT aliases. */
  const row = (
    over: Partial<Record<string, unknown>> & {
      projectid: string;
      statusname: string;
      createat: Date;
    },
  ): Record<string, unknown> => ({
    title: null,
    statusth: null,
    isbooked: false,
    pagenumber: null,
    planname: null,
    revisionnumber: null,
    revisiontypename: null,
    supplementnumber: null,
    ...over,
  });

  const makeQb = () => {
    const qb: any = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockImplementation(() => {
        const rows = rawRowsByCall[createQueryBuilderCalls] ?? [];
        createQueryBuilderCalls += 1;
        return Promise.resolve(rows);
      }),
    };
    return qb;
  };

  beforeEach(async () => {
    rawRowsByCall = [];
    createQueryBuilderCalls = 0;

    const trackingStatusRepo = {
      createQueryBuilder: jest.fn().mockImplementation(() => makeQb()),
      // Intentionally NO save/insert/update/delete — proves §18.13 zero-write.
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StaffHomeService,
        {
          provide: getRepositoryToken(TrackingStatus),
          useValue: trackingStatusRepo,
        },
        {
          provide: getRepositoryToken(WorkHistory),
          useValue: { findOne: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(StaffHomeService);
    workHistoryRepo = module.get(getRepositoryToken(WorkHistory));
  });

  it('returns graceful empty DTO when caller has no current WorkHistory', async () => {
    (workHistoryRepo.findOne as jest.Mock).mockResolvedValue(null);
    const res = await service.getOverdue('user-1');
    expect(res.totalAging).toBe(0);
    expect(res.totalOverdue).toBe(0);
    expect(res.lanes).toHaveLength(5);
    expect(res.lanes.map((l) => l.lane)).toEqual([
      'mainPlan',
      'revisionEdit',
      'revisionChange',
      'supplement',
      'equipment',
    ]);
    // empty stages still carry the topItems array (back-compat shape).
    expect(res.lanes[0].stages[0].topItems).toEqual([]);
    expect(res.lanes[0].stages[0].oldest).toBeNull();
  });

  it('throws 401 when workStatus is not approved', async () => {
    (workHistoryRepo.findOne as jest.Mock).mockResolvedValue({
      role: { name: 'staff' },
      workStatus: { name: 'pending' },
      workHistoryResponsibleAmphoe: [],
      workHistoryResponsibleGovernmentAgency: [],
    });
    await expect(service.getOverdue('user-1')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('throws 403 when role is not staff-lead', async () => {
    (workHistoryRepo.findOne as jest.Mock).mockResolvedValue({
      role: { name: 'user' },
      workStatus: { name: 'approved' },
      workHistoryResponsibleAmphoe: [],
      workHistoryResponsibleGovernmentAgency: [],
    });
    await expect(service.getOverdue('user-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('fail-closed: plain staff with zero responsibilities sees all-zero (no query issued)', async () => {
    (workHistoryRepo.findOne as jest.Mock).mockResolvedValue({
      role: { name: 'staff' },
      workStatus: { name: 'approved' },
      workHistoryResponsibleAmphoe: [],
      workHistoryResponsibleGovernmentAgency: [],
    });
    const res = await service.getOverdue('user-1');
    expect(res.totalAging).toBe(0);
    // No lane should have queried since every scope is empty.
    expect(createQueryBuilderCalls).toBe(0);
  });

  it('buckets ages into d0_3 / d4_7 / d8_14 / d15p and flags overdue', async () => {
    (workHistoryRepo.findOne as jest.Mock).mockResolvedValue({
      role: { name: 'admin' }, // bypass area filter
      workStatus: { name: 'approved' },
      workHistoryResponsibleAmphoe: [],
      workHistoryResponsibleGovernmentAgency: [],
    });

    // mainPlan lane is the FIRST aggregateLane call (index 0).
    rawRowsByCall[0] = [
      row({ projectid: 'p1', title: 'A', statusname: 'Pending', createat: daysAgo(2) }),
      row({ projectid: 'p2', title: 'B', statusname: 'Pending', createat: daysAgo(6) }),
      row({ projectid: 'p3', title: 'C', statusname: 'Verified', createat: daysAgo(10) }),
      row({ projectid: 'p4', title: 'D', statusname: 'Pending_Approval', createat: daysAgo(40) }),
    ];

    const res = await service.getOverdue('user-1');
    const main = res.lanes.find((l) => l.lane === 'mainPlan')!;
    const pending = main.stages.find((s) => s.stage === 'Pending')!;
    const verified = main.stages.find((s) => s.stage === 'Verified')!;
    const approval = main.stages.find((s) => s.stage === 'Pending_Approval')!;

    expect(pending.buckets.d0_3).toBe(1);
    expect(pending.buckets.d4_7).toBe(1);
    expect(pending.total).toBe(2);
    expect(verified.buckets.d8_14).toBe(1);
    expect(approval.buckets.d15p).toBe(1);
    expect(approval.overdue).toBe(1);
    expect(approval.oldest?.projectId).toBe('p4');
    expect(res.totalOverdue).toBe(1);
    expect(res.totalAging).toBe(4);
    expect(res.overdueThresholdDays).toBe(15);
  });

  it('enriches mainPlan items: bookKind, bookLabel, actionRoute, statusTh, pageNumber, topItems', async () => {
    (workHistoryRepo.findOne as jest.Mock).mockResolvedValue({
      role: { name: 'admin' },
      workStatus: { name: 'approved' },
      workHistoryResponsibleAmphoe: [],
      workHistoryResponsibleGovernmentAgency: [],
    });

    rawRowsByCall[0] = [
      row({
        projectid: 'p1',
        title: 'โครงการ A',
        statusname: 'Pending',
        statusth: 'รอตรวจสอบ',
        createat: daysAgo(20),
        isbooked: true,
        pagenumber: 12,
        planname: 'แผนพัฒนาท้องถิ่น 2566-2570',
      }),
    ];

    const res = await service.getOverdue('user-1');
    const main = res.lanes.find((l) => l.lane === 'mainPlan')!;
    const pending = main.stages.find((s) => s.stage === 'Pending')!;

    expect(pending.topItems).toHaveLength(1);
    const item = pending.topItems[0];
    expect(item.bookKind).toBe('mainPlan');
    expect(item.bookLabel).toBe('แผนพัฒนาท้องถิ่น 2566-2570');
    expect(item.actionRoute).toBe('/agency/admin/pending');
    expect(item.detailRoute).toBeNull();
    expect(item.historyRoute).toBeNull();
    expect(item.statusTh).toBe('รอตรวจสอบ');
    expect(item.stage).toBe('Pending');
    expect(item.stageLabelTh).toBe('รอตรวจสอบ');
    expect(item.isBooked).toBe(true);
    expect(item.pageNumber).toBe(12);
    // oldest === topItems[0] (back-compat)
    expect(pending.oldest).toEqual(item);
  });

  it('topItems caps at 5 per stage and sorts by ageDays DESC', async () => {
    (workHistoryRepo.findOne as jest.Mock).mockResolvedValue({
      role: { name: 'admin' },
      workStatus: { name: 'approved' },
      workHistoryResponsibleAmphoe: [],
      workHistoryResponsibleGovernmentAgency: [],
    });

    rawRowsByCall[0] = [3, 30, 9, 1, 22, 7, 15].map((d, i) =>
      row({ projectid: `p${i}`, statusname: 'Pending', createat: daysAgo(d) }),
    );

    const res = await service.getOverdue('user-1');
    const pending = res.lanes
      .find((l) => l.lane === 'mainPlan')!
      .stages.find((s) => s.stage === 'Pending')!;

    expect(pending.topItems).toHaveLength(5);
    const ages = pending.topItems.map((i) => i.ageDays);
    expect(ages).toEqual([...ages].sort((a, b) => b - a)); // DESC
    expect(ages[0]).toBeGreaterThanOrEqual(ages[4]);
    // oldest is the largest age (≈30d).
    expect(pending.oldest?.ageDays).toBe(ages[0]);
  });

  it('splits revision into revisionEdit / revisionChange lanes (RPG + RELPG per type) and reconciles', async () => {
    (workHistoryRepo.findOne as jest.Mock).mockResolvedValue({
      role: { name: 'super-admin' }, // bypass
      workStatus: { name: 'approved' },
      workHistoryResponsibleAmphoe: [],
      workHistoryResponsibleGovernmentAgency: [],
    });

    // 2026-07-14 — revision lane split. The aggregator now issues FOUR
    // revision sub-queries; the mock returns rows by call index (it does NOT
    // apply the revision_type predicate itself), so edit rows go in the
    // edit-lane indices and change rows in the change-lane indices.
    // Call order: 0=mainPlan, 1=RPG-edit, 2=RELPG-edit, 3=RPG-change,
    // 4=RELPG-change, 5=SPG, 6=SEPG, 7=EPG.
    rawRowsByCall[1] = [
      // edit RPG → revisionEdit
      row({
        projectid: 'r1',
        title: 'R-edit',
        statusname: 'Pending',
        createat: daysAgo(5),
        planname: 'แผน X',
        revisionnumber: 2,
        revisiontypename: 'แก้ไข',
      }),
    ];
    rawRowsByCall[2] = [
      // edit RELPG → revisionEdit
      row({
        projectid: 'e1',
        title: 'E-equip-edit',
        statusname: 'Pending',
        createat: daysAgo(1),
        planname: 'แผน X',
        revisionnumber: 2,
        revisiontypename: 'แก้ไข',
      }),
    ];
    rawRowsByCall[3] = [
      // change RPG → revisionChange (overdue: 20d → d15p)
      row({
        projectid: 'r2',
        title: 'R-change',
        statusname: 'Pending',
        createat: daysAgo(20),
        planname: 'แผน X',
        revisionnumber: 3,
        revisiontypename: 'เปลี่ยนแปลง',
      }),
    ];
    rawRowsByCall[4] = [
      // change RELPG → revisionChange (RELPG keeps the /revise/edit route per §9.1.2)
      row({
        projectid: 'e2',
        title: 'E-equip-change',
        statusname: 'Pending',
        createat: daysAgo(2),
        planname: 'แผน X',
        revisionnumber: 2,
        revisiontypename: 'เปลี่ยนแปลง',
      }),
    ];

    const res = await service.getOverdue('user-1');

    // The combined 'revision' lane no longer exists.
    expect(
      res.lanes.find((l) => (l.lane as string) === 'revision'),
    ).toBeUndefined();
    const editLane = res.lanes.find((l) => l.lane === 'revisionEdit')!;
    const changeLane = res.lanes.find((l) => l.lane === 'revisionChange')!;
    const editPending = editLane.stages.find((s) => s.stage === 'Pending')!;
    const changePending = changeLane.stages.find((s) => s.stage === 'Pending')!;

    expect(editPending.total).toBe(2); // r1 + e1
    expect(changePending.total).toBe(2); // r2 + e2

    // Reconciliation: edit + change == pre-split combined (4), and the overdue
    // count is unchanged (only r2 at 20d is d15p).
    expect(editPending.total + changePending.total).toBe(4);
    expect(res.totalOverdue).toBe(1);

    const editById = new Map(editPending.topItems.map((i) => [i.projectId, i]));
    const changeById = new Map(
      changePending.topItems.map((i) => [i.projectId, i]),
    );
    const edit = editById.get('r1')!;
    const editRelpg = editById.get('e1')!;
    const change = changeById.get('r2')!;
    const changeRelpg = changeById.get('e2')!;

    // edit RPG — in revisionEdit lane
    expect(edit.bookKind).toBe('edit');
    expect(edit.bookLabel).toBe('แผน X · แก้ไข ครั้งที่ 2');
    expect(edit.actionRoute).toBe('/revise/edit/admin/pending');
    expect(edit.detailRoute).toBe('/revision/detail/version/r1');
    expect(edit.historyRoute).toBe('/revision/tracking/detail/r1');

    // edit RELPG — in revisionEdit lane, /revise/edit/* queue
    expect(editRelpg.bookKind).toBe('revised-equipment');
    expect(editRelpg.bookLabel).toBe('แผน X · แก้ไข ครั้งที่ 2');
    expect(editRelpg.actionRoute).toBe('/revise/edit/admin/pending');
    expect(editRelpg.detailRoute).toBe('/revision/detail/equipment/version/e1');
    expect(editRelpg.historyRoute).toBe('/revision/tracking/equipment/detail/e1');

    // change RPG — in revisionChange lane
    expect(change.bookKind).toBe('change');
    expect(change.bookLabel).toBe('แผน X · เปลี่ยนแปลง ครั้งที่ 3');
    expect(change.actionRoute).toBe('/revise/change/admin/pending');
    expect(change.detailRoute).toBe('/revision/detail/version/r2');

    // change RELPG — sits in revisionChange lane BUT its item actionRoute
    // stays /revise/edit/admin/pending (§9.1.2 RELPG→edit-queue fold, unchanged).
    expect(changeRelpg.bookKind).toBe('revised-equipment');
    expect(changeRelpg.bookLabel).toBe('แผน X · เปลี่ยนแปลง ครั้งที่ 2');
    expect(changeRelpg.actionRoute).toBe('/revise/edit/admin/pending');
  });

  it('supplement items: bookLabel + null detail route; equipment items: pageNumber null', async () => {
    (workHistoryRepo.findOne as jest.Mock).mockResolvedValue({
      role: { name: 'admin' },
      workStatus: { name: 'approved' },
      workHistoryResponsibleAmphoe: [],
      workHistoryResponsibleGovernmentAgency: [],
    });

    // Call order (post revision-split): 0=mainPlan, 1=RPG-edit, 2=RELPG-edit,
    // 3=RPG-change, 4=RELPG-change, 5=SPG(supplement),
    // 6=SEPG(supplement-equipment), 7=EPG(equipment).
    rawRowsByCall[5] = [
      row({
        projectid: 's1',
        title: 'S1',
        statusname: 'Verified',
        createat: daysAgo(4),
        planname: 'แผน Y',
        supplementnumber: 1,
      }),
    ];
    rawRowsByCall[6] = [
      // SEPG — folds into the supplement lane with its own bookKind.
      row({
        projectid: 'sq1',
        title: 'ครุภัณฑ์ เพิ่มเติม 1',
        statusname: 'Pending',
        createat: daysAgo(2),
        isbooked: true,
        planname: 'แผน Y',
        supplementnumber: 1,
      }),
    ];
    rawRowsByCall[7] = [
      row({
        projectid: 'q1',
        title: 'ครุภัณฑ์ 1',
        statusname: 'Pending',
        createat: daysAgo(4),
        isbooked: true,
        planname: 'แผน Y',
      }),
    ];

    const res = await service.getOverdue('user-1');

    const supp = res.lanes
      .find((l) => l.lane === 'supplement')!
      .stages.find((s) => s.stage === 'Verified')!.topItems[0];
    expect(supp.bookKind).toBe('supplement');
    expect(supp.bookLabel).toBe('แผน Y · ฉบับเพิ่มเติม ครั้งที่ 1');
    expect(supp.actionRoute).toBe('/supplement/admin/print-presentation');
    expect(supp.detailRoute).toBeNull();
    expect(supp.historyRoute).toBeNull();

    // SEPG — folded into the supplement lane (Pending stage), own bookKind.
    const sepg = res.lanes
      .find((l) => l.lane === 'supplement')!
      .stages.find((s) => s.stage === 'Pending')!.topItems[0];
    expect(sepg.bookKind).toBe('supplement-equipment');
    expect(sepg.bookLabel).toBe('แผน Y · ฉบับเพิ่มเติม ครั้งที่ 1');
    expect(sepg.actionRoute).toBe('/supplement/admin/pending');
    expect(sepg.pageNumber).toBeNull();

    const equip = res.lanes
      .find((l) => l.lane === 'equipment')!
      .stages.find((s) => s.stage === 'Pending')!.topItems[0];
    expect(equip.bookKind).toBe('equipment');
    expect(equip.bookLabel).toBe('แผน Y');
    expect(equip.actionRoute).toBe('/agency/admin/pending');
    // Equipment never surfaces a page number (DOCS-01 §7.4).
    expect(equip.pageNumber).toBeNull();
    expect(equip.isBooked).toBe(true);
  });

  it('bookLabel falls back to lane label when plan name is missing (legacy rows)', async () => {
    (workHistoryRepo.findOne as jest.Mock).mockResolvedValue({
      role: { name: 'admin' },
      workStatus: { name: 'approved' },
      workHistoryResponsibleAmphoe: [],
      workHistoryResponsibleGovernmentAgency: [],
    });

    rawRowsByCall[0] = [
      row({ projectid: 'p1', statusname: 'Pending', createat: daysAgo(2), planname: null }),
    ];

    const res = await service.getOverdue('user-1');
    const item = res.lanes
      .find((l) => l.lane === 'mainPlan')!
      .stages.find((s) => s.stage === 'Pending')!.topItems[0];
    expect(item.bookLabel).toBe('เล่มหลัก');
  });

  it('§18.13 zero-write: the aggregator never invokes a mutating repo method', async () => {
    (workHistoryRepo.findOne as jest.Mock).mockResolvedValue({
      role: { name: 'admin' },
      workStatus: { name: 'approved' },
      workHistoryResponsibleAmphoe: [],
      workHistoryResponsibleGovernmentAgency: [],
    });
    rawRowsByCall[0] = [
      row({ projectid: 'p1', statusname: 'Pending', createat: daysAgo(2), planname: 'แผน' }),
    ];

    const tsRepo: any = (service as any).trackingStatusRepo;
    await service.getOverdue('user-1');

    // The only repo entry point used is createQueryBuilder → getRawMany.
    for (const method of ['save', 'insert', 'update', 'delete', 'softDelete']) {
      expect(tsRepo[method]).toBeUndefined();
    }
    expect(tsRepo.createQueryBuilder).toHaveBeenCalled();
  });
});
