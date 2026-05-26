// ===================================================================
// ChangeAssemblyService — unit tests
// Wave A3 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// Minimum coverage per the BE-01 task brief (mirrors EDIT spec; CHANGE
// shares EDIT's cancel/readiness/getCurrentVersion semantics
// byte-for-spirit because both are revision-style books):
//   1. cancelPublishedVersion() happy path (vs MAIN's 403 test) —
//      CHANGE supports cancel per §20.2; the test asserts the deprecate +
//      reset + cascade flow completes without throwing.
//   2. getCurrentVersion() returns COMPLETED-first (mirror MAIN / EDIT /
//      supplement) AND falls back to DEPRECATED via the active draft.
//   3. getReadiness() returns the proper shape (parity with revision /
//      main / edit / supplement readiness DTOs).
//
// Mutating-path scenarios (merge, correct, generatePart3) require deep
// transaction / pdf-lib / orphan-cleanup stubbing and are exercised by
// integration tests rather than unit tests — the same precedent set by
// the MAIN / EDIT / supplement specs.
// ===================================================================

import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { ChangeAssemblyService } from './change-assembly.service';
import { ChangeAssemblyDraft } from './entities/change-assembly-draft.entity';
import { ChangeAssemblyVersion } from './entities/change-assembly-version.entity';
import { ChangeAssemblyVersionProject } from './entities/change-assembly-version-project.entity';
import { ChangeProjectLineage } from './entities/change-project-lineage.entity';
import {
  ChangeAssemblyDraftStatus,
  ChangeAssemblyPartUploadStatus,
  ChangeAssemblyVersionStatus,
} from './enums/change-assembly.enums';
import { CancelChangeBookDto } from './dto/cancel-change-book.dto';

import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { User } from 'src/users/entities/user.entity';

import { UsersService } from 'src/users/users.service';
import { PdfService } from 'src/pdf/pdf.service';
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
  draftRepo: jest.Mocked<Repository<ChangeAssemblyDraft>>;
  versionRepo: jest.Mocked<Repository<ChangeAssemblyVersion>>;
  versionProjectRepo: jest.Mocked<Repository<ChangeAssemblyVersionProject>>;
  lineageRepo: jest.Mocked<Repository<ChangeProjectLineage>>;
  workHistoryRepo: jest.Mocked<Repository<WorkHistory>>;
  revisedProjectGroupRepo: jest.Mocked<Repository<RevisedProjectGroup>>;
  devPlanRevisionRepo: jest.Mocked<Repository<DevelopmentPlanRevision>>;
  userRepo: jest.Mocked<Repository<User>>;
}

interface BuildOpts {
  /** Pre-canned cancel transaction wiring (for the cancel happy path). */
  cancelManager?: jest.Mocked<EntityManager>;
}

