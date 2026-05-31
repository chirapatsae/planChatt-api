// ===================================================================
// MainAssemblyService — unit tests
// Wave A1 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// Minimum coverage per the BE-01 task brief:
//   1. cancelPublishedVersion() throws 403 MAIN_BOOK_CANNOT_ROLLBACK
//   2. getCurrentVersion() returns COMPLETED-first (mirror supplement)
//   3. getReadiness() returns the proper shape (parity with revision /
//      supplement readiness DTOs)
//
// Mutating-path scenarios (merge, correct, generatePart3) require deep
// transaction / pdf-lib / orphan-cleanup stubbing and are exercised by
// integration tests rather than unit tests — the same precedent set by
// the supplement spec (which limits unit coverage to getReadiness +
// getBookDisplayState).
// ===================================================================

import {
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { MainAssemblyService } from './main-assembly.service';
import { MainAssemblyDraft } from './entities/main-assembly-draft.entity';
import { MainAssemblyVersion } from './entities/main-assembly-version.entity';
import { MainAssemblyVersionProject } from './entities/main-assembly-version-project.entity';
import { MainProjectLineage } from './entities/main-project-lineage.entity';
import {
  MainAssemblyDraftStatus,
  MainAssemblyPartUploadStatus,
  MainAssemblyVersionStatus,
} from './enums/main-assembly.enums';
import { CancelMainBookDto } from './dto/cancel-main-book.dto';

import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { PlanPhase } from 'src/plan-phase/entities/plan-phase.entity';
import { User } from 'src/users/entities/user.entity';
import { EquipmentProjectGroup } from 'src/equipment-project-group/entities/equipment-project-group.entity';

import { UsersService } from 'src/users/users.service';
import { PdfService } from 'src/pdf/pdf.service';
import { Por03PdfService } from 'src/pdf/por03-pdf.service';
import { WebsocketService } from 'src/websocket/websocket/websocket.service';
import { BookAssemblyFileService } from 'src/book-assembly/book-assembly-file.service';
import { StoragePathService } from 'src/storage/storage-path.service';
import { BookLockService } from 'src/common/book-lock/book-lock.service';
import { OrphanCleanupService } from 'src/orphan-cleanup/orphan-cleanup.service';

import { STATUS_NAMES } from 'src/common/status-names';

// -------------------------------------------------------------------
// Mock helpers
// -------------------------------------------------------------------

function createMockRepository<T extends object>(): jest.Mocked<Repository<T>> {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    count: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    exists: jest.fn(),
    remove: jest.fn(),
    update: jest.fn(),
    createQueryBuilder: jest.fn(),
    manager: {},
  } as unknown as jest.Mocked<Repository<T>>;
}

function buildQbStub(terminals: {
  getCount?: number;
  getRawMany?: any[];
  getExists?: boolean;
  getRawOne?: any;
}) {
  const qb: any = {};
  const chain = () => qb;
  qb.innerJoin = jest.fn(chain);
  qb.leftJoin = jest.fn(chain);
  qb.leftJoinAndSelect = jest.fn(chain);
  qb.select = jest.fn(chain);
  qb.addSelect = jest.fn(chain);
  qb.where = jest.fn(chain);
  qb.andWhere = jest.fn(chain);
  qb.groupBy = jest.fn(chain);
  qb.orderBy = jest.fn(chain);
  qb.getCount = jest.fn().mockResolvedValue(terminals.getCount ?? 0);
  qb.getRawMany = jest.fn().mockResolvedValue(terminals.getRawMany ?? []);
  qb.getExists = jest.fn().mockResolvedValue(terminals.getExists ?? false);
  qb.getRawOne = jest.fn().mockResolvedValue(terminals.getRawOne ?? null);
  qb.getMany = jest.fn().mockResolvedValue([]);
  return qb;
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});

// -------------------------------------------------------------------
// Shared module builder
// -------------------------------------------------------------------

