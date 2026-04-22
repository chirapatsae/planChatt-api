import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { StaffReviewCacheService } from './staff-review-cache.service';
import { AiStaffReviewRun } from './entities/ai-staff-review-run.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

/**
 * Wave 41 N2 — unit tests for StaffReviewCacheService.
 *
 * Covers:
 *   - §17.2 advisory-only (no workflow coupling in the surface area)
 *   - §17.3 audit separation (no project / work_history FK touched)
 *   - §17.4 `strict` staleness policy (stored on every row + isStale
 *     computes against caller-supplied currentHash)
 *   - Same-hash short-circuit (idempotent)
 *   - Drift soft-delete + insert (transactional)
 *   - Cross-reviewer cache reuse (reviewer B reads reviewer A's row
 *     verbatim; subsequent same-hash write keeps reviewer A's stamp)
 *   - Role gating (user role rejected with 403)
 *   - Malformed content_hash rejection
 */
describe('StaffReviewCacheService', () => {
  let service: StaffReviewCacheService;

  let rows: AiStaffReviewRun[];
  let callerWorkHistory: Partial<WorkHistory>;
  const targetId = '00000000-0000-4000-8000-000000000001';
  const contentHashA = 'a'.repeat(64);
  const contentHashB = 'b'.repeat(64);

  // ── Reviewer A and B ────────────────────────────────────────────────
  const reviewerAId = 'staff-a';
  const reviewerAWorkHistoryId = 'wh-staff-a';
  const reviewerBId = 'staff-b';
  const reviewerBWorkHistoryId = 'wh-staff-b';

  const buildRepoManagerRepo = () => ({
    findOne: jest.fn(async ({ where }: any) => {
      return (
        rows.find(
          (r) =>
            r.targetId === where.targetId &&
            r.targetKind === where.targetKind &&
            r.deletedAt == null,
        ) ?? null
      );
    }),
    create: jest.fn((data: Partial<AiStaffReviewRun>) => {
      const row = {
        id: `run-${rows.length + 1}`,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: null,
        ...data,
      } as AiStaffReviewRun;
      return row;
    }),
    save: jest.fn(async (row: AiStaffReviewRun) => {
      const existingIdx = rows.findIndex((r) => r.id === row.id);
      if (existingIdx >= 0) {
        rows[existingIdx] = row;
      } else {
        rows.push(row);
      }
      return row;
    }),
  });

  const runRepoMock = {
    findOne: jest.fn(async ({ where }: any) => {
      return (
        rows.find(
          (r) =>
            r.targetId === where.targetId &&
            r.targetKind === where.targetKind &&
            r.deletedAt == null,
        ) ?? null
      );
    }),
  };

  const dataSourceMock: Partial<DataSource> = {
    transaction: jest.fn(async (cb: any) => {
      const repo = buildRepoManagerRepo();
      const manager = { getRepository: () => repo } as any;
      return cb(manager);
    }),
  };

  const workHistoryRepoMock = {
    findOne: jest.fn(async () => callerWorkHistory),
  };

  const setCaller = (userId: string, workHistoryId: string, role: string) => {
    callerWorkHistory = {
      id: workHistoryId,
      isCurrent: true,
      workStatus: { name: 'approved' } as any,
      role: { name: role } as any,
      user: { id: userId } as any,
    };
  };

  beforeEach(async () => {
    rows = [];
    setCaller(reviewerAId, reviewerAWorkHistoryId, 'staff');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StaffReviewCacheService,
        { provide: getRepositoryToken(AiStaffReviewRun), useValue: runRepoMock },
        { provide: getRepositoryToken(WorkHistory), useValue: workHistoryRepoMock },
        { provide: DataSource, useValue: dataSourceMock },
      ],
    }).compile();

    service = module.get(StaffReviewCacheService);
    jest.clearAllMocks();
    // Restore the workHistoryRepoMock after clearAllMocks by rebinding
    // the findOne implementation for each test.
    workHistoryRepoMock.findOne.mockImplementation(async () => callerWorkHistory);
  });

  const makeDto = () => ({
    targetKind: 'project-group' as const,
    targetId,
    contentHash: contentHashA,
    endpoint: 'staff-review/analyze',
    resultJson: { overallScore: 72, rationale: 'ทดสอบ' },
    score0100: 72,
    band: 'amber' as const,
    model: 'gpt-4o',
  });

  // ── createRun ─────────────────────────────────────────────────────

  it('inserts a fresh run with staleness_policy=strict', async () => {
    const saved = await service.createRun(reviewerAId, makeDto());
    expect(saved.stalenessPolicy).toBe('strict');
    expect(saved.reviewerWorkHistoryId).toBe(reviewerAWorkHistoryId);
    expect(saved.contentHash).toBe(contentHashA);
    expect(rows).toHaveLength(1);
  });

  it('idempotent same-hash short-circuit returns the existing row (zero inserts, zero soft-deletes)', async () => {
    const first = await service.createRun(reviewerAId, makeDto());
    const second = await service.createRun(reviewerAId, makeDto());
    expect(second.id).toBe(first.id);
    const active = rows.filter((r) => r.deletedAt == null);
    const archived = rows.filter((r) => r.deletedAt != null);
    expect(active).toHaveLength(1);
    expect(archived).toHaveLength(0);
  });

  it('drift path soft-deletes prior and inserts a new row', async () => {
    const first = await service.createRun(reviewerAId, makeDto());
    const second = await service.createRun(reviewerAId, {
      ...makeDto(),
      contentHash: contentHashB,
      resultJson: { overallScore: 80 },
      score0100: 80,
      band: 'green',
    });
    expect(second.id).not.toBe(first.id);
    const active = rows.filter((r) => r.deletedAt == null);
    const archived = rows.filter((r) => r.deletedAt != null);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(second.id);
    expect(archived).toHaveLength(1);
    expect(archived[0].id).toBe(first.id);
  });

  it('cross-reviewer cache reuse: reviewer B same-hash write returns reviewer A row (stamp preserved)', async () => {
    const first = await service.createRun(reviewerAId, makeDto());
    // Switch caller to reviewer B.
    setCaller(reviewerBId, reviewerBWorkHistoryId, 'staff');
    const second = await service.createRun(reviewerBId, makeDto());
    expect(second.id).toBe(first.id);
    // Reviewer A's stamp is preserved on the cached row (by design —
    // chronology of per-call access lives in ai_usage_logs).
    expect(second.reviewerWorkHistoryId).toBe(reviewerAWorkHistoryId);
    expect(rows.filter((r) => r.deletedAt == null)).toHaveLength(1);
  });

  it('rejects malformed content_hash with BadRequestException', async () => {
    await expect(
      service.createRun(reviewerAId, {
        ...makeDto(),
        contentHash: 'not-a-sha256-hex',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects non-staff-lead writer with ForbiddenException (Wave 41 N8 P0 — service is the authoritative gate)', async () => {
    // Post-Wave-41-N8 P0: createRun now calls assertStaffLead directly,
    // so a `user`-role caller (even with approved workStatus) is blocked
    // BEFORE any cache row is written. Prevents a user-role caller from
    // consuming reviewer quota or stamping their WorkHistory as reviewer.
    setCaller('some-user', 'wh-user', 'user');
    await expect(
      service.createRun('some-user', makeDto()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // No row was persisted.
    expect(rows).toHaveLength(0);
  });

  it('assertStaffLeadCaller: 403 for user role, returns WorkHistory for staff-lead', async () => {
    // Controller-level fail-fast helper (Wave 41 N8 P0 defense-in-depth).
    setCaller('user-1', 'wh-user', 'user');
    await expect(
      service.assertStaffLeadCaller('user-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    setCaller(reviewerAId, reviewerAWorkHistoryId, 'admin');
    const wh = await service.assertStaffLeadCaller(reviewerAId);
    expect(wh.id).toBe(reviewerAWorkHistoryId);
  });

  // ── getActiveRun ──────────────────────────────────────────────────

  it('getActiveRun returns null when no active row exists', async () => {
    const result = await service.getActiveRun(
      reviewerAId,
      'project-group',
      targetId,
    );
    expect(result).toBeNull();
  });

  it('getActiveRun returns envelope + result when active row present', async () => {
    await service.createRun(reviewerAId, makeDto());
    const result = await service.getActiveRun(
      reviewerAId,
      'project-group',
      targetId,
    );
    expect(result).not.toBeNull();
    expect(result!.envelope.stalenessPolicy).toBe('strict');
    expect(result!.envelope.isStale).toBe(false); // no currentHash provided
    expect(result!.envelope.score).toBe(72);
    expect(result!.envelope.band).toBe('amber');
    expect(result!.result.overallScore).toBe(72);
  });

  it('getActiveRun flips isStale=true when currentContentHash differs', async () => {
    await service.createRun(reviewerAId, makeDto());
    const result = await service.getActiveRun(
      reviewerAId,
      'project-group',
      targetId,
      contentHashB,
    );
    expect(result).not.toBeNull();
    expect(result!.envelope.isStale).toBe(true);
    expect(result!.envelope.contentHash).toBe(contentHashA);
  });

  it('getActiveRun rejects user role with 403', async () => {
    await service.createRun(reviewerAId, makeDto());
    // Switch to user role.
    setCaller('user-1', 'wh-user', 'user');
    await expect(
      service.getActiveRun('user-1', 'project-group', targetId),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('getActiveRun cross-reviewer reuse: reviewer B reads reviewer A row verbatim', async () => {
    await service.createRun(reviewerAId, makeDto());
    setCaller(reviewerBId, reviewerBWorkHistoryId, 'admin');
    const result = await service.getActiveRun(
      reviewerBId,
      'project-group',
      targetId,
    );
    expect(result).not.toBeNull();
    expect(result!.run.reviewerWorkHistoryId).toBe(reviewerAWorkHistoryId);
  });

  // ── isStale helper ────────────────────────────────────────────────

  it('isStale helper returns false when currentHash omitted / empty', () => {
    const run = { contentHash: contentHashA } as AiStaffReviewRun;
    expect(service.isStale(run, '')).toBe(false);
  });

  it('isStale helper returns true when hashes differ', () => {
    const run = { contentHash: contentHashA } as AiStaffReviewRun;
    expect(service.isStale(run, contentHashB)).toBe(true);
  });

  // Guard against unused IsNull warning from import used in mocks above.
  it('_sanity: IsNull token import is live', () => {
    expect(IsNull()).toBeTruthy();
  });
});