async function buildService(opts: BuildOpts = {}): Promise<{
  service: ChangeAssemblyService;
  repos: MockRepos;
  bookLockService: { assertEditable: jest.Mock };
  orphanCleanupService: {
    cascadeOnBookCancel: jest.Mock;
    cascadeOnBookFinalize: jest.Mock;
  };
  usersService: { findOne: jest.Mock };
  dataSource: { transaction: jest.Mock };
}> {
  const repos: MockRepos = {
    draftRepo: createMockRepository<ChangeAssemblyDraft>(),
    versionRepo: createMockRepository<ChangeAssemblyVersion>(),
    versionProjectRepo: createMockRepository<ChangeAssemblyVersionProject>(),
    lineageRepo: createMockRepository<ChangeProjectLineage>(),
    workHistoryRepo: createMockRepository<WorkHistory>(),
    revisedProjectGroupRepo: createMockRepository<RevisedProjectGroup>(),
    devPlanRevisionRepo: createMockRepository<DevelopmentPlanRevision>(),
    userRepo: createMockRepository<User>(),
  };

  const bookLockService = { assertEditable: jest.fn().mockResolvedValue(undefined) };
  const orphanCleanupService = {
    cascadeOnBookCancel: jest
      .fn()
      .mockResolvedValue({ pgCount: 0, rpgCount: 0 }),
    cascadeOnBookFinalize: jest
      .fn()
      .mockResolvedValue({ pgCount: 0, rpgCount: 0 }),
  };
  const usersService = { findOne: jest.fn() };

  const dataSource = {
    transaction: jest.fn(async (cb: (em: EntityManager) => Promise<any>) => {
      // Default to no-op transaction context unless tests override.
      return cb(opts.cancelManager ?? ({} as EntityManager));
    }),
  };

  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [
      ChangeAssemblyService,
      { provide: getRepositoryToken(ChangeAssemblyDraft), useValue: repos.draftRepo },
      { provide: getRepositoryToken(ChangeAssemblyVersion), useValue: repos.versionRepo },
      { provide: getRepositoryToken(ChangeAssemblyVersionProject), useValue: repos.versionProjectRepo },
      { provide: getRepositoryToken(ChangeProjectLineage), useValue: repos.lineageRepo },
      { provide: getRepositoryToken(WorkHistory), useValue: repos.workHistoryRepo },
      { provide: getRepositoryToken(RevisedProjectGroup), useValue: repos.revisedProjectGroupRepo },
      { provide: getRepositoryToken(DevelopmentPlanRevision), useValue: repos.devPlanRevisionRepo },
      { provide: getRepositoryToken(User), useValue: repos.userRepo },
      { provide: UsersService, useValue: usersService },
      { provide: PdfService, useValue: {} },
      { provide: WebsocketService, useValue: { notifyPdfGenerationProgress: jest.fn() } },
      { provide: BookAssemblyFileService, useValue: {} },
      { provide: StoragePathService, useValue: {} },
      { provide: BookLockService, useValue: bookLockService },
      { provide: OrphanCleanupService, useValue: orphanCleanupService },
      { provide: DataSource, useValue: dataSource },
    ],
  }).compile();

  const service = moduleRef.get(ChangeAssemblyService);
  // Authorize an admin operator by default — needed for cancel which
  // re-validates inside `validateDeprecationAuth`.
  repos.workHistoryRepo.findOne.mockResolvedValue({
    id: 'wh-1',
    role: { name: 'admin' },
    workStatus: { name: 'approved' },
    user: { id: 'user-1' },
  } as any);
  return {
    service,
    repos,
    bookLockService,
    orphanCleanupService,
    usersService,
    dataSource,
  };
}

// ===================================================================
// 1. cancelPublishedVersion happy path (§20.2 LIVE for CHANGE)
// ===================================================================