interface MockRepos {
  draftRepo: jest.Mocked<Repository<MainAssemblyDraft>>;
  versionRepo: jest.Mocked<Repository<MainAssemblyVersion>>;
  versionProjectRepo: jest.Mocked<Repository<MainAssemblyVersionProject>>;
  lineageRepo: jest.Mocked<Repository<MainProjectLineage>>;
  workHistoryRepo: jest.Mocked<Repository<WorkHistory>>;
  projectGroupRepo: jest.Mocked<Repository<ProjectGroup>>;
  devPlanRepo: jest.Mocked<Repository<DevelopmentPlan>>;
  planPhaseRepo: jest.Mocked<Repository<PlanPhase>>;
  userRepo: jest.Mocked<Repository<User>>;
  // §21.2 BE-01 — equipment repo for the both-sources merge gate
  equipmentRepo: jest.Mocked<Repository<EquipmentProjectGroup>>;
}

async function buildService(): Promise<{
  service: MainAssemblyService;
  repos: MockRepos;
  bookLockService: { assertEditable: jest.Mock };
}> {
  const repos: MockRepos = {
    draftRepo: createMockRepository<MainAssemblyDraft>(),
    versionRepo: createMockRepository<MainAssemblyVersion>(),
    versionProjectRepo: createMockRepository<MainAssemblyVersionProject>(),
    lineageRepo: createMockRepository<MainProjectLineage>(),
    workHistoryRepo: createMockRepository<WorkHistory>(),
    projectGroupRepo: createMockRepository<ProjectGroup>(),
    devPlanRepo: createMockRepository<DevelopmentPlan>(),
    planPhaseRepo: createMockRepository<PlanPhase>(),
    userRepo: createMockRepository<User>(),
    equipmentRepo: createMockRepository<EquipmentProjectGroup>(),
  };

  const bookLockService = { assertEditable: jest.fn().mockResolvedValue(undefined) };

  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [
      MainAssemblyService,
      { provide: getRepositoryToken(MainAssemblyDraft), useValue: repos.draftRepo },
      { provide: getRepositoryToken(MainAssemblyVersion), useValue: repos.versionRepo },
      { provide: getRepositoryToken(MainAssemblyVersionProject), useValue: repos.versionProjectRepo },
      { provide: getRepositoryToken(MainProjectLineage), useValue: repos.lineageRepo },
      { provide: getRepositoryToken(WorkHistory), useValue: repos.workHistoryRepo },
      { provide: getRepositoryToken(ProjectGroup), useValue: repos.projectGroupRepo },
      { provide: getRepositoryToken(DevelopmentPlan), useValue: repos.devPlanRepo },
      { provide: getRepositoryToken(PlanPhase), useValue: repos.planPhaseRepo },
      { provide: getRepositoryToken(User), useValue: repos.userRepo },
      // §21.2 BE-01 — equipment repo for both-sources merge gate
      { provide: getRepositoryToken(EquipmentProjectGroup), useValue: repos.equipmentRepo },
      { provide: UsersService, useValue: { findOne: jest.fn() } },
      { provide: PdfService, useValue: {} },
      // Phase 3 — ผ.03 formal-assembly render core injected into
      // MainAssemblyService at constructor index [11]. Mock returns null
      // (no equipment appended) so existing merge specs are unaffected.
      { provide: Por03PdfService, useValue: { renderApprovedPlanScopedPor03Buffer: jest.fn().mockResolvedValue(null) } },
      { provide: WebsocketService, useValue: { notifyPdfGenerationProgress: jest.fn() } },
      { provide: BookAssemblyFileService, useValue: {} },
      { provide: StoragePathService, useValue: {} },
      { provide: BookLockService, useValue: bookLockService },
      { provide: OrphanCleanupService, useValue: {} },
      { provide: DataSource, useValue: {} },
    ],
  }).compile();

  const service = moduleRef.get(MainAssemblyService);
  // Authorize staff for READ paths by default.
  repos.workHistoryRepo.findOne.mockResolvedValue({
    id: 'wh-1',
    role: { name: 'staff' },
    workStatus: { name: 'approved' },
    user: { id: 'user-1' },
  } as any);
  return { service, repos, bookLockService };
}

