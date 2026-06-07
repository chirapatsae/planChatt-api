import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { UNIFIED_PROJECT_AGGREGATOR } from 'src/ai-executive-chat/aggregation/tokens';

import { UnifiedProjectsService } from './unified-projects.service';
import { UnifiedProjectEnricherService } from './services/unified-project-enricher.service';
import type { EnrichedUnifiedProject } from './types/enriched-unified-project';

/**
 * Wave staff-home-lists — BE-01 spec.
 *
 * Proves the three NON-NEGOTIABLE area-scope invariants of
 * `UnifiedProjectsService.staffList` (§1 / §3 / §4.1):
 *   1. plain `staff` are AREA-SCOPED — the aggregator is called with the
 *      caller's responsible amphoe ids (PG) and agency ids (RPG/SPG), split
 *      across two kind-specific calls so the per-dimension filters never AND
 *      across kinds; the result is a SUBSET of the system-wide set.
 *   2. `admin` / `super-admin` BYPASS the area filter (system-wide, no
 *      `filters`), identical to `executiveList`.
 *   3. plain `staff` with ZERO responsibilities FAIL-CLOSED to `[]` —
 *      the aggregator is NEVER called (no global scan).
 *
 * The aggregator + enricher are mocked so the test exercises ONLY the
 * service's scope-resolution + delegation logic.
 */

function enriched(
  id: string,
  statusName: string,
  kind: EnrichedUnifiedProject['projectKind'] = 'main',
): EnrichedUnifiedProject {
  return {
    projectId: id,
    projectKind: kind,
    status: { name: statusName },
    executiveStatusGroup: null,
  } as unknown as EnrichedUnifiedProject;
}

