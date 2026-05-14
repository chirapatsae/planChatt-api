import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PreSubmitSnapshotService } from './pre-submit-snapshot.service';
import { AiPreSubmitSnapshot } from './entities/ai-pre-submit-snapshot.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { CreatePreSubmitSnapshotDto } from './dto/pre-submit-snapshot.dto';

/**
 * Unit tests for PreSubmitSnapshotService (RF5).
 *
 * Focus:
 *   - §17.3 — owner-gated write, staff-lead-gated read
 *   - §17.4 — `snapshot-only` staleness policy → read envelope always
 *     has `isStale: false` regardless of any downstream project mutation
 *   - §17.5 — resubmit soft-deletes prior row; previous content_hash
 *     short-circuits (idempotent)
 */
describe('PreSubmitSnapshotService', () => {
  let service: PreSubmitSnapshotService;

  // Mutable mock registries.
  let snapshotRows: AiPreSubmitSnapshot[];
  let ownerWorkHistoryId: string;
  let callerWorkHistory: Partial<WorkHistory>;
  const callerUserId = 'user-1';
  const targetId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  const makeDto = (
    overrides: Partial<CreatePreSubmitSnapshotDto> = {},
  ): CreatePreSubmitSnapshotDto => ({
    targetKind: 'project-group',
    targetId,
    workflow: 'add',
    result: {
      overallScore: 72,
      readinessLabel: 'ควรปรับปรุง',
      rationale: 'คะแนนทดสอบ',
      strongPoint: 'ดี',
      suggestions: [{ field: 'title', message: 'แก้', priority: 'medium' }],
      checklistSummary: [],
      model: 'gpt-4o',
      categories: { title: { status: 'ok' } },
    },
    project: {
      title: 'โครงการทดสอบ',
      objective: 'วัตถุประสงค์',
      goal: 'เป้าหมาย',
      expected: 'ผลที่คาดว่าจะได้รับ',
      indicator: 'ตัวชี้วัด',
      startLat: 14.9799,
      startLng: 102.0978,
      amphoeId: 3001,
      budgets: [{ year: 2025, quantity: 100000 }],
    },
    classification: {
      reportFormat: 'STRATEGY_BASED',
      strategyName: 'S',
      tacticName: 'T',
      planName: 'P',
    },
    attachments: [],
    ...overrides,
  });

  const snapshotRepoMock = {
    findOne: jest.fn(async ({ where }: any) => {
      return (
        snapshotRows.find(
          (r) =>
            r.targetId === where.targetId &&
            r.targetKind === where.targetKind &&
            r.deletedAt == null,
        ) ?? null
      );
    }),
  };

  const buildRepoManagerRepo = () => ({
    findOne: jest.fn(async ({ where }: any) => {
      return (
        snapshotRows.find(
          (r) =>
            r.targetId === where.targetId &&
            r.targetKind === where.targetKind &&
            (where.deletedAt === IsNull() || where.deletedAt == null
              ? r.deletedAt == null
              : true),
        ) ?? null
      );
    }),
    create: jest.fn((data: Partial<AiPreSubmitSnapshot>) => {
      const row = {
        id: `snap-${snapshotRows.length + 1}`,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: null,
        ...data,
      } as AiPreSubmitSnapshot;
      return row;
    }),
    save: jest.fn(async (row: AiPreSubmitSnapshot) => {
      const existingIdx = snapshotRows.findIndex((r) => r.id === row.id);
      if (existingIdx >= 0) {
        snapshotRows[existingIdx] = row;
      } else {
        snapshotRows.push(row);
      }
      return row;
    }),
  });

  const dataSourceMock: Partial<DataSource> = {
    transaction: jest.fn(async (cb: any) => {
      const repo = buildRepoManagerRepo();
      const manager = { getRepository: () => repo } as any;
      return cb(manager);
    }),
  };

  const projectRepoMock = {
    findOne: jest.fn(async ({ where }: any) => {
      if (where.id !== targetId) return null;
      return {
        id: targetId,
        createdBy: { id: ownerWorkHistoryId },
      } as Partial<ProjectGroup>;
    }),
  };
  const revisedRepoMock = {
    findOne: jest.fn(async () => null),
  };
  const supplementRepoMock = {
    findOne: jest.fn(async () => null),
  };
  const workHistoryRepoMock = {
    findOne: jest.fn(async () => callerWorkHistory),
  };

  beforeEach(async () => {
    snapshotRows = [];
    ownerWorkHistoryId = 'wh-owner';
    callerWorkHistory = {
      id: 'wh-owner',
      isCurrent: true,
      workStatus: { name: 'approved' } as any,
      role: { name: 'user' } as any,
      user: { id: callerUserId } as any,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PreSubmitSnapshotService,
        { provide: getRepositoryToken(AiPreSubmitSnapshot), useValue: snapshotRepoMock },
        { provide: getRepositoryToken(ProjectGroup), useValue: projectRepoMock },
        { provide: getRepositoryToken(RevisedProjectGroup), useValue: revisedRepoMock },
        { provide: getRepositoryToken(SupplementProjectGroup), useValue: supplementRepoMock },
        { provide: getRepositoryToken(WorkHistory), useValue: workHistoryRepoMock },
        { provide: DataSource, useValue: dataSourceMock },
      ],
    }).compile();

    service = module.get(PreSubmitSnapshotService);
    jest.clearAllMocks();
  });

  describe('createSnapshot (owner-only write)', () => {
    it('creates a row when caller is the owner and workStatus=approved', async () => {
      const row = await service.createSnapshot(callerUserId, makeDto());
      expect(row).toBeTruthy();
      expect(row.score0100).toBe(72);
      expect(row.band).toBe('amber'); // 72 is in 50..79 band
      expect(row.stalenessPolicy).toBe('snapshot-only');
      expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(snapshotRows).toHaveLength(1);
    });

    it('rejects with ForbiddenException when caller does not own the target', async () => {
      ownerWorkHistoryId = 'wh-other';
      await expect(
        service.createSnapshot(callerUserId, makeDto()),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects when caller workStatus is not approved', async () => {
      callerWorkHistory = {
        ...callerWorkHistory,
        workStatus: { name: 'pending' } as any,
      };
      await expect(
        service.createSnapshot(callerUserId, makeDto()),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('is idempotent when the content hash is unchanged', async () => {
      const first = await service.createSnapshot(callerUserId, makeDto());
      const second = await service.createSnapshot(callerUserId, makeDto());
      expect(first.id).toBe(second.id);
      expect(snapshotRows.filter((r) => r.deletedAt == null)).toHaveLength(1);
    });

    it('soft-deletes the prior active row and inserts a new one on content change', async () => {
      const first = await service.createSnapshot(callerUserId, makeDto());
      const second = await service.createSnapshot(
        callerUserId,
        makeDto({
          project: {
            ...makeDto().project,
            title: 'โครงการใหม่ ชื่อเปลี่ยน',
          },
        }),
      );
      expect(first.id).not.toBe(second.id);
      const active = snapshotRows.filter((r) => r.deletedAt == null);
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(second.id);
      const archived = snapshotRows.filter((r) => r.deletedAt != null);
      expect(archived).toHaveLength(1);
      expect(archived[0].id).toBe(first.id);
    });
  });

  describe('getActiveSnapshot (staff-lead read)', () => {
    beforeEach(async () => {
      // Pre-populate one snapshot by the owner.
      await service.createSnapshot(callerUserId, makeDto());
      // Now switch caller to staff-lead for reads.
      callerWorkHistory = {
        id: 'wh-staff',
        isCurrent: true,
        workStatus: { name: 'approved' } as any,
        role: { name: 'staff' } as any,
        user: { id: 'staff-1' } as any,
      };
    });

    it('returns envelope with isStale forced to false (snapshot-only §17.4)', async () => {
      const { envelope } = await service.getActiveSnapshot(
        'staff-1',
        'project-group',
        targetId,
      );
      expect(envelope.isStale).toBe(false);
      expect(envelope.stalenessPolicy).toBe('snapshot-only');
      expect(envelope.score).toBe(72);
      expect(envelope.band).toBe('amber');
    });

    it('isStale remains false even when the project-side hash would change', async () => {
      // Simulate the user editing the project AFTER snapshot: the stored
      // row is untouched, and the read envelope STILL returns isStale:false
      // because the policy is `snapshot-only`. This is the §17.4 canon.
      const active = snapshotRows.find((r) => r.deletedAt == null)!;
      active.contentHash = 'changed-hash-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
      const { envelope } = await service.getActiveSnapshot(
        'staff-1',
        'project-group',
        targetId,
      );
      expect(envelope.isStale).toBe(false);
    });

    it('rejects non-staff-lead callers with ForbiddenException', async () => {
      callerWorkHistory = {
        ...callerWorkHistory,
        role: { name: 'user' } as any,
      };
      await expect(
        service.getActiveSnapshot('staff-1', 'project-group', targetId),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns 404 when no active snapshot exists', async () => {
      snapshotRows.forEach((r) => (r.deletedAt = new Date()));
      await expect(
        service.getActiveSnapshot('staff-1', 'project-group', targetId),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects unknown target kinds defensively', async () => {
      await expect(
        service.getActiveSnapshot('staff-1', 'not-a-kind' as any, targetId),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // SUPP-3 BE-05 — Supplement-Project-Group branch coverage
  //
  // Verifies that the `'supplement-project-group'` targetKind flows
  // through the same write / owner-read / staff-read / Wave 10
  // endpoint-rank policy as PG / RPG. The snapshot service was already
  // widened in Wave 46 + SUPP-1 BE-01; this block locks that contract
  // against regressions.
  //
  // Covers CLAUDE.md §17.3, §17.4 (Wave 10 endpoint-rank, Wave 18C
  // upgrade-from-baseline), §17.11.
  // ─────────────────────────────────────────────────────────────────────
  describe('SPG (supplement-project-group) branch', () => {
    const spgTargetId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    const makeSpgDto = (
      overrides: Partial<CreatePreSubmitSnapshotDto> = {},
    ): CreatePreSubmitSnapshotDto => ({
      ...makeDto(),
      targetKind: 'supplement-project-group',
      targetId: spgTargetId,
      workflow: 'add',
      ...overrides,
    });

    beforeEach(() => {
      // Route supplement repo to recognise the SPG target id; PG repo
      // must NOT match it.
      projectRepoMock.findOne.mockImplementation(async ({ where }: any) => {
        if (where.id === targetId) {
          return {
            id: targetId,
            createdBy: { id: ownerWorkHistoryId },
          } as Partial<ProjectGroup>;
        }
        return null;
      });
      supplementRepoMock.findOne.mockImplementation(async ({ where }: any) => {
        if (where.id === spgTargetId) {
          return {
            id: spgTargetId,
            createdBy: { id: ownerWorkHistoryId },
          } as Partial<SupplementProjectGroup>;
        }
        return null;
      });
    });

    it('writes a baseline row for SPG (result=null → no-ai-baseline)', async () => {
      const row = await service.createSnapshot(
        callerUserId,
        makeSpgDto({ result: null }),
      );
      expect(row.targetKind).toBe('supplement-project-group');
      expect(row.targetId).toBe(spgTargetId);
      expect(row.endpoint).toBe('no-ai-baseline');
      expect(row.stalenessPolicy).toBe('snapshot-only');
      expect(row.score0100).toBeNull();
      expect(row.band).toBeNull();
    });

    it('owner-read returns the active SPG baseline with isStale=false', async () => {
      await service.createSnapshot(
        callerUserId,
        makeSpgDto({ result: null }),
      );
      const { snapshot, envelope } = await service.getOwnerSnapshot(
        callerUserId,
        'supplement-project-group',
        spgTargetId,
      );
      expect(snapshot.targetKind).toBe('supplement-project-group');
      expect(snapshot.endpoint).toBe('no-ai-baseline');
      expect(envelope.isStale).toBe(false);
      expect(envelope.stalenessPolicy).toBe('snapshot-only');
    });

    it('owner-read 403 when caller is not the SPG submitter', async () => {
      await service.createSnapshot(
        callerUserId,
        makeSpgDto({ result: null }),
      );
      // Switch caller WorkHistory id to a non-owner.
      callerWorkHistory = {
        ...callerWorkHistory,
        id: 'wh-other',
      };
      await expect(
        service.getOwnerSnapshot(
          callerUserId,
          'supplement-project-group',
          spgTargetId,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('owner-read 404 when no snapshot exists for the SPG (upgrade-from-nothing precondition)', async () => {
      await expect(
        service.getOwnerSnapshot(
          callerUserId,
          'supplement-project-group',
          spgTargetId,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects unknown SPG-adjacent target kinds defensively', async () => {
      await expect(
        service.getOwnerSnapshot(
          callerUserId,
          'supplement' as any,
          spgTargetId,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('Wave 10 upgrade-from-baseline — pre-submit-review supersedes existing no-ai-baseline for SPG', async () => {
      // 1) Baseline write (SUPP-1 BE-01 path).
      const baseline = await service.createSnapshot(
        callerUserId,
        makeSpgDto({ result: null }),
      );
      expect(baseline.endpoint).toBe('no-ai-baseline');

      // 2) AI-result write with different content (different title → different hash).
      const ai = await service.createSnapshot(
        callerUserId,
        makeSpgDto({
          project: {
            ...makeSpgDto().project,
            title: 'โครงการเพิ่มเติม ฉบับ AI',
          },
        }),
      );
      expect(ai.endpoint).toBe('pre-submit-review');
      expect(ai.id).not.toBe(baseline.id);

      // Active row count is 1; baseline is soft-deleted.
      const active = snapshotRows.filter((r) => r.deletedAt == null);
      expect(active).toHaveLength(1);
      expect(active[0].endpoint).toBe('pre-submit-review');
      const archived = snapshotRows.filter((r) => r.deletedAt != null);
      expect(archived).toHaveLength(1);
      expect(archived[0].endpoint).toBe('no-ai-baseline');
    });

    it('Wave 10 downgrade-skip — no-ai-baseline does NOT overwrite an existing pre-submit-review for SPG', async () => {
      // 1) Seed with an AI-result write.
      const ai = await service.createSnapshot(callerUserId, makeSpgDto());
      expect(ai.endpoint).toBe('pre-submit-review');

      // 2) Attempt a baseline write with DIFFERENT content (different
      //    title → different hash). Wave 10 requires the service to
      //    return the existing AI row unchanged: zero soft-delete, zero
      //    insert.
      const downgrade = await service.createSnapshot(
        callerUserId,
        makeSpgDto({
          result: null,
          project: {
            ...makeSpgDto().project,
            title: 'โครงการเพิ่มเติม ชื่อใหม่',
          },
        }),
      );
      expect(downgrade.id).toBe(ai.id);
      expect(downgrade.endpoint).toBe('pre-submit-review');

      const active = snapshotRows.filter((r) => r.deletedAt == null);
      expect(active).toHaveLength(1);
      expect(active[0].endpoint).toBe('pre-submit-review');
      const archived = snapshotRows.filter((r) => r.deletedAt != null);
      expect(archived).toHaveLength(0); // downgrade-skip ⇒ no soft-delete
    });

    it('idempotent same-hash short-circuit for SPG', async () => {
      const first = await service.createSnapshot(
        callerUserId,
        makeSpgDto({ result: null }),
      );
      const second = await service.createSnapshot(
        callerUserId,
        makeSpgDto({ result: null }),
      );
      expect(first.id).toBe(second.id);
      expect(
        snapshotRows.filter((r) => r.deletedAt == null),
      ).toHaveLength(1);
    });

    it('staff-lead read returns the SPG snapshot with isStale=false', async () => {
      await service.createSnapshot(
        callerUserId,
        makeSpgDto({ result: null }),
      );
      // Switch to a staff-lead caller (id only matters via the
      // workHistory mock — the spec mock returns `callerWorkHistory`
      // verbatim regardless of userId).
      callerWorkHistory = {
        id: 'wh-staff',
        isCurrent: true,
        workStatus: { name: 'approved' } as any,
        role: { name: 'staff' } as any,
        user: { id: 'staff-1' } as any,
      };
      const { snapshot, envelope } = await service.getActiveSnapshot(
        'staff-1',
        'supplement-project-group',
        spgTargetId,
      );
      expect(snapshot.targetKind).toBe('supplement-project-group');
      expect(envelope.isStale).toBe(false);
      expect(envelope.stalenessPolicy).toBe('snapshot-only');
    });
  });
});