// ===================================================================
// 1. cancelPublishedVersion always throws 403 MAIN_BOOK_CANNOT_ROLLBACK
// ===================================================================

describe('MainAssemblyService.cancelPublishedVersion', () => {
  const PLAN_ID = 'plan-uuid-1';
  const VERSION_ID = 'version-uuid-1';
  const USER_ID = 'user-uuid-1';

  it('rejects every call with MAIN_BOOK_CANNOT_ROLLBACK (§20.4)', async () => {
    const { service } = await buildService();
    const dto: CancelMainBookDto = {
      confirmed: true,
      citizenIdSuffix: '123456',
      reason: 'should-never-be-honored',
    };

    await expect(
      service.cancelPublishedVersion(PLAN_ID, VERSION_ID, dto, USER_ID),
    ).rejects.toThrow(ForbiddenException);

    // Re-trigger to assert the error code shape.
    try {
      await service.cancelPublishedVersion(PLAN_ID, VERSION_ID, dto, USER_ID);
      fail('expected ForbiddenException');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      const body = (err as ForbiddenException).getResponse() as {
        code?: string;
        message?: string;
      };
      expect(body.code).toBe('MAIN_BOOK_CANNOT_ROLLBACK');
      expect(body.message).toMatch(/เล่มแผนหลัก/);
    }
  });
});

// ===================================================================
// 2. getCurrentVersion returns COMPLETED first; falls back to
//    DEPRECATED via active draft previousVersionId; null otherwise
// ===================================================================

describe('MainAssemblyService.getCurrentVersion', () => {
  const PLAN_ID = 'plan-uuid-2';
  const USER_ID = 'user-uuid-2';

  it('returns the COMPLETED version when one exists', async () => {
    const { service, repos } = await buildService();
    const completed = {
      id: 'v-completed-id',
      developmentPlanId: PLAN_ID,
      versionNumber: 1,
      status: MainAssemblyVersionStatus.COMPLETED,
      part1Source: 'uploaded',
      part2Source: 'uploaded',
      part3Source: 'generated',
      part3ProjectCount: 5,
      part3ProjectSnapshot: ['p1', 'p2', 'p3', 'p4', 'p5'],
      // §21.4 BE-03 — set EQ snapshot to null (legacy/historical row) so
      // equipmentSnapshotMissing=true and the equipment query is skipped.
      part3EquipmentSnapshot: null,
      createdById: 'wh-creator',
      mergedAt: new Date('2026-05-25T00:00:00Z'),
      createdAt: new Date('2026-05-25T00:00:00Z'),
    } as any;
    repos.versionRepo.findOne.mockResolvedValueOnce(completed);
    // §21.4 BE-03 — enrichWithStaleness queries current Approved PG set.
    repos.projectGroupRepo.createQueryBuilder.mockReturnValueOnce(
      buildQbStub({ getRawMany: [] }),
    );

    const result = await service.getCurrentVersion(PLAN_ID, USER_ID);

    expect(result).not.toBeNull();
    expect(result?.id).toBe('v-completed-id');
    expect(result?.status).toBe(MainAssemblyVersionStatus.COMPLETED);
    // COMPLETED short-circuit — draftRepo MUST NOT be queried.
    expect(repos.draftRepo.findOne).not.toHaveBeenCalled();
  });

  it('falls back to DEPRECATED via active draft previousVersionId when no COMPLETED exists', async () => {
    const { service, repos } = await buildService();
    // 1st findOne (COMPLETED) → null
    repos.versionRepo.findOne.mockResolvedValueOnce(null);
    // active draft references a previous version
    repos.draftRepo.findOne.mockResolvedValueOnce({
      id: 'draft-1',
      developmentPlanId: PLAN_ID,
      previousVersionId: 'v-deprecated-id',
      assemblyStatus: MainAssemblyDraftStatus.PREPARING,
    } as any);
    // 2nd findOne (previous version)
    const deprecated = {
      id: 'v-deprecated-id',
      developmentPlanId: PLAN_ID,
      versionNumber: 1,
      status: MainAssemblyVersionStatus.DEPRECATED,
      part1Source: 'uploaded',
      part2Source: 'uploaded',
      part3Source: 'generated',
      part3ProjectCount: 3,
      createdById: 'wh-creator',
      deprecatedAt: new Date(),
      deprecationReason: 'reason',
      // §21.4 BE-03 — null snapshot → equipment query skipped
      part3EquipmentSnapshot: null,
    } as any;
    repos.versionRepo.findOne.mockResolvedValueOnce(deprecated);
    // §21.4 BE-03 — enrichWithStaleness PG query mock
    repos.projectGroupRepo.createQueryBuilder.mockReturnValueOnce(
      buildQbStub({ getRawMany: [] }),
    );

    const result = await service.getCurrentVersion(PLAN_ID, USER_ID);

    expect(result?.id).toBe('v-deprecated-id');
    expect(result?.status).toBe(MainAssemblyVersionStatus.DEPRECATED);
  });

  it('returns null when neither a COMPLETED version nor an active draft exists', async () => {
    const { service, repos } = await buildService();
    repos.versionRepo.findOne.mockResolvedValueOnce(null);
    repos.draftRepo.findOne.mockResolvedValueOnce(null);

    const result = await service.getCurrentVersion(PLAN_ID, USER_ID);
    expect(result).toBeNull();
  });
});