describe('UnifiedProjectsService.staffList — area scope (§1/§3/§4.1)', () => {
  let service: UnifiedProjectsService;
  let aggregator: {
    listUnifiedProjects: jest.Mock;
    countExecutiveStatusBreakdown: jest.Mock;
    groupedExecutiveStatusBreakdown: jest.Mock;
  };
  let enricher: { enrich: jest.Mock };
  let whRepo: { findOne: jest.Mock };

  beforeEach(async () => {
    aggregator = {
      listUnifiedProjects: jest.fn().mockResolvedValue([]),
      countExecutiveStatusBreakdown: jest.fn(),
      groupedExecutiveStatusBreakdown: jest.fn(),
    };
    enricher = { enrich: jest.fn(async (rows: unknown[]) => rows) };
    whRepo = { findOne: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        UnifiedProjectsService,
        { provide: UNIFIED_PROJECT_AGGREGATOR, useValue: aggregator },
        { provide: UnifiedProjectEnricherService, useValue: enricher },
        { provide: getRepositoryToken(WorkHistory), useValue: whRepo },
      ],
    }).compile();

    service = moduleRef.get(UnifiedProjectsService);
  });

  it('scopes plain staff to their responsible amphoes (PG) + agencies (RPG/SPG), and the result is a subset of system-wide', async () => {
    whRepo.findOne.mockResolvedValue({
      id: 'wh-staff',
      role: { name: 'staff' },
      workStatus: { name: 'approved' },
      workHistoryResponsibleAmphoe: [{ amphoe: { id: 'amp-1' } }],
      workHistoryResponsibleGovernmentAgency: [
        { governmentAgency: { id: '77' } },
      ],
    });

    // PG call (main, amphoe-scoped) returns one row; RPG/SPG call
    // (agency-scoped) returns another. System-wide would also include
    // 'pg-out-of-area' / 'rpg-out-of-area', which the scope excludes.
    aggregator.listUnifiedProjects.mockImplementation(
      async (q: { scope: string[]; filters?: Record<string, unknown> }) => {
        if (q.scope.includes('main')) {
          expect(q.filters).toEqual({ amphoeIds: ['amp-1'] });
          return [enriched('pg-in-area', 'Pending', 'main')];
        }
        expect(q.scope).toEqual(['revised', 'supplement']);
        expect(q.filters).toEqual({ agencyIds: ['77'] });
        return [enriched('rpg-in-area', 'Verified', 'revised')];
      },
    );

    const out = (await service.staffList('user-1', {
      developmentPlanId: undefined,
      countOnly: false,
    })) as EnrichedUnifiedProject[];

    const ids = out.map((r) => r.projectId).sort();
    expect(ids).toEqual(['pg-in-area', 'rpg-in-area']);
    // Out-of-area rows never appeared (the scope filter never returned them).
    expect(ids).not.toContain('pg-out-of-area');
    // Two kind-split calls, each carrying exactly ONE dimension filter.
    expect(aggregator.listUnifiedProjects).toHaveBeenCalledTimes(2);
  });

  it('admin bypasses the area filter — single system-wide call, no filters (parity with executiveList)', async () => {
    whRepo.findOne.mockResolvedValue({
      id: 'wh-admin',
      role: { name: 'admin' },
      workStatus: { name: 'approved' },
      workHistoryResponsibleAmphoe: [],
      workHistoryResponsibleGovernmentAgency: [],
    });
    aggregator.listUnifiedProjects.mockResolvedValue([
      enriched('any', 'Pending', 'main'),
    ]);

    await service.staffList('admin-user', {
      developmentPlanId: undefined,
      countOnly: false,
    });

    expect(aggregator.listUnifiedProjects).toHaveBeenCalledTimes(1);
    expect(aggregator.listUnifiedProjects).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: ['main', 'revised', 'supplement'],
        filters: undefined,
      }),
    );
  });

  it('fail-closed: plain staff with zero responsibilities returns [] WITHOUT calling the aggregator', async () => {
    whRepo.findOne.mockResolvedValue({
      id: 'wh-staff-empty',
      role: { name: 'staff' },
      workStatus: { name: 'approved' },
      workHistoryResponsibleAmphoe: [],
      workHistoryResponsibleGovernmentAgency: [],
    });

    const out = await service.staffList('staff-empty', {
      developmentPlanId: undefined,
      countOnly: false,
    });

    expect(out).toEqual([]);
    expect(aggregator.listUnifiedProjects).not.toHaveBeenCalled();
    expect(aggregator.countExecutiveStatusBreakdown).not.toHaveBeenCalled();
  });

  it('no current WorkHistory → graceful [] (no aggregator call)', async () => {
    whRepo.findOne.mockResolvedValue(null);

    const out = await service.staffList('ghost', {
      developmentPlanId: undefined,
      countOnly: false,
    });

    expect(out).toEqual([]);
    expect(aggregator.listUnifiedProjects).not.toHaveBeenCalled();
  });

  it('staff with amphoes but NO agencies → only the main (amphoe) call, never an agency global scan', async () => {
    whRepo.findOne.mockResolvedValue({
      id: 'wh-amp-only',
      role: { name: 'staff' },
      workStatus: { name: 'approved' },
      workHistoryResponsibleAmphoe: [{ amphoe: { id: 'amp-9' } }],
      workHistoryResponsibleGovernmentAgency: [],
    });
    aggregator.listUnifiedProjects.mockResolvedValue([]);

    await service.staffList('amp-only', {
      developmentPlanId: undefined,
      countOnly: false,
    });

    expect(aggregator.listUnifiedProjects).toHaveBeenCalledTimes(1);
    expect(aggregator.listUnifiedProjects).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: ['main'],
        filters: { amphoeIds: ['amp-9'] },
      }),
    );
  });

  it('staffList strips W67 in-flight statuses exactly like executiveList', async () => {
    whRepo.findOne.mockResolvedValue({
      id: 'wh-admin',
      role: { name: 'super-admin' },
      workStatus: { name: 'approved' },
      workHistoryResponsibleAmphoe: [],
      workHistoryResponsibleGovernmentAgency: [],
    });
    aggregator.listUnifiedProjects.mockResolvedValue([
      enriched('keep', 'Pending', 'main'),
      enriched('drop-ready', 'Ready', 'main'),
      enriched('drop-pullback', 'Pull_Back', 'main'),
    ]);

    const out = (await service.staffList('sa', {
      developmentPlanId: undefined,
      countOnly: false,
    })) as EnrichedUnifiedProject[];

    expect(out.map((r) => r.projectId)).toEqual(['keep']);
  });
});
