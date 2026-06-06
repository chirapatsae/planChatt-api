import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { EquipmentProjectGroup } from 'src/equipment-project-group/entities/equipment-project-group.entity';
import { RevisedEquipmentProjectGroup } from 'src/revised-equipment-project-group/entities/revised-equipment-project-group.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

import { UnifiedEquipmentService } from './unified-equipment.service';
import type { UnifiedEquipmentRow } from './types/unified-equipment-row';

/**
 * Wave Equipment-on-Executive-Overall — BE-01 spec.
 *
 * Covers the executive-list post-processing on top of the shared
 * EPG+RELPG HEAD-of-lineage merge:
 *   - §W67 exclusion of in-flight statuses (Ready / Pull_Back /
 *     Returned_For_Revision)
 *   - §W67 `executiveStatusGroup` tagging via the canonical mapping
 *   - owner-list output left untouched (no `executiveStatusGroup`)
 *
 * The two private head-row loaders are spied so the test exercises ONLY
 * the post-projection filter + tag logic (the loaders themselves carry
 * the §14.2 anti-join, covered by the owner-list path).
 */
function makeRow(
  overrides: Partial<UnifiedEquipmentRow> & { statusName: string },
): UnifiedEquipmentRow {
  const { statusName, ...rest } = overrides;
  return {
    kind: 'equipment',
    id: `id-${statusName}`,
    equipmentName: `eq-${statusName}`,
    targetOutput: null,
    expectedResults: null,
    indicator: null,
    equipmentCategory: null,
    strategy: null,
    tactic: null,
    plan: null,
    developmentIssue: null,
    developmentPlan: {
      id: 'plan-1',
      name: 'plan',
      startYear: null,
      endYear: null,
      isLatest: true,
      isBooked: false,
      reportFormat: 'STRATEGY_BASED',
    },
    developmentPlanRevision: undefined,
    status: { name: statusName, thName: statusName, statusAt: null },
    hasDescendant: false,
    isBooked: false,
    bookedAt: null,
    pageNumber: null,
    budgets: [],
    createdBy: null,
    createdByWorkHistoryId: null,
    responsibleAgency: null,
    createdAt: new Date().toISOString(),
    ...rest,
  };
}

describe('UnifiedEquipmentService.executiveList', () => {
  let service: UnifiedEquipmentService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        UnifiedEquipmentService,
        { provide: getRepositoryToken(EquipmentProjectGroup), useValue: {} },
        {
          provide: getRepositoryToken(RevisedEquipmentProjectGroup),
          useValue: {},
        },
        { provide: getRepositoryToken(WorkHistory), useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(UnifiedEquipmentService);
  });

  it('excludes W67 in-flight statuses and tags survivors with executiveStatusGroup', async () => {
    const epgRows = [
      makeRow({ statusName: 'Ready', id: 'epg-ready' }),
      makeRow({ statusName: 'Pending', id: 'epg-pending' }),
      makeRow({ statusName: 'Pull_Back', id: 'epg-pullback' }),
    ];
    const relpgRows = [
      makeRow({
        statusName: 'Approved',
        id: 'relpg-approved',
        kind: 'revised-equipment',
      }),
      makeRow({
        statusName: 'Returned_For_Revision',
        id: 'relpg-rfr',
        kind: 'revised-equipment',
      }),
      makeRow({
        statusName: 'Verified',
        id: 'relpg-verified',
        kind: 'revised-equipment',
      }),
      makeRow({
        statusName: 'Rejected',
        id: 'relpg-rejected',
        kind: 'revised-equipment',
      }),
    ];

    jest
      .spyOn(service as any, 'loadEpgHeadRows')
      .mockResolvedValue(epgRows);
    jest
      .spyOn(service as any, 'loadRelpgHeadRows')
      .mockResolvedValue(relpgRows);

    const out = await service.executiveList({ developmentPlanId: 'plan-1' });

    const byId = new Map(out.map((r) => [r.id, r]));

    // In-flight statuses are stripped.
    expect(byId.has('epg-ready')).toBe(false);
    expect(byId.has('epg-pullback')).toBe(false);
    expect(byId.has('relpg-rfr')).toBe(false);

    // Survivors present + correctly tagged (canonical W67 mapping).
    expect(byId.get('epg-pending')?.executiveStatusGroup).toBe('pending_review');
    expect(byId.get('relpg-verified')?.executiveStatusGroup).toBe(
      'awaiting_approval',
    );
    expect(byId.get('relpg-approved')?.executiveStatusGroup).toBe('approved');
    expect(byId.get('relpg-rejected')?.executiveStatusGroup).toBe('rejected');

    // Every emitted row has a non-null group.
    for (const r of out) {
      expect(r.executiveStatusGroup).toBeDefined();
    }
  });

  it('drops rows with an empty status name defensively (maps to null group)', async () => {
    jest
      .spyOn(service as any, 'loadEpgHeadRows')
      .mockResolvedValue([makeRow({ statusName: '', id: 'epg-empty' })]);
    jest.spyOn(service as any, 'loadRelpgHeadRows').mockResolvedValue([]);

    const out = await service.executiveList({});

    expect(out).toHaveLength(0);
  });

  it('passes a null owner filter (system-wide) to both loaders', async () => {
    const epgSpy = jest
      .spyOn(service as any, 'loadEpgHeadRows')
      .mockResolvedValue([]);
    const relpgSpy = jest
      .spyOn(service as any, 'loadRelpgHeadRows')
      .mockResolvedValue([]);

    await service.executiveList({ developmentPlanId: 'plan-7' });

    expect(epgSpy).toHaveBeenCalledWith('plan-7', null);
    expect(relpgSpy).toHaveBeenCalledWith('plan-7', null);
  });
});