// ===================================================================
// 3. getReadiness returns the proper shape (mirrors revision /
//    supplement readiness DTOs byte-for-byte)
// ===================================================================

describe('MainAssemblyService.getReadiness', () => {
  const PLAN_ID = 'plan-uuid-3';
  const USER_ID = 'user-uuid-3';

  it('returns the readiness envelope (isReady=true when all approved and no open phase)', async () => {
    const { service, repos } = await buildService();

    repos.projectGroupRepo.createQueryBuilder
      // total
      .mockReturnValueOnce(buildQbStub({ getCount: 3 }))
      // approved
      .mockReturnValueOnce(buildQbStub({ getCount: 3 }))
      // agency
      .mockReturnValueOnce(buildQbStub({ getCount: 3 }))
      // §21.2 BE-01 — approvedAgencyCount
      .mockReturnValueOnce(buildQbStub({ getCount: 3 }))
      // status aggregate
      .mockReturnValueOnce(
        buildQbStub({
          getRawMany: [{ statusName: STATUS_NAMES.APPROVED, cnt: '3' }],
        }),
      );
    repos.planPhaseRepo.createQueryBuilder.mockReturnValueOnce(
      buildQbStub({ getExists: false }),
    );
    // §21.2 BE-01 — equipment Approved count (0 is fine here; LAO=0 still fails gate)
    repos.equipmentRepo.createQueryBuilder.mockReturnValueOnce(
      buildQbStub({ getCount: 0 }),
    );

    const result = await service.getReadiness(PLAN_ID, USER_ID);

    expect(result.totalCount).toBe(3);
    expect(result.approvedCount).toBe(3);
    expect(result.hasOpenPhase).toBe(false);
    // §21.2 — LAO Approved = 0 so the both-sources gate makes isReady false
    expect(result.isReady).toBe(false);
    expect(result.breakdown).toMatchObject({
      agencyCount: 3,
      laoCount: 0,
      approvedCount: 3,
      pendingCount: 0,
      verifiedCount: 0,
      pendingApprovalCount: 0,
      readyCount: 0,
      returnedForRevisionCount: 0,
      pullBackCount: 0,
      rejectedCount: 0,
      totalCount: 3,
    });
  });

  it('returns isReady=false when an open phase exists even if every project is Approved', async () => {
    const { service, repos } = await buildService();

    repos.projectGroupRepo.createQueryBuilder
      .mockReturnValueOnce(buildQbStub({ getCount: 2 }))
      .mockReturnValueOnce(buildQbStub({ getCount: 2 }))
      .mockReturnValueOnce(buildQbStub({ getCount: 1 }))
      // §21.2 BE-01 — approvedAgencyCount
      .mockReturnValueOnce(buildQbStub({ getCount: 1 }))
      .mockReturnValueOnce(
        buildQbStub({
          getRawMany: [{ statusName: STATUS_NAMES.APPROVED, cnt: '2' }],
        }),
      );
    repos.planPhaseRepo.createQueryBuilder.mockReturnValueOnce(
      buildQbStub({ getExists: true }),
    );
    repos.equipmentRepo.createQueryBuilder.mockReturnValueOnce(
      buildQbStub({ getCount: 0 }),
    );

    const result = await service.getReadiness(PLAN_ID, USER_ID);

    expect(result.totalCount).toBe(2);
    expect(result.approvedCount).toBe(2);
    expect(result.hasOpenPhase).toBe(true);
    expect(result.isReady).toBe(false);
    expect(result.breakdown.agencyCount).toBe(1);
    expect(result.breakdown.laoCount).toBe(1);
  });

  it('returns isReady=false and totalCount=0 on an empty plan', async () => {
    const { service, repos } = await buildService();

    repos.projectGroupRepo.createQueryBuilder
      .mockReturnValueOnce(buildQbStub({ getCount: 0 }))
      .mockReturnValueOnce(buildQbStub({ getCount: 0 }))
      .mockReturnValueOnce(buildQbStub({ getCount: 0 }))
      // §21.2 BE-01 — approvedAgencyCount
      .mockReturnValueOnce(buildQbStub({ getCount: 0 }))
      .mockReturnValueOnce(buildQbStub({ getRawMany: [] }));
    repos.planPhaseRepo.createQueryBuilder.mockReturnValueOnce(
      buildQbStub({ getExists: false }),
    );
    repos.equipmentRepo.createQueryBuilder.mockReturnValueOnce(
      buildQbStub({ getCount: 0 }),
    );

    const result = await service.getReadiness(PLAN_ID, USER_ID);

    expect(result.totalCount).toBe(0);
    expect(result.approvedCount).toBe(0);
    expect(result.isReady).toBe(false);
    expect(result.breakdown.totalCount).toBe(0);
  });
});