describe('ChangeAssemblyService.cancelPublishedVersion', () => {
  const REVISION_ID = 'revision-uuid-1';
  const VERSION_ID = 'version-uuid-1';
  const USER_ID = 'user-uuid-1';

  it('deprecates + resets + invokes §18 cancel cascade (no throw)', async () => {
    // Build a per-test EntityManager stub that the cancel flow uses.
    const updateMock = jest.fn().mockResolvedValue({ affected: 1 });
    const lineageRepo = {
      exists: jest.fn().mockResolvedValue(false), // no descendants → allow cancel
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn(),
    };
    const rpgRepo = { update: updateMock };
    const revisionRepo = {
      update: updateMock,
      findOne: jest
        .fn()
        .mockResolvedValue({ id: REVISION_ID } as any),
    };
    const versionRow = {
      id: VERSION_ID,
      developmentPlanRevisionId: REVISION_ID,
      versionNumber: 1,
      status: ChangeAssemblyVersionStatus.COMPLETED,
      part3ProjectSnapshot: ['rpg-1', 'rpg-2'],
    } as any;

    const cancelManager = {
      findOne: jest.fn(async (entity: any) => {
        if (entity === ChangeAssemblyVersion) return versionRow;
        // First call — WorkHistory lookup inside validateDeprecationAuth.
        return {
          id: 'wh-1',
          role: { name: 'admin' },
          workStatus: { name: 'approved' },
          user: { id: USER_ID },
        } as any;
      }),
      update: updateMock,
      getRepository: jest.fn((entity: any) => {
        if (entity === ChangeProjectLineage) return lineageRepo;
        if (entity === RevisedProjectGroup) return rpgRepo;
        if (entity === DevelopmentPlanRevision) return revisionRepo;
        return { update: updateMock, findOne: jest.fn(), save: jest.fn() };
      }),
    } as unknown as jest.Mocked<EntityManager>;

    const { service, usersService, orphanCleanupService, dataSource } =
      await buildService({ cancelManager });

    // Citizen-id match — service compares last-6 of decrypted citizenId
    // against `dto.citizenIdSuffix`.
    usersService.findOne.mockResolvedValue({
      id: USER_ID,
      citizenId: '0000000123456',
    } as any);

    const dto: CancelChangeBookDto = {
      confirmed: true,
      citizenIdSuffix: '123456',
      reason: 'happy-path-cancel-test',
    };

    await expect(
      service.cancelPublishedVersion(REVISION_ID, VERSION_ID, dto, USER_ID),
    ).resolves.toBeUndefined();

    // Transaction was opened.
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    // Version was marked DEPRECATED.
    expect(cancelManager.update).toHaveBeenCalledWith(
      ChangeAssemblyVersion,
      VERSION_ID,
      expect.objectContaining({
        status: ChangeAssemblyVersionStatus.DEPRECATED,
        deprecationReason: 'happy-path-cancel-test',
      }),
    );
    // RPGs were reset (isBooked=false, bookedAt=null, pageNumber=null).
    expect(rpgRepo.update).toHaveBeenCalledWith(
      expect.any(Object),
      { isBooked: false, bookedAt: null, pageNumber: null },
    );
    // Revision was reset (re-opened).
    expect(revisionRepo.update).toHaveBeenCalledWith(
      { id: REVISION_ID },
      { isBooked: false, bookedAt: null, isOpen: true },
    );
    // §18 cancel cascade fired.
    expect(orphanCleanupService.cascadeOnBookCancel).toHaveBeenCalledWith(
      expect.objectContaining({ id: REVISION_ID }),
      'REVISION',
      cancelManager,
      USER_ID,
    );
  });

  it('rejects with BOOK_HAS_DESCENDANT_PUBLISHED when child lineage rows exist', async () => {
    const lineageRepo = {
      exists: jest.fn().mockResolvedValue(true), // descendants exist
      findOne: jest.fn(),
      save: jest.fn(),
    };
    const versionRow = {
      id: VERSION_ID,
      developmentPlanRevisionId: REVISION_ID,
      versionNumber: 1,
      status: ChangeAssemblyVersionStatus.COMPLETED,
      part3ProjectSnapshot: ['rpg-1'],
    } as any;

    const cancelManager = {
      findOne: jest.fn(async (entity: any) => {
        if (entity === ChangeAssemblyVersion) return versionRow;
        return {
          id: 'wh-1',
          role: { name: 'admin' },
          workStatus: { name: 'approved' },
          user: { id: USER_ID },
        } as any;
      }),
      update: jest.fn(),
      getRepository: jest.fn((entity: any) => {
        if (entity === ChangeProjectLineage) return lineageRepo;
        return { update: jest.fn(), findOne: jest.fn(), save: jest.fn() };
      }),
    } as unknown as jest.Mocked<EntityManager>;

    const { service, usersService } = await buildService({ cancelManager });
    usersService.findOne.mockResolvedValue({
      id: USER_ID,
      citizenId: '0000000123456',
    } as any);

    const dto: CancelChangeBookDto = {
      confirmed: true,
      citizenIdSuffix: '123456',
      reason: 'descendant-guard-test',
    };

    await expect(
      service.cancelPublishedVersion(REVISION_ID, VERSION_ID, dto, USER_ID),
    ).rejects.toMatchObject({
      response: { code: 'BOOK_HAS_DESCENDANT_PUBLISHED' },
    });
  });
});

// ===================================================================
// 2. getCurrentVersion returns COMPLETED first; falls back to
//    DEPRECATED via active draft previousVersionId; null otherwise
// ===================================================================

