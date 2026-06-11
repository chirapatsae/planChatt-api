// ===================================================================
// EditAssemblyService — unit tests
// Wave A2 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// Minimum coverage per the BE-01 task brief:
//   1. cancelPublishedVersion() happy path (vs MAIN's 403 test) —
//      EDIT supports cancel per §20.2; the test asserts the deprecate +
//      reset + cascade flow completes without throwing.
//   2. getCurrentVersion() returns COMPLETED-first (mirror MAIN /
//      supplement) AND falls back to DEPRECATED via the active draft.
//   3. getReadiness() returns the proper shape (parity with revision /
//      main / supplement readiness DTOs).
//
// Mutating-path scenarios (merge, correct, generatePart3) require deep
// transaction / pdf-lib / orphan-cleanup stubbing and are exercised by
// integration tests rather than unit tests — the same precedent set by
// the MAIN and supplement specs.
// ===================================================================

import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { EditAssemblyService } from './edit-assembly.service';
import { EditAssemblyDraft } from './entities/edit-assembly-draft.entity';
import { EditAssemblyVersion } from './entities/edit-assembly-version.entity';
import { EditAssemblyVersionProject } from './entities/edit-assembly-version-project.entity';
import { EditProjectLineage } from './entities/edit-project-lineage.entity';
import {
  EditAssemblyDraftStatus,
  EditAssemblyPartUploadStatus,
  EditAssemblyVersionStatus,
} from './enums/edit-assembly.enums';
import { CancelEditBookDto } from './dto/cancel-edit-book.dto';

import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { RevisedEquipmentProjectGroup } from 'src/revised-equipment-project-group/entities/revised-equipment-project-group.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { User } from 'src/users/entities/user.entity';

import { UsersService } from 'src/users/users.service';
import { PdfService } from 'src/pdf/pdf.service';
import { Por03PdfService } from 'src/pdf/por03-pdf.service';
import { WebsocketService } from 'src/websocket/websocket/websocket.service';
import { BookAssemblyFileService } from 'src/book-assembly/book-assembly-file.service';
import { StoragePathService } from 'src/storage/storage-path.service';
import { BookLockService } from 'src/common/book-lock/book-lock.service';
import { OrphanCleanupService } from 'src/orphan-cleanup/orphan-cleanup.service';
import { LineageLockService } from 'src/common/lineage-lock/lineage-lock.service';

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
  draftRepo: jest.Mocked<Repository<EditAssemblyDraft>>;
  versionRepo: jest.Mocked<Repository<EditAssemblyVersion>>;
  versionProjectRepo: jest.Mocked<Repository<EditAssemblyVersionProject>>;
  lineageRepo: jest.Mocked<Repository<EditProjectLineage>>;
  workHistoryRepo: jest.Mocked<Repository<WorkHistory>>;
  revisedProjectGroupRepo: jest.Mocked<Repository<RevisedProjectGroup>>;
  revisedEquipmentProjectGroupRepo: jest.Mocked<
    Repository<RevisedEquipmentProjectGroup>
  >;
  devPlanRevisionRepo: jest.Mocked<Repository<DevelopmentPlanRevision>>;
  userRepo: jest.Mocked<Repository<User>>;
}

interface BuildOpts {
  /** Pre-canned cancel transaction wiring (for the cancel happy path). */
  cancelManager?: jest.Mocked<EntityManager>;
}