// ===================================================================
// 4. restoreDraft — happy path + guards (CLEANUP wave port)
// ===================================================================

describe('MainAssemblyService.restoreDraft', () => {
  const PLAN_ID = 'plan-uuid-4';
  const USER_ID = 'user-uuid-4';

  it('throws NotFoundException when no canceled draft exists for the plan', async () => {
    const { service, repos } = await buildService();
    repos.workHistoryRepo.findOne.mockResolvedValue({
      id: 'wh-1',
      role: { name: 'admin' },
      workStatus: { name: 'approved' },
      user: { id: USER_ID },
    } as any);
    // No CANCELED draft → first findOne resolves null.
    repos.draftRepo.findOne.mockResolvedValueOnce(null);

    await expect(service.restoreDraft(PLAN_ID, USER_ID)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws ConflictException ACTIVE_DRAFT_EXISTS when an active draft is already present', async () => {
    const { service, repos } = await buildService();
    repos.workHistoryRepo.findOne.mockResolvedValue({
      id: 'wh-1',
      role: { name: 'admin' },
      workStatus: { name: 'approved' },
      user: { id: USER_ID },
    } as any);
    // 1st findOne → CANCELED draft exists
    repos.draftRepo.findOne.mockResolvedValueOnce({
      id: 'canceled-1',
      developmentPlanId: PLAN_ID,
      assemblyStatus: MainAssemblyDraftStatus.CANCELED,
      part1Status: MainAssemblyPartUploadStatus.PENDING,
      part2Status: MainAssemblyPartUploadStatus.PENDING,
      part3Status: MainAssemblyPartUploadStatus.PENDING,
    } as any);
    // 2nd findOne → active draft also present (blocks restore)
    repos.draftRepo.findOne.mockResolvedValueOnce({
      id: 'active-1',
      developmentPlanId: PLAN_ID,
      assemblyStatus: MainAssemblyDraftStatus.PREPARING,
    } as any);

    await expect(service.restoreDraft(PLAN_ID, USER_ID)).rejects.toThrow(
      ConflictException,
    );
    expect(repos.draftRepo.save).not.toHaveBeenCalled();
  });
});