describe('ChangeAssemblyService.getCurrentVersion', () => {
  const REVISION_ID = 'revision-uuid-2';
  const USER_ID = 'user-uuid-2';

  it('returns the COMPLETED version when one exists', async () => {
    const { service, repos } = await buildService();
    // Re-authorize as staff for READ (default is admin which also reads).
    repos.workHistoryRepo.findOne.mockResolvedValue({
      id: 'wh-1',
      role: { name: 'staff' },
      workStatus: { name: 'approved' },
      user: { id: USER_ID },
    } as any);
    const completed = {
      id: 'v-completed-id',
      developmentPlanRevisionId: REVISION_ID,
      versionNumber: 1,
      status: ChangeAssemblyVersionStatus.COMPLETED,
      part1Source: 'uploaded',
      part2Source: 'uploaded',
      part3Source: 'generated',
      part3ProjectCount: 5,
      part3ProjectSnapshot: ['r1', 'r2', 'r3', 'r4', 'r5'],
      createdById: 'wh-creator',
      mergedAt: new Date('2026-05-25T00:00:00Z'),
      createdAt: new Date('2026-05-25T00:00:00Z'),
    } as any;
    repos.versionRepo.findOne.mockResolvedValueOnce(completed);

    const result = await service.getCurrentVersion(REVISION_ID, USER_ID);

    expect(result).not.toBeNull();
    expect(result?.id).toBe('v-completed-id');
    expect(result?.status).toBe(ChangeAssemblyVersionStatus.COMPLETED);
    // COMPLETED short-circuit — draftRepo MUST NOT be queried.
    expect(repos.draftRepo.findOne).not.toHaveBeenCalled();
  });

  it('falls back to DEPRECATED via active draft previousVersionId when no COMPLETED exists', async () => {
    const { service, repos } = await buildService();
    repos.workHistoryRepo.findOne.mockResolvedValue({
      id: 'wh-1',
      role: { name: 'staff' },
      workStatus: { name: 'approved' },
      user: { id: USER_ID },
    } as any);
    // 1st findOne (COMPLETED) → null
    repos.versionRepo.findOne.mockResolvedValueOnce(null);
    // active draft references a previous version
    repos.draftRepo.findOne.mockResolvedValueOnce({
      id: 'draft-1',
      developmentPlanRevisionId: REVISION_ID,
      previousVersionId: 'v-deprecated-id',
      assemblyStatus: ChangeAssemblyDraftStatus.PREPARING,
    } as any);
    // 2nd findOne (previous version)
    const deprecated = {
      id: 'v-deprecated-id',
      developmentPlanRevisionId: REVISION_ID,
      versionNumber: 1,
      status: ChangeAssemblyVersionStatus.DEPRECATED,
      part1Source: 'uploaded',
      part2Source: 'uploaded',
      part3Source: 'generated',
      part3ProjectCount: 3,
      createdById: 'wh-creator',
      deprecatedAt: new Date(),
      deprecationReason: 'reason',
    } as any;
    repos.versionRepo.findOne.mockResolvedValueOnce(deprecated);

    const result = await service.getCurrentVersion(REVISION_ID, USER_ID);

    expect(result?.id).toBe('v-deprecated-id');
    expect(result?.status).toBe(ChangeAssemblyVersionStatus.DEPRECATED);
  });

  it('returns null when neither a COMPLETED version nor an active draft exists', async () => {
    const { service, repos } = await buildService();
    repos.workHistoryRepo.findOne.mockResolvedValue({
      id: 'wh-1',
      role: { name: 'staff' },
      workStatus: { name: 'approved' },
      user: { id: USER_ID },
    } as any);
    repos.versionRepo.findOne.mockResolvedValueOnce(null);
    repos.draftRepo.findOne.mockResolvedValueOnce(null);

    const result = await service.getCurrentVersion(REVISION_ID, USER_ID);
    expect(result).toBeNull();
  });
});

// ===================================================================
// 3. getReadiness returns the proper shape (mirrors revision /
//    main / edit / supplement readiness DTOs byte-for-byte)
// ===================================================================