async function buildService(opts: BuildOpts = {}): Promise<{
  service: EditAssemblyService;
  repos: MockRepos;
  bookLockService: { assertEditable: jest.Mock };
  orphanCleanupService: {
    cascadeOnBookCancel: jest.Mock;
    cascadeOnBookFinalize: jest.Mock;
  };
  por03Service: { renderApprovedRevisionScopedPor03Buffer: jest.Mock };
  lineageLockService: { hasNonDeletedDescendant: jest.Mock };
  usersService: { findOne: jest.Mock };
  dataSource: { transaction: jest.Mock };
}> {
  const repos: MockRepos = {
    draftRepo: createMockRepository<EditAssemblyDraft>(),
    versionRepo: createMockRepository<EditAssemblyVersion>(),
    versionProjectRepo: createMockRepository<EditAssemblyVersionProject>(),
    lineageRepo: createMockRepository<EditProjectLineage>(),
    workHistoryRepo: createMockRepository<WorkHistory>(),
    revisedProjectGroupRepo: createMockRepository<RevisedProjectGroup>(),
    revisedEquipmentProjectGroupRepo:
      createMockRepository<RevisedEquipmentProjectGroup>(),
    devPlanRevisionRepo: createMockRepository<DevelopmentPlanRevision>(),
    userRepo: createMockRepository<User>(),
  };
  // getReadiness() issues an Approved-RELPG count via the equipment repo's
  // query builder (approvedEquipmentCount, §17.2 advisory). Default it to a
  // valid getCount=0 stub so the interleaved relpg call never returns
  // undefined; getReadiness tests that assert the RPG counts are unaffected
  // (separate mock) and none assert a specific equipment count.
  (repos.revisedEquipmentProjectGroupRepo.createQueryBuilder as jest.Mock).mockImplementation(
    () => buildQbStub({ getCount: 0 }),
  );

  const bookLockService = { assertEditable: jest.fn().mockResolvedValue(undefined) };
  const orphanCleanupService = {
    cascadeOnBookCancel: jest
      .fn()
      .mockResolvedValue({ pgCount: 0, rpgCount: 0 }),
    cascadeOnBookFinalize: jest
      .fn()
      .mockResolvedValue({ pgCount: 0, rpgCount: 0 }),
  };
  // wave-equipment-booking-stamp-completeness — the merge/preview append
  // the ผ.03 RELPG section via this render core; default to null
  // (no-equipment book = ผ.02 verbatim). Individual tests override.
  const por03Service = {
    renderApprovedRevisionScopedPor03Buffer: jest
      .fn()
      .mockResolvedValue(null),
  };
  // §14.11 downstream-fork guard delegate; default no descendant.
  const lineageLockService = {
    hasNonDeletedDescendant: jest.fn().mockResolvedValue(false),
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
      EditAssemblyService,
      { provide: getRepositoryToken(EditAssemblyDraft), useValue: repos.draftRepo },
      { provide: getRepositoryToken(EditAssemblyVersion), useValue: repos.versionRepo },
      { provide: getRepositoryToken(EditAssemblyVersionProject), useValue: repos.versionProjectRepo },
      { provide: getRepositoryToken(EditProjectLineage), useValue: repos.lineageRepo },
      { provide: getRepositoryToken(WorkHistory), useValue: repos.workHistoryRepo },
      { provide: getRepositoryToken(RevisedProjectGroup), useValue: repos.revisedProjectGroupRepo },
      { provide: getRepositoryToken(RevisedEquipmentProjectGroup), useValue: repos.revisedEquipmentProjectGroupRepo },
      { provide: getRepositoryToken(DevelopmentPlanRevision), useValue: repos.devPlanRevisionRepo },
      { provide: getRepositoryToken(User), useValue: repos.userRepo },
      { provide: UsersService, useValue: usersService },
      { provide: PdfService, useValue: {} },
      { provide: Por03PdfService, useValue: por03Service },
      { provide: WebsocketService, useValue: { notifyPdfGenerationProgress: jest.fn() } },
      { provide: BookAssemblyFileService, useValue: {} },
      { provide: StoragePathService, useValue: {} },
      { provide: BookLockService, useValue: bookLockService },
      { provide: OrphanCleanupService, useValue: orphanCleanupService },
      { provide: LineageLockService, useValue: lineageLockService },
      { provide: DataSource, useValue: dataSource },
    ],
  }).compile();

  const service = moduleRef.get(EditAssemblyService);
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
    por03Service,
    lineageLockService,
    usersService,
    dataSource,
  };
}

// ===================================================================
// 1. cancelPublishedVersion happy path (§20.2 LIVE for EDIT)
// ===================================================================

describe('EditAssemblyService.cancelPublishedVersion', () => {
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
      status: EditAssemblyVersionStatus.COMPLETED,
      part3ProjectSnapshot: ['rpg-1', 'rpg-2'],
    } as any;

    const cancelManager = {
      findOne: jest.fn(async (entity: any) => {
        if (entity === EditAssemblyVersion) return versionRow;
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
        if (entity === EditProjectLineage) return lineageRepo;
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

    const dto: CancelEditBookDto = {
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
      EditAssemblyVersion,
      VERSION_ID,
      expect.objectContaining({
        status: EditAssemblyVersionStatus.DEPRECATED,
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
    // §18.2(B) cancel-no-destroy (2026-06-05): version cancel un-books the
    // snapshot children and reopens the round — it MUST NOT fire the §18
    // `cascadeOnBookCancel`. The cascade is reserved for a whole-BOOK
    // softRemove (§18.2 Event 1), not an assembly-version cancel.
    expect(orphanCleanupService.cascadeOnBookCancel).not.toHaveBeenCalled();
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
      status: EditAssemblyVersionStatus.COMPLETED,
      part3ProjectSnapshot: ['rpg-1'],
    } as any;

    const cancelManager = {
      findOne: jest.fn(async (entity: any) => {
        if (entity === EditAssemblyVersion) return versionRow;
        return {
          id: 'wh-1',
          role: { name: 'admin' },
          workStatus: { name: 'approved' },
          user: { id: USER_ID },
        } as any;
      }),
      update: jest.fn(),
      getRepository: jest.fn((entity: any) => {
        if (entity === EditProjectLineage) return lineageRepo;
        return { update: jest.fn(), findOne: jest.fn(), save: jest.fn() };
      }),
    } as unknown as jest.Mocked<EntityManager>;

    const { service, usersService } = await buildService({ cancelManager });
    usersService.findOne.mockResolvedValue({
      id: USER_ID,
      citizenId: '0000000123456',
    } as any);

    const dto: CancelEditBookDto = {
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
// 1b. Equipment (RELPG) un-stamp on cancel + CORRECTION_PART3
//     wave-equipment-booking-stamp-completeness / QA-01
// ===================================================================
//
// Coverage of the §20.3 Invariant 1 equipment-stamp state machine on
// the un-stamp side (the merge stamp itself requires the full pdf-lib /
// file-service transaction harness and is exercised by integration
// tests, per the existing spec's "mutating-path scenarios" note).
//
// These tests exercise the private `resetRelpgBooking` helper directly
// (reflective access — same pattern as the supplement lineage-helper
// specs) and the cancel transaction end-to-end:
//   - un-stamp issues the raw SQL UPDATE on revised_equipment_project_groups
//     when the version's metadataJson.approvedRelpgIds is present
//   - legacy version (no metadata key) is a silent no-op
//   - §17.2 — the helper has NO repository / tracking-status access; it
//     only calls manager.query (pure column flip)

describe('EditAssemblyService RELPG booking un-stamp (cancel / CORRECTION_PART3)', () => {
  it('resetRelpgBooking issues the un-stamp UPDATE on revised_equipment_project_groups', async () => {
    const { service } = await buildService();
    const queryMock = jest.fn().mockResolvedValue(undefined);
    const trackingSave = jest.fn();
    const manager = {
      query: queryMock,
      // Defensive: if the helper ever reached for a repo we'd catch it.
      getRepository: jest.fn(() => ({ save: trackingSave, insert: jest.fn() })),
    } as any;

    const version = {
      id: 'v-1',
      metadataJson: { approvedRelpgIds: ['relpg-1', 'relpg-2'] },
    } as any;

    await (service as any).resetRelpgBooking(version, manager);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/UPDATE revised_equipment_project_groups/);
    expect(sql).toMatch(/is_booked = false/);
    expect(sql).toMatch(/booked_at = NULL/);
    expect(sql).toMatch(/page_number = NULL/);
    expect(params).toEqual([['relpg-1', 'relpg-2']]);
    // §17.2 — NO tracking_status / ai_* write from the un-stamp helper.
    expect(trackingSave).not.toHaveBeenCalled();
  });

  it('resetRelpgBooking is a silent no-op on a legacy version (no approvedRelpgIds key)', async () => {
    const { service } = await buildService();
    const queryMock = jest.fn().mockResolvedValue(undefined);
    const manager = { query: queryMock, getRepository: jest.fn() } as any;

    // Legacy version: metadataJson null (pre-wave rows never stamped).
    await (service as any).resetRelpgBooking({ id: 'v-legacy', metadataJson: null } as any, manager);
    // Empty array also short-circuits.
    await (service as any).resetRelpgBooking(
      { id: 'v-empty', metadataJson: { approvedRelpgIds: [] } } as any,
      manager,
    );

    expect(queryMock).not.toHaveBeenCalled();
  });

  it('cancelPublishedVersion un-stamps equipment AND writes no tracking_status row', async () => {
    const updateMock = jest.fn().mockResolvedValue({ affected: 1 });
    const queryMock = jest.fn().mockResolvedValue(undefined);
    const trackingSave = jest.fn();
    const lineageRepo = {
      exists: jest.fn().mockResolvedValue(false),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn(),
    };
    const rpgRepo = { update: updateMock };
    const revisionRepo = {
      update: updateMock,
      findOne: jest.fn().mockResolvedValue({ id: 'revision-eq-1' } as any),
    };
    const versionRow = {
      id: 'version-eq-1',
      developmentPlanRevisionId: 'revision-eq-1',
      versionNumber: 1,
      status: EditAssemblyVersionStatus.COMPLETED,
      part3ProjectSnapshot: ['rpg-1'],
      metadataJson: { approvedRelpgIds: ['relpg-1', 'relpg-2'] },
    } as any;

    const cancelManager = {
      findOne: jest.fn(async (entity: any) => {
        if (entity === EditAssemblyVersion) return versionRow;
        return {
          id: 'wh-1',
          role: { name: 'admin' },
          workStatus: { name: 'approved' },
          user: { id: 'user-eq-1' },
        } as any;
      }),
      update: updateMock,
      query: queryMock,
      getRepository: jest.fn((entity: any) => {
        if (entity === EditProjectLineage) return lineageRepo;
        if (entity === RevisedProjectGroup) return rpgRepo;
        if (entity === DevelopmentPlanRevision) return revisionRepo;
        // Any other repo (e.g. TrackingStatus) — track that save was NOT called.
        return { update: updateMock, findOne: jest.fn(), find: jest.fn().mockResolvedValue([]), save: trackingSave, insert: jest.fn() };
      }),
    } as unknown as jest.Mocked<EntityManager>;

    const { service, usersService } = await buildService({ cancelManager });
    usersService.findOne.mockResolvedValue({
      id: 'user-eq-1',
      citizenId: '0000000123456',
    } as any);

    const dto: CancelEditBookDto = {
      confirmed: true,
      citizenIdSuffix: '123456',
      reason: 'equipment-unstamp-cancel',
    };

    await service.cancelPublishedVersion('revision-eq-1', 'version-eq-1', dto, 'user-eq-1');

    // Equipment un-stamp UPDATE fired.
    const equipmentCalls = queryMock.mock.calls.filter(([sql]) =>
      /UPDATE revised_equipment_project_groups/.test(sql),
    );
    expect(equipmentCalls).toHaveLength(1);
    expect(equipmentCalls[0][1]).toEqual([['relpg-1', 'relpg-2']]);
    // §17.2 — no tracking_status write in the cancel/un-stamp path.
    expect(trackingSave).not.toHaveBeenCalled();
  });
});

// ===================================================================
// 2. getCurrentVersion returns COMPLETED first; falls back to
//    DEPRECATED via active draft previousVersionId; null otherwise
// ===================================================================

describe('EditAssemblyService.getCurrentVersion', () => {
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
      status: EditAssemblyVersionStatus.COMPLETED,
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
    expect(result?.status).toBe(EditAssemblyVersionStatus.COMPLETED);
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
      assemblyStatus: EditAssemblyDraftStatus.PREPARING,
    } as any);
    // 2nd findOne (previous version)
    const deprecated = {
      id: 'v-deprecated-id',
      developmentPlanRevisionId: REVISION_ID,
      versionNumber: 1,
      status: EditAssemblyVersionStatus.DEPRECATED,
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
    expect(result?.status).toBe(EditAssemblyVersionStatus.DEPRECATED);
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
//    main / supplement readiness DTOs byte-for-byte)
// ===================================================================

describe('EditAssemblyService.getReadiness', () => {
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
    // EDIT readiness uses `DevelopmentPlanRevision.isOpen` (single-row),
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

describe('EditAssemblyService.restoreDraft', () => {
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
      assemblyStatus: EditAssemblyDraftStatus.CANCELED,
      part1Status: EditAssemblyPartUploadStatus.PENDING,
      part2Status: EditAssemblyPartUploadStatus.PENDING,
      part3Status: EditAssemblyPartUploadStatus.PENDING,
    } as any);
    // 2nd findOne → active draft also present (blocks restore)
    repos.draftRepo.findOne.mockResolvedValueOnce({
      id: 'active-1',
      developmentPlanRevisionId: REVISION_ID,
      assemblyStatus: EditAssemblyDraftStatus.PREPARING,
    } as any);

    await expect(service.restoreDraft(REVISION_ID, USER_ID)).rejects.toThrow(
      ConflictException,
    );
    expect(repos.draftRepo.save).not.toHaveBeenCalled();
  });
});