describe('ChangeAssemblyService.getReadiness', () => {
  const REVISION_ID = 'revision-uuid-3';
  const USER_ID = 'user-uuid-3';

  it('returns the readiness envelope (isReady=true when all approved and revision closed)', async () => {
    const { service, repos } = await buildService();
    repos.workHistoryRepo.findOne.mockResolvedValue({
      id: 'wh-1',
      role: { name: 'staff' },
      workStatus: { name: 'approved' },
      user: { id: USER_ID },
    } as any);

    repos.revisedProjectGroupRepo.createQueryBuilder
      // total
      .mockReturnValueOnce(buildQbStub({ getCount: 3 }))
      // approved
      .mockReturnValueOnce(buildQbStub({ getCount: 3 }))
      // agency
      .mockReturnValueOnce(buildQbStub({ getCount: 3 }))
      // status aggregate
      .mockReturnValueOnce(
        buildQbStub({
          getRawMany: [{ statusName: STATUS_NAMES.APPROVED, cnt: '3' }],
        }),
      );
    // CHANGE readiness uses `DevelopmentPlanRevision.isOpen` (single-row),
    // NOT `PlanPhase.isOpen` query like MAIN.
    repos.devPlanRevisionRepo.findOne.mockResolvedValueOnce({
      id: REVISION_ID,
      isOpen: false,
    } as any);

    const result = await service.getReadiness(REVISION_ID, USER_ID);

    expect(result.totalCount).toBe(3);
    expect(result.approvedCount).toBe(3);
    expect(result.hasOpenPhase).toBe(false);
    expect(result.isReady).toBe(true);
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

  it('returns isReady=false when the revision is still open even if every RPG is Approved', async () => {
    const { service, repos } = await buildService();
    repos.workHistoryRepo.findOne.mockResolvedValue({
      id: 'wh-1',
      role: { name: 'staff' },
      workStatus: { name: 'approved' },
      user: { id: USER_ID },
    } as any);

    repos.revisedProjectGroupRepo.createQueryBuilder
      .mockReturnValueOnce(buildQbStub({ getCount: 2 }))
      .mockReturnValueOnce(buildQbStub({ getCount: 2 }))
      .mockReturnValueOnce(buildQbStub({ getCount: 1 }))
      .mockReturnValueOnce(
        buildQbStub({
          getRawMany: [{ statusName: STATUS_NAMES.APPROVED, cnt: '2' }],
        }),
      );
    repos.devPlanRevisionRepo.findOne.mockResolvedValueOnce({
      id: REVISION_ID,
      isOpen: true,
    } as any);

    const result = await service.getReadiness(REVISION_ID, USER_ID);

    expect(result.totalCount).toBe(2);
    expect(result.approvedCount).toBe(2);
    expect(result.hasOpenPhase).toBe(true);
    expect(result.isReady).toBe(false);
    expect(result.breakdown.agencyCount).toBe(1);
    expect(result.breakdown.laoCount).toBe(1);
  });

  it('returns isReady=false and totalCount=0 on an empty revision', async () => {
    const { service, repos } = await buildService();
    repos.workHistoryRepo.findOne.mockResolvedValue({
      id: 'wh-1',
      role: { name: 'staff' },
      workStatus: { name: 'approved' },
      user: { id: USER_ID },
    } as any);

    repos.revisedProjectGroupRepo.createQueryBuilder
      .mockReturnValueOnce(buildQbStub({ getCount: 0 }))
      .mockReturnValueOnce(buildQbStub({ getCount: 0 }))
      .mockReturnValueOnce(buildQbStub({ getCount: 0 }))
      .mockReturnValueOnce(buildQbStub({ getRawMany: [] }));
    repos.devPlanRevisionRepo.findOne.mockResolvedValueOnce({
      id: REVISION_ID,
      isOpen: false,
    } as any);

    const result = await service.getReadiness(REVISION_ID, USER_ID);

    expect(result.totalCount).toBe(0);
    expect(result.approvedCount).toBe(0);
    expect(result.isReady).toBe(false);
    expect(result.breakdown.totalCount).toBe(0);
  });
});

// ===================================================================
// 4. restoreDraft — happy path + guards (CLEANUP wave port)
// ===================================================================

describe('ChangeAssemblyService.restoreDraft', () => {
  const REVISION_ID = 'revision-uuid-4';
  const USER_ID = 'user-uuid-4';

  it('throws NotFoundException when no canceled draft exists for the revision', async () => {
    const { service, repos } = await buildService();
    repos.workHistoryRepo.findOne.mockResolvedValue({
      id: 'wh-1',
      role: { name: 'admin' },
      workStatus: { name: 'approved' },
      user: { id: USER_ID },
    } as any);
    // No CANCELED draft → first findOne resolves null.
    repos.draftRepo.findOne.mockResolvedValueOnce(null);

    await expect(service.restoreDraft(REVISION_ID, USER_ID)).rejects.toThrow(
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
      developmentPlanRevisionId: REVISION_ID,
      assemblyStatus: ChangeAssemblyDraftStatus.CANCELED,
      part1Status: ChangeAssemblyPartUploadStatus.PENDING,
      part2Status: ChangeAssemblyPartUploadStatus.PENDING,
      part3Status: ChangeAssemblyPartUploadStatus.PENDING,
    } as any);
    // 2nd findOne → active draft also present (blocks restore)
    repos.draftRepo.findOne.mockResolvedValueOnce({
      id: 'active-1',
      developmentPlanRevisionId: REVISION_ID,
      assemblyStatus: ChangeAssemblyDraftStatus.PREPARING,
    } as any);

    await expect(service.restoreDraft(REVISION_ID, USER_ID)).rejects.toThrow(
      ConflictException,
    );
    expect(repos.draftRepo.save).not.toHaveBeenCalled();
  });
});
