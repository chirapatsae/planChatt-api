// ===================================================================
// SupplementAssemblyService — getReadiness unit tests
// wave-supplement-assembly-button-gate / BE-01
// ===================================================================
//
// Scope of this spec: ONLY `getReadiness`. The mutating surfaces
// (createDraft / uploadPart{1,2} / generatePart3 / merge / cancel) are
// not covered here — they are exercised by integration tests and the
// per-wave QA passes (Q4=C). The four scenarios documented in the
// BE-01 task are the acceptance contract for this spec:
//   (a) zero projects               → isReady=false, totalCount=0
//   (b) all approved, isOpen=true   → isReady=false, hasOpenPhase=true
//   (c) all approved, isOpen=false  → isReady=true,  hasOpenPhase=false
//   (d) mixed statuses, isOpen=false → isReady=false (approved<total)
// ===================================================================

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { SupplementAssemblyService } from './supplement-assembly.service';
import { SupplementAssemblyDraft } from './entities/supplement-assembly-draft.entity';
import { SupplementAssemblyVersion } from './entities/supplement-assembly-version.entity';
import { SupplementAssemblyVersionProject } from './entities/supplement-assembly-version-project.entity';
import { SupplementAssemblyVersionStatus } from './enums/supplement-assembly.enums';
import { CancelSupplementBookDto } from './dto/cancel-supplement-book.dto';
import { SupplementProjectLineage } from './entities/supplement-project-lineage.entity';

import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { User } from 'src/users/entities/user.entity';

import { SupplementAssemblyFileService } from './supplement-assembly-file.service';
import { SupplementPdfService } from 'src/pdf/supplement-pdf.service';
import { BookLockService } from 'src/common/book-lock/book-lock.service';
import { OrphanCleanupService } from 'src/orphan-cleanup/orphan-cleanup.service';
import { UsersService } from 'src/users/users.service';
import { STATUS_NAMES } from 'src/common/status-names';
import { SupplementBookDisplayStateEnum } from './dto/supplement-book-display-state.dto';

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
    createQueryBuilder: jest.fn(),
  } as unknown as jest.Mocked<Repository<T>>;
}

/**
 * Build a chainable QueryBuilder stub whose terminal methods
 * (`getCount` / `getRawMany` / `getExists`) resolve to caller-supplied
 * values. Every chain link returns `this` so the fluent calls in the
 * service compose correctly.
 */
function buildQbStub(terminals: {
  getCount?: number;
  getRawMany?: any[];
}) {
  const qb: any = {};
  const chain = () => qb;
  qb.innerJoin = jest.fn(chain);
  qb.leftJoin = jest.fn(chain);
  qb.select = jest.fn(chain);
  qb.addSelect = jest.fn(chain);
  qb.where = jest.fn(chain);
  qb.andWhere = jest.fn(chain);
  qb.groupBy = jest.fn(chain);
  qb.orderBy = jest.fn(chain);
  qb.getCount = jest.fn().mockResolvedValue(terminals.getCount ?? 0);
  qb.getRawMany = jest.fn().mockResolvedValue(terminals.getRawMany ?? []);
  return qb;
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});

// -------------------------------------------------------------------
// Test setup
// -------------------------------------------------------------------

describe('SupplementAssemblyService.getReadiness', () => {
  let service: SupplementAssemblyService;
  let supplementRepo: jest.Mocked<Repository<DevelopmentPlanSupplement>>;
  let spgRepo: jest.Mocked<Repository<SupplementProjectGroup>>;
  let workHistoryRepo: jest.Mocked<Repository<WorkHistory>>;

  const SUPP_ID = 'supp-uuid-1';
  const USER_ID = 'user-uuid-1';

  beforeEach(async () => {
    supplementRepo = createMockRepository<DevelopmentPlanSupplement>();
    spgRepo = createMockRepository<SupplementProjectGroup>();
    workHistoryRepo = createMockRepository<WorkHistory>();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SupplementAssemblyService,
        {
          provide: getRepositoryToken(SupplementAssemblyDraft),
          useValue: createMockRepository<SupplementAssemblyDraft>(),
        },
        {
          provide: getRepositoryToken(SupplementAssemblyVersion),
          useValue: createMockRepository<SupplementAssemblyVersion>(),
        },
        {
          provide: getRepositoryToken(SupplementAssemblyVersionProject),
          useValue: createMockRepository<SupplementAssemblyVersionProject>(),
        },
        {
          provide: getRepositoryToken(DevelopmentPlanSupplement),
          useValue: supplementRepo,
        },
        {
          provide: getRepositoryToken(SupplementProjectGroup),
          useValue: spgRepo,
        },
        {
          provide: getRepositoryToken(WorkHistory),
          useValue: workHistoryRepo,
        },
        {
          provide: getRepositoryToken(User),
          useValue: createMockRepository<User>(),
        },
        { provide: SupplementAssemblyFileService, useValue: {} },
        { provide: SupplementPdfService, useValue: {} },
        { provide: BookLockService, useValue: {} },
        { provide: OrphanCleanupService, useValue: {} },
        { provide: UsersService, useValue: { findOne: jest.fn() } },
        { provide: DataSource, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(SupplementAssemblyService);

    // Authorize the caller — staff is in READ_ROLES.
    workHistoryRepo.findOne.mockResolvedValue({
      id: 'wh-1',
      role: { name: 'staff' },
      workStatus: { name: 'approved' },
      user: { id: USER_ID },
    } as any);
  });

  // --- scenario (a) -------------------------------------------------
  it('returns isReady=false and totalCount=0 when no projects exist (isOpen=false)', async () => {
    supplementRepo.findOne.mockResolvedValue({
      id: SUPP_ID,
      isOpen: false,
    } as any);

    // total / approved / agency / statusRows
    spgRepo.createQueryBuilder
      .mockReturnValueOnce(buildQbStub({ getCount: 0 }))
      .mockReturnValueOnce(buildQbStub({ getCount: 0 }))
      .mockReturnValueOnce(buildQbStub({ getCount: 0 }))
      .mockReturnValueOnce(buildQbStub({ getRawMany: [] }));

    const result = await service.getReadiness(SUPP_ID, USER_ID);

    expect(result.totalCount).toBe(0);
    expect(result.approvedCount).toBe(0);
    expect(result.hasOpenPhase).toBe(false);
    expect(result.isReady).toBe(false);
    expect(result.breakdown.totalCount).toBe(0);
    expect(result.breakdown.agencyCount).toBe(0);
    expect(result.breakdown.laoCount).toBe(0);
  });

  // --- scenario (b) -------------------------------------------------
  it('returns isReady=false when all projects are Approved but supplement.isOpen=true', async () => {
    supplementRepo.findOne.mockResolvedValue({
      id: SUPP_ID,
      isOpen: true,
    } as any);

    spgRepo.createQueryBuilder
      .mockReturnValueOnce(buildQbStub({ getCount: 3 })) // total
      .mockReturnValueOnce(buildQbStub({ getCount: 3 })) // approved
      .mockReturnValueOnce(buildQbStub({ getCount: 3 })) // agency
      .mockReturnValueOnce(
        buildQbStub({
          getRawMany: [{ statusName: STATUS_NAMES.APPROVED, cnt: '3' }],
        }),
      );

    const result = await service.getReadiness(SUPP_ID, USER_ID);

    expect(result.totalCount).toBe(3);
    expect(result.approvedCount).toBe(3);
    expect(result.hasOpenPhase).toBe(true);
    expect(result.isReady).toBe(false); // gated by hasOpenPhase
    expect(result.breakdown.approvedCount).toBe(3);
  });

  // --- scenario (c) -------------------------------------------------
  it('returns isReady=true when all projects are Approved AND supplement.isOpen=false', async () => {
    supplementRepo.findOne.mockResolvedValue({
      id: SUPP_ID,
      isOpen: false,
    } as any);

    spgRepo.createQueryBuilder
      .mockReturnValueOnce(buildQbStub({ getCount: 2 })) // total
      .mockReturnValueOnce(buildQbStub({ getCount: 2 })) // approved
      .mockReturnValueOnce(buildQbStub({ getCount: 2 })) // agency
      .mockReturnValueOnce(
        buildQbStub({
          getRawMany: [{ statusName: STATUS_NAMES.APPROVED, cnt: '2' }],
        }),
      );

    const result = await service.getReadiness(SUPP_ID, USER_ID);

    expect(result.totalCount).toBe(2);
    expect(result.approvedCount).toBe(2);
    expect(result.hasOpenPhase).toBe(false);
    expect(result.isReady).toBe(true);
  });

  // --- scenario (d) -------------------------------------------------
  it('returns isReady=false with mixed statuses (isOpen=false, approved<total)', async () => {
    supplementRepo.findOne.mockResolvedValue({
      id: SUPP_ID,
      isOpen: false,
    } as any);

    // Pretend 3 in-flight (1 Approved + 1 Pending + 1 Verified) — Ready
    // / Pull_Back / Rejected are excluded from totalCount per the
    // SUPPLEMENT_READINESS_EXCLUSION_STATUSES contract.
    spgRepo.createQueryBuilder
      .mockReturnValueOnce(buildQbStub({ getCount: 3 })) // total
      .mockReturnValueOnce(buildQbStub({ getCount: 1 })) // approved
      .mockReturnValueOnce(buildQbStub({ getCount: 3 })) // agency
      .mockReturnValueOnce(
        buildQbStub({
          getRawMany: [
            { statusName: STATUS_NAMES.APPROVED, cnt: '1' },
            { statusName: STATUS_NAMES.PENDING, cnt: '1' },
            { statusName: STATUS_NAMES.VERIFIED, cnt: '1' },
          ],
        }),
      );

    const result = await service.getReadiness(SUPP_ID, USER_ID);

    expect(result.totalCount).toBe(3);
    expect(result.approvedCount).toBe(1);
    expect(result.hasOpenPhase).toBe(false);
    expect(result.isReady).toBe(false); // gated by approved<total
    expect(result.breakdown.pendingCount).toBe(1);
    expect(result.breakdown.verifiedCount).toBe(1);
    expect(result.breakdown.approvedCount).toBe(1);
  });

  // --- 404 on missing supplement ------------------------------------
  it('throws NotFoundException when the supplement does not exist', async () => {
    supplementRepo.findOne.mockResolvedValue(null);
    await expect(service.getReadiness(SUPP_ID, USER_ID)).rejects.toThrow(
      /ไม่พบรอบเพิ่มเติม/,
    );
  });
});

// -------------------------------------------------------------------
// getBookDisplayState
// -------------------------------------------------------------------

describe('SupplementAssemblyService.getBookDisplayState', () => {
  let service: SupplementAssemblyService;
  let supplementRepo: jest.Mocked<Repository<DevelopmentPlanSupplement>>;
  let draftRepo: jest.Mocked<Repository<SupplementAssemblyDraft>>;
  let workHistoryRepo: jest.Mocked<Repository<WorkHistory>>;
  let bookLockService: { assertEditable: jest.Mock };

  const SUPP_ID = 'supp-uuid-2';
  const USER_ID = 'user-uuid-2';

  beforeEach(async () => {
    supplementRepo = createMockRepository<DevelopmentPlanSupplement>();
    draftRepo = createMockRepository<SupplementAssemblyDraft>();
    workHistoryRepo = createMockRepository<WorkHistory>();
    // supplementRepo.manager is accessed by the service; stub the property.
    (supplementRepo as any).manager = {};
    bookLockService = { assertEditable: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SupplementAssemblyService,
        {
          provide: getRepositoryToken(SupplementAssemblyDraft),
          useValue: draftRepo,
        },
        {
          provide: getRepositoryToken(SupplementAssemblyVersion),
          useValue: createMockRepository<SupplementAssemblyVersion>(),
        },
        {
          provide: getRepositoryToken(SupplementAssemblyVersionProject),
          useValue: createMockRepository<SupplementAssemblyVersionProject>(),
        },
        {
          provide: getRepositoryToken(DevelopmentPlanSupplement),
          useValue: supplementRepo,
        },
        {
          provide: getRepositoryToken(SupplementProjectGroup),
          useValue: createMockRepository<SupplementProjectGroup>(),
        },
        {
          provide: getRepositoryToken(WorkHistory),
          useValue: workHistoryRepo,
        },
        {
          provide: getRepositoryToken(User),
          useValue: createMockRepository<User>(),
        },
        { provide: SupplementAssemblyFileService, useValue: {} },
        { provide: SupplementPdfService, useValue: {} },
        { provide: BookLockService, useValue: bookLockService },
        { provide: OrphanCleanupService, useValue: {} },
        { provide: UsersService, useValue: { findOne: jest.fn() } },
        { provide: DataSource, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(SupplementAssemblyService);

    // Authorize the caller — staff is in READ_ROLES.
    workHistoryRepo.findOne.mockResolvedValue({
      id: 'wh-1',
      role: { name: 'staff' },
      workStatus: { name: 'approved' },
      user: { id: USER_ID },
    } as any);
  });

  it('returns state=no_book when supplement is unbooked and no active draft exists', async () => {
    supplementRepo.findOne.mockResolvedValue({
      id: SUPP_ID,
      isBooked: false,
    } as any);
    bookLockService.assertEditable.mockResolvedValue(undefined);
    draftRepo.findOne.mockResolvedValue(null);

    const result = await service.getBookDisplayState(SUPP_ID, USER_ID);

    expect(result.state).toBe(SupplementBookDisplayStateEnum.NO_BOOK);
    expect(result.isLeaf).toBe(true);
    expect(result.hasActiveDraftDependency).toBe(false);
    expect(result.blockedProjectCount).toBe(0);
    expect(result.supplementId).toBe(SUPP_ID);
  });

  it('returns state=draft when supplement is unbooked and an active draft exists', async () => {
    supplementRepo.findOne.mockResolvedValue({
      id: SUPP_ID,
      isBooked: false,
    } as any);
    bookLockService.assertEditable.mockResolvedValue(undefined);
    draftRepo.findOne.mockResolvedValue({ id: 'draft-1' } as any);

    const result = await service.getBookDisplayState(SUPP_ID, USER_ID);

    expect(result.state).toBe(SupplementBookDisplayStateEnum.DRAFT);
    expect(result.isLeaf).toBe(true);
  });

  it('returns state=published_latest when supplement is booked and is the leaf', async () => {
    supplementRepo.findOne.mockResolvedValue({
      id: SUPP_ID,
      isBooked: true,
    } as any);
    bookLockService.assertEditable.mockResolvedValue(undefined);

    const result = await service.getBookDisplayState(SUPP_ID, USER_ID);

    expect(result.state).toBe(
      SupplementBookDisplayStateEnum.PUBLISHED_LATEST,
    );
    expect(result.isLeaf).toBe(true);
  });

  it('returns state=frozen_historical when supplement is booked AND locked by a newer sibling', async () => {
    supplementRepo.findOne.mockResolvedValue({
      id: SUPP_ID,
      isBooked: true,
    } as any);
    bookLockService.assertEditable.mockRejectedValue(
      new ConflictException(
        'BOOK_HAS_NEWER_REVISION: ไม่สามารถแก้ไขเล่มนี้ได้ (CLAUDE.md §15)',
      ),
    );

    const result = await service.getBookDisplayState(SUPP_ID, USER_ID);

    expect(result.state).toBe(
      SupplementBookDisplayStateEnum.FROZEN_HISTORICAL,
    );
    expect(result.isLeaf).toBe(false);
  });

  it('throws NotFoundException when the supplement does not exist', async () => {
    supplementRepo.findOne.mockResolvedValue(null);
    await expect(
      service.getBookDisplayState(SUPP_ID, USER_ID),
    ).rejects.toThrow(NotFoundException);
  });

  it('propagates non-BOOK_HAS_NEWER_REVISION conflicts from BookLockService', async () => {
    supplementRepo.findOne.mockResolvedValue({
      id: SUPP_ID,
      isBooked: true,
    } as any);
    const otherErr = new ConflictException('some other unrelated conflict');
    bookLockService.assertEditable.mockRejectedValue(otherErr);

    await expect(
      service.getBookDisplayState(SUPP_ID, USER_ID),
    ).rejects.toBe(otherErr);
  });
});

// -------------------------------------------------------------------
// cancelPublishedVersion
// wave-supplement-convergence-milestone-1-parity-contract / BE-01
// -------------------------------------------------------------------
//
// Acceptance contract (per the task file):
//   - 401 if citizenIdSuffix mismatch
//   - 403 if not admin/super-admin role
//   - 404 if version not found
//   - 409 BOOK_HAS_NEWER_REVISION if §15 lock
//   - 409 CANNOT_CANCEL_DEPRECATED if status is already DEPRECATED
//   - Happy path: version → DEPRECATED, SPG pageNumber cleared,
//     supplement isBooked=false / bookedAt=null
//
// We use a fake EntityManager that intercepts findOne / update / get
// Repository calls and routes them to per-entity jest mocks so the
// transaction block can be exercised end-to-end without a live DB.

describe('SupplementAssemblyService.cancelPublishedVersion', () => {
  let service: SupplementAssemblyService;
  let workHistoryRepo: jest.Mocked<Repository<WorkHistory>>;
  let bookLockService: { assertEditable: jest.Mock };
  let usersService: { findOne: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  // Per-transaction-call fake state.
  let versionFindOne: jest.Mock;
  let versionUpdate: jest.Mock;
  let supplementUpdate: jest.Mock;
  let spgUpdate: jest.Mock;
  let whFindOne: jest.Mock;

  const SUPP_ID = 'supp-uuid-cancel';
  const VERSION_ID = 'version-uuid-cancel';
  const USER_ID = 'user-uuid-cancel';
  const CITIZEN_ID = '1234567890123';
  const CITIZEN_SUFFIX = CITIZEN_ID.slice(-6); // '890123'

  const validDto: CancelSupplementBookDto = {
    confirmed: true,
    citizenIdSuffix: CITIZEN_SUFFIX,
    reason: 'ทดสอบยกเลิกเล่มเพิ่มเติม v1 เนื่องจากเอกสารคลาดเคลื่อน',
  };

  beforeEach(async () => {
    workHistoryRepo = createMockRepository<WorkHistory>();
    bookLockService = { assertEditable: jest.fn().mockResolvedValue(undefined) };
    usersService = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: USER_ID, citizenId: CITIZEN_ID }),
    };

    versionFindOne = jest.fn();
    versionUpdate = jest.fn().mockResolvedValue({ affected: 1 });
    supplementUpdate = jest.fn().mockResolvedValue({ affected: 1 });
    spgUpdate = jest.fn().mockResolvedValue({ affected: 1 });
    whFindOne = jest.fn().mockResolvedValue({
      id: 'wh-admin-1',
      role: { name: 'admin' },
      workStatus: { name: 'approved' },
      user: { id: USER_ID },
    });

    // EntityManager fake — routes calls based on the entity argument's
    // class name. The service's transaction body calls
    // `manager.findOne(SupplementAssemblyVersion, ...)`,
    // `manager.findOne(WorkHistory, ...)`,
    // `manager.update(SupplementAssemblyVersion, ...)`, and reaches
    // `manager.getRepository(SupplementProjectGroup).update(...)` /
    // `manager.getRepository(DevelopmentPlanSupplement).update(...)`
    // via the two helper methods.
    const fakeManager = {
      findOne: jest.fn((entity: any, opts: any) => {
        if (entity === SupplementAssemblyVersion) {
          return versionFindOne(entity, opts);
        }
        if (entity === WorkHistory) {
          return whFindOne(entity, opts);
        }
        return Promise.resolve(null);
      }),
      update: jest.fn((entity: any, id: any, patch: any) => {
        if (entity === SupplementAssemblyVersion) {
          return versionUpdate(entity, id, patch);
        }
        return Promise.resolve({ affected: 0 });
      }),
      getRepository: jest.fn((entity: any) => {
        if (entity === SupplementProjectGroup) {
          return { update: spgUpdate };
        }
        if (entity === DevelopmentPlanSupplement) {
          return { update: supplementUpdate };
        }
        // wave-supplement-convergence-milestone-4-lineage / BE-01
        // (2026-05-25) — cancelPublishedVersion now invokes
        // restoreLineageAfterSupplementCancel which calls
        // manager.getRepository(SupplementProjectLineage).find() +
        // .save(). For tests in this describe block we only care that
        // the call is non-fatal; the dedicated lineage describe block
        // below exercises the behavior directly.
        if (entity === SupplementProjectLineage) {
          return {
            find: jest.fn().mockResolvedValue([]),
            findOne: jest.fn().mockResolvedValue(null),
            save: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
          };
        }
        return { update: jest.fn() };
      }),
    };

    dataSource = {
      transaction: jest.fn(async (cb: any) => cb(fakeManager)),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SupplementAssemblyService,
        {
          provide: getRepositoryToken(SupplementAssemblyDraft),
          useValue: createMockRepository<SupplementAssemblyDraft>(),
        },
        {
          provide: getRepositoryToken(SupplementAssemblyVersion),
          useValue: createMockRepository<SupplementAssemblyVersion>(),
        },
        {
          provide: getRepositoryToken(SupplementAssemblyVersionProject),
          useValue: createMockRepository<SupplementAssemblyVersionProject>(),
        },
        {
          provide: getRepositoryToken(DevelopmentPlanSupplement),
          useValue: createMockRepository<DevelopmentPlanSupplement>(),
        },
        {
          provide: getRepositoryToken(SupplementProjectGroup),
          useValue: createMockRepository<SupplementProjectGroup>(),
        },
        {
          provide: getRepositoryToken(WorkHistory),
          useValue: workHistoryRepo,
        },
        {
          provide: getRepositoryToken(User),
          useValue: createMockRepository<User>(),
        },
        { provide: SupplementAssemblyFileService, useValue: {} },
        { provide: SupplementPdfService, useValue: {} },
        { provide: BookLockService, useValue: bookLockService },
        { provide: OrphanCleanupService, useValue: {} },
        { provide: UsersService, useValue: usersService },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = moduleRef.get(SupplementAssemblyService);
  });

  it('happy path — deprecates COMPLETED version + resets supplement + clears SPG pageNumber', async () => {
    versionFindOne.mockResolvedValue({
      id: VERSION_ID,
      developmentPlanSupplementId: SUPP_ID,
      versionNumber: 1,
      status: SupplementAssemblyVersionStatus.COMPLETED,
      part3ProjectSnapshot: ['Project A', 'Project B'],
      metadataJson: {
        approvedSpgIds: ['spg-uuid-1', 'spg-uuid-2'],
      },
    });

    await service.cancelPublishedVersion(SUPP_ID, VERSION_ID, validDto, USER_ID);

    // §15 lock check ran first.
    expect(bookLockService.assertEditable).toHaveBeenCalledWith(
      SUPP_ID,
      'development_plan_supplement',
      expect.anything(),
    );

    // Version deprecated.
    expect(versionUpdate).toHaveBeenCalledWith(
      SupplementAssemblyVersion,
      VERSION_ID,
      expect.objectContaining({
        status: SupplementAssemblyVersionStatus.DEPRECATED,
        deprecatedById: 'wh-admin-1',
        deprecationReason: validDto.reason,
      }),
    );

    // wave-supplement-convergence-milestone-2-spg-booked-fields /
    // BE-01 (2026-05-25) — SPG booking state cleared via the UUID-
    // keyed preferred path. Patch now mirrors PG/RPG: isBooked=false,
    // bookedAt=null, pageNumber=null (DB-01 of the same wave added
    // the columns; helper upgraded to write all three).
    expect(spgUpdate).toHaveBeenCalledWith(
      { id: expect.anything() },
      { isBooked: false, bookedAt: null, pageNumber: null },
    );

    // Supplement isBooked=false + bookedAt=null (the §15 unlock).
    expect(supplementUpdate).toHaveBeenCalledWith(
      { id: SUPP_ID },
      { isBooked: false, bookedAt: null },
    );
  });

  // wave-supplement-convergence-milestone-2-spg-booked-fields / BE-01
  // (2026-05-25) — explicit assertion that the helper writes the SAME
  // full-reset patch on the legacy fallback (title-keyed) path that it
  // does on the preferred UUID path, so a legacy version row without
  // `metadataJson.approvedSpgIds` still clears isBooked + bookedAt
  // alongside pageNumber. Without this assertion, a regression that
  // skipped the new fields on the fallback branch would silently leave
  // legacy SPGs in `isBooked=true` after their host version is
  // cancelled — exactly the §20 parity bug DB-01 / BE-01 set out to
  // close.
  it('happy path (legacy fallback) — title-keyed reset also clears isBooked + bookedAt + pageNumber', async () => {
    versionFindOne.mockResolvedValue({
      id: VERSION_ID,
      developmentPlanSupplementId: SUPP_ID,
      versionNumber: 1,
      status: SupplementAssemblyVersionStatus.COMPLETED,
      part3ProjectSnapshot: ['Legacy Project A'],
      // No metadataJson.approvedSpgIds — exercises the title-keyed
      // fallback path inside resetSupplementProjectBooking.
      metadataJson: null,
    });

    await service.cancelPublishedVersion(SUPP_ID, VERSION_ID, validDto, USER_ID);

    expect(spgUpdate).toHaveBeenCalledWith(
      { title: expect.anything() },
      { isBooked: false, bookedAt: null, pageNumber: null },
    );
    expect(supplementUpdate).toHaveBeenCalledWith(
      { id: SUPP_ID },
      { isBooked: false, bookedAt: null },
    );
  });

  it('throws 401 UnauthorizedException when citizenIdSuffix does not match', async () => {
    versionFindOne.mockResolvedValue({
      id: VERSION_ID,
      developmentPlanSupplementId: SUPP_ID,
      versionNumber: 1,
      status: SupplementAssemblyVersionStatus.COMPLETED,
      part3ProjectSnapshot: [],
      metadataJson: null,
    });

    const badDto: CancelSupplementBookDto = {
      ...validDto,
      citizenIdSuffix: '000000',
    };

    await expect(
      service.cancelPublishedVersion(SUPP_ID, VERSION_ID, badDto, USER_ID),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // Version row must NOT be touched on auth failure.
    expect(versionUpdate).not.toHaveBeenCalled();
    expect(supplementUpdate).not.toHaveBeenCalled();
  });

  it('throws 403 ForbiddenException when role is not admin/super-admin', async () => {
    whFindOne.mockResolvedValue({
      id: 'wh-staff-1',
      role: { name: 'staff' },
      workStatus: { name: 'approved' },
      user: { id: USER_ID },
    });

    await expect(
      service.cancelPublishedVersion(SUPP_ID, VERSION_ID, validDto, USER_ID),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Loading the version is gated AFTER role check fires (the
    // validate helper runs first), so the version repo should not be
    // hit either way — but the critical assertion is no write.
    expect(versionUpdate).not.toHaveBeenCalled();
  });

  it('throws 409 BOOK_HAS_NEWER_REVISION when §15 lock blocks the supplement', async () => {
    bookLockService.assertEditable.mockRejectedValue(
      new ConflictException(
        'BOOK_HAS_NEWER_REVISION: เล่มนี้ถูกตรึงโดยเล่มถัดไป (CLAUDE.md §15)',
      ),
    );

    await expect(
      service.cancelPublishedVersion(SUPP_ID, VERSION_ID, validDto, USER_ID),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(versionFindOne).not.toHaveBeenCalled();
    expect(versionUpdate).not.toHaveBeenCalled();
  });

  it('throws 409 CANNOT_CANCEL_DEPRECATED on a second cancel of the same version', async () => {
    versionFindOne.mockResolvedValue({
      id: VERSION_ID,
      developmentPlanSupplementId: SUPP_ID,
      versionNumber: 1,
      status: SupplementAssemblyVersionStatus.DEPRECATED,
      part3ProjectSnapshot: [],
      metadataJson: null,
    });

    await expect(
      service.cancelPublishedVersion(SUPP_ID, VERSION_ID, validDto, USER_ID),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'CANNOT_CANCEL_DEPRECATED' }),
    });

    expect(versionUpdate).not.toHaveBeenCalled();
    expect(supplementUpdate).not.toHaveBeenCalled();
  });

  it('throws 404 NotFoundException when the version row does not exist for the supplement', async () => {
    versionFindOne.mockResolvedValue(null);

    await expect(
      service.cancelPublishedVersion(SUPP_ID, VERSION_ID, validDto, USER_ID),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(versionUpdate).not.toHaveBeenCalled();
    expect(supplementUpdate).not.toHaveBeenCalled();
  });

  it('throws 400 BadRequestException when confirmed=false', async () => {
    const unconfirmedDto: CancelSupplementBookDto = {
      ...validDto,
      confirmed: false,
    };

    await expect(
      service.cancelPublishedVersion(
        SUPP_ID,
        VERSION_ID,
        unconfirmedDto,
        USER_ID,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(versionUpdate).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------
// Multi-version reads (getCurrentVersion / getVersions / toVersionDto)
// wave-supplement-convergence-milestone-3-multi-version / BE-01
// -------------------------------------------------------------------
//
// Acceptance contract (per the M3 BE-01 task scope):
//   - getCurrentVersion resolves the COMPLETED row first, falling back
//     to the active-draft's previousVersionId when no COMPLETED exists.
//     This mirrors `BookAssemblyService.getCurrentVersion`
//     (book-assembly.service.ts:1754-1796).
//   - getVersions returns BOTH COMPLETED and DEPRECATED rows in
//     versionNumber DESC order so the FE history list can render the
//     full audit chain.
//   - toVersionDto exposes correctionMode / correctionReason /
//     deprecatedAt / deprecatedById / deprecationReason / deprecatedBy
//     so the FE history list can render the M3 audit chain.

describe('SupplementAssemblyService multi-version reads', () => {
  let service: SupplementAssemblyService;
  let versionRepo: jest.Mocked<Repository<SupplementAssemblyVersion>>;
  let draftRepo: jest.Mocked<Repository<SupplementAssemblyDraft>>;
  let workHistoryRepo: jest.Mocked<Repository<WorkHistory>>;

  const SUPP_ID = 'supp-uuid-m3';
  const USER_ID = 'user-uuid-m3';

  beforeEach(async () => {
    versionRepo = createMockRepository<SupplementAssemblyVersion>();
    draftRepo = createMockRepository<SupplementAssemblyDraft>();
    workHistoryRepo = createMockRepository<WorkHistory>();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SupplementAssemblyService,
        {
          provide: getRepositoryToken(SupplementAssemblyDraft),
          useValue: draftRepo,
        },
        {
          provide: getRepositoryToken(SupplementAssemblyVersion),
          useValue: versionRepo,
        },
        {
          provide: getRepositoryToken(SupplementAssemblyVersionProject),
          useValue: createMockRepository<SupplementAssemblyVersionProject>(),
        },
        {
          provide: getRepositoryToken(DevelopmentPlanSupplement),
          useValue: createMockRepository<DevelopmentPlanSupplement>(),
        },
        {
          provide: getRepositoryToken(SupplementProjectGroup),
          useValue: createMockRepository<SupplementProjectGroup>(),
        },
        {
          provide: getRepositoryToken(WorkHistory),
          useValue: workHistoryRepo,
        },
        {
          provide: getRepositoryToken(User),
          useValue: createMockRepository<User>(),
        },
        {
          provide: SupplementAssemblyFileService,
          // `validateVersionNumber` is called by `getVersionByNumber`
          // before the repo lookup — stub as a no-op so the test does
          // not need to exercise the file-system layer.
          useValue: { validateVersionNumber: jest.fn() },
        },
        { provide: SupplementPdfService, useValue: {} },
        { provide: BookLockService, useValue: {} },
        { provide: OrphanCleanupService, useValue: {} },
        { provide: UsersService, useValue: { findOne: jest.fn() } },
        { provide: DataSource, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(SupplementAssemblyService);

    // Authorize the caller — staff is in READ_ROLES.
    workHistoryRepo.findOne.mockResolvedValue({
      id: 'wh-1',
      role: { name: 'staff' },
      workStatus: { name: 'approved' },
      user: { id: USER_ID },
    } as any);
  });

  // --- getCurrentVersion --------------------------------------------

  it('getCurrentVersion: returns the COMPLETED row when one exists (multi-version steady state)', async () => {
    // v1 was deprecated by an earlier correction; v2 is the new
    // COMPLETED head. The partial-unique index guarantees that
    // findOne({ status: COMPLETED }) returns v2 deterministically.
    versionRepo.findOne.mockResolvedValueOnce({
      id: 'v2',
      developmentPlanSupplementId: SUPP_ID,
      versionNumber: 2,
      status: SupplementAssemblyVersionStatus.COMPLETED,
      createdAt: new Date('2026-05-25T00:00:00Z'),
      mergedAt: new Date('2026-05-25T00:00:00Z'),
      correctionMode: 'correction_part3',
      correctionReason: 'แก้ไขส่วนที่ 3',
    } as any);

    const result = await service.getCurrentVersion(SUPP_ID, USER_ID);

    expect(result).not.toBeNull();
    expect(result!.versionNumber).toBe(2);
    expect(result!.status).toBe(SupplementAssemblyVersionStatus.COMPLETED);
    expect(result!.correctionMode).toBe('correction_part3');
    expect(result!.correctionReason).toBe('แก้ไขส่วนที่ 3');
    // Active-draft fallback path MUST NOT be hit when a COMPLETED row
    // resolves on step 1.
    expect(draftRepo.findOne).not.toHaveBeenCalled();
  });

  it('getCurrentVersion: falls back to the deprecated previous version when correction is in-flight', async () => {
    // Correction has deprecated v1 but the new v2 has not yet merged.
    // Step 1 → null (no COMPLETED); step 2 → active draft references v1
    // via previousVersionId; step 2b → load v1 (DEPRECATED) and return.
    versionRepo.findOne.mockResolvedValueOnce(null); // step 1
    draftRepo.findOne.mockResolvedValueOnce({
      id: 'draft-1',
      previousVersionId: 'v1',
    } as any);
    versionRepo.findOne.mockResolvedValueOnce({
      id: 'v1',
      developmentPlanSupplementId: SUPP_ID,
      versionNumber: 1,
      status: SupplementAssemblyVersionStatus.DEPRECATED,
      createdAt: new Date('2026-05-24T00:00:00Z'),
      mergedAt: new Date('2026-05-24T00:00:00Z'),
      deprecatedAt: new Date('2026-05-25T00:00:00Z'),
      deprecationReason: 'แก้ไขเพื่อปรับปรุงข้อมูล',
    } as any);

    const result = await service.getCurrentVersion(SUPP_ID, USER_ID);

    expect(result).not.toBeNull();
    expect(result!.versionNumber).toBe(1);
    expect(result!.status).toBe(SupplementAssemblyVersionStatus.DEPRECATED);
    expect(result!.deprecatedAt).toBe('2026-05-25T00:00:00.000Z');
    expect(result!.deprecationReason).toBe('แก้ไขเพื่อปรับปรุงข้อมูล');
  });

  it('getCurrentVersion: returns null when no version row exists at all (fresh supplement)', async () => {
    versionRepo.findOne.mockResolvedValueOnce(null); // step 1
    draftRepo.findOne.mockResolvedValueOnce(null); // step 2 — no draft either

    const result = await service.getCurrentVersion(SUPP_ID, USER_ID);

    expect(result).toBeNull();
  });

  it('getCurrentVersion: returns null when active draft has no previousVersionId (fresh-supplement first draft)', async () => {
    // Edge case: a fresh supplement's first createDraft does not link
    // a previousVersionId. Step 1 finds no COMPLETED, step 2 finds the
    // draft but `previousVersionId` is null → return null (NOT 404).
    versionRepo.findOne.mockResolvedValueOnce(null);
    draftRepo.findOne.mockResolvedValueOnce({
      id: 'draft-fresh',
      previousVersionId: null,
    } as any);

    const result = await service.getCurrentVersion(SUPP_ID, USER_ID);

    expect(result).toBeNull();
  });

  // --- getVersions ---------------------------------------------------

  it('getVersions: returns BOTH COMPLETED and DEPRECATED rows ordered by versionNumber DESC', async () => {
    // History list shape: v3 (COMPLETED current) → v2 (DEPRECATED) →
    // v1 (DEPRECATED). FE-01 renders this chain in the version
    // history list with the M3 audit-chain projection.
    versionRepo.find.mockResolvedValueOnce([
      {
        id: 'v3',
        developmentPlanSupplementId: SUPP_ID,
        versionNumber: 3,
        status: SupplementAssemblyVersionStatus.COMPLETED,
        createdAt: new Date('2026-05-25T00:00:00Z'),
        mergedAt: new Date('2026-05-25T00:00:00Z'),
        correctionMode: 'correction_part2',
        correctionReason: 'แก้รายชื่อโครงการ',
      },
      {
        id: 'v2',
        developmentPlanSupplementId: SUPP_ID,
        versionNumber: 2,
        status: SupplementAssemblyVersionStatus.DEPRECATED,
        createdAt: new Date('2026-05-24T00:00:00Z'),
        mergedAt: new Date('2026-05-24T00:00:00Z'),
        correctionMode: 'correction_part3',
        correctionReason: 'แก้ส่วนที่ 3',
        deprecatedAt: new Date('2026-05-25T00:00:00Z'),
        deprecationReason: 'แก้รายชื่อโครงการ',
      },
      {
        id: 'v1',
        developmentPlanSupplementId: SUPP_ID,
        versionNumber: 1,
        status: SupplementAssemblyVersionStatus.DEPRECATED,
        createdAt: new Date('2026-05-23T00:00:00Z'),
        mergedAt: new Date('2026-05-23T00:00:00Z'),
        deprecatedAt: new Date('2026-05-24T00:00:00Z'),
        deprecationReason: 'แก้ส่วนที่ 3',
      },
    ] as any);

    const result = await service.getVersions(SUPP_ID, USER_ID);

    expect(result).toHaveLength(3);
    expect(result[0].versionNumber).toBe(3);
    expect(result[0].status).toBe(SupplementAssemblyVersionStatus.COMPLETED);
    expect(result[1].versionNumber).toBe(2);
    expect(result[1].status).toBe(SupplementAssemblyVersionStatus.DEPRECATED);
    expect(result[2].versionNumber).toBe(1);
    expect(result[2].status).toBe(SupplementAssemblyVersionStatus.DEPRECATED);

    // versionNumber DESC order assertion (delegated to the typeorm
    // find() args — we assert the call carries the right `order` clause
    // so a future refactor doesn't accidentally re-sort).
    expect(versionRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        order: { versionNumber: 'DESC' },
        relations: expect.arrayContaining([
          'createdBy',
          'createdBy.user',
          'deprecatedBy',
          'deprecatedBy.user',
        ]),
      }),
    );
  });

  // --- toVersionDto projection -------------------------------------

  it('toVersionDto: exposes correctionMode / correctionReason / deprecation fields for FE-01 history list', async () => {
    // Crafted as a DEPRECATED row with a full audit chain — every M3
    // projection field must round-trip into the DTO so FE-01 can
    // render the "v2 (ยกเลิกแล้ว) — by อนุชา; เหตุผล X" card.
    versionRepo.findOne.mockResolvedValueOnce({
      id: 'v1',
      developmentPlanSupplementId: SUPP_ID,
      versionNumber: 1,
      status: SupplementAssemblyVersionStatus.DEPRECATED,
      mergedFilePath: '/x',
      mergedFileSha256: 'abc',
      mergedAt: new Date('2026-05-23T00:00:00Z'),
      createdAt: new Date('2026-05-23T00:00:00Z'),
      createdById: 'wh-creator',
      metadataJson: null,
      part3ProjectCount: 5,
      part3ProjectSnapshot: ['A', 'B', 'C', 'D', 'E'],
      totalPages: 42,
      correctionMode: 'correction_part3',
      correctionReason: 'แก้ส่วนที่ 3',
      deprecatedAt: new Date('2026-05-25T00:00:00Z'),
      deprecatedById: 'wh-deprecator',
      deprecationReason: 'แก้รายชื่อโครงการ',
      deprecatedBy: {
        id: 'wh-deprecator',
        user: {
          prefix: 'นาย',
          firstname: 'อนุชา',
          lastname: 'ทดสอบ',
        },
      },
    } as any);

    const result = await service.getVersionByNumber(SUPP_ID, USER_ID, 1);

    expect(result.versionNumber).toBe(1);
    expect(result.status).toBe(SupplementAssemblyVersionStatus.DEPRECATED);
    expect(result.correctionMode).toBe('correction_part3');
    expect(result.correctionReason).toBe('แก้ส่วนที่ 3');
    expect(result.deprecatedAt).toBe('2026-05-25T00:00:00.000Z');
    expect(result.deprecatedById).toBe('wh-deprecator');
    expect(result.deprecationReason).toBe('แก้รายชื่อโครงการ');
    expect(result.deprecatedBy).toEqual({
      id: 'wh-deprecator',
      user: {
        prefix: 'นาย',
        firstName: 'อนุชา',
        lastName: 'ทดสอบ',
      },
    });
  });

  it('toVersionDto: backfills nulls for legacy COMPLETED rows without correction/deprecation columns', async () => {
    // A pre-correction-wave version row carries NULL on every new
    // M3 column. The DTO must serialise these as JSON `null` so the
    // FE conditional-render paths stay simple.
    versionRepo.findOne.mockResolvedValueOnce({
      id: 'v1-legacy',
      developmentPlanSupplementId: SUPP_ID,
      versionNumber: 1,
      status: SupplementAssemblyVersionStatus.COMPLETED,
      mergedFilePath: '/x',
      mergedFileSha256: 'abc',
      mergedAt: new Date('2026-01-01T00:00:00Z'),
      createdAt: new Date('2026-01-01T00:00:00Z'),
      createdById: 'wh-creator',
      metadataJson: null,
      part3ProjectCount: null,
      part3ProjectSnapshot: null,
      totalPages: null,
      correctionMode: null,
      correctionReason: null,
      deprecatedAt: null,
      deprecatedById: null,
      deprecationReason: null,
      deprecatedBy: null,
    } as any);

    const result = await service.getVersionByNumber(SUPP_ID, USER_ID, 1);

    expect(result.correctionMode).toBeNull();
    expect(result.correctionReason).toBeNull();
    expect(result.deprecatedAt).toBeNull();
    expect(result.deprecatedById).toBeNull();
    expect(result.deprecationReason).toBeNull();
    expect(result.deprecatedBy).toBeNull();
  });
});

// -------------------------------------------------------------------
// Lineage helpers — populateLineageForSupplementMerge /
// restoreLineageAfterSupplementCancel
// wave-supplement-convergence-milestone-4-lineage / BE-01
// -------------------------------------------------------------------
//
// Scope: directly exercise the two new lineage helpers via reflective
// access on the service instance (private methods, intentionally
// scoped — we avoid re-running the full merge / cancel transactions
// here and reuse the focused test pattern established by the M3 specs
// above).
//
// Fake EntityManager: each test constructs a tiny in-memory lineage
// store keyed by row id. The store starts pre-seeded with whatever the
// scenario needs (e.g. a v1 leaf row for the v2 merge test) and the
// fake manager routes findOne / find / save / create / update calls
// for `SupplementProjectLineage` against that store. No real DB.
//
// Coverage matrix:
//   (1) merge v1 → creates 2 leaf rows with parent=null
//   (2) merge v2 (after correction) → demotes v1 rows + creates v2
//       leaf rows with parent=v1.id
//   (3) cancel v2 → demotes v2 rows + restores v1 rows to leaf=true
//   (4) re-curation drops an SPG in v2 → v1 leaf row for that SPG is
//       untouched (proves population is scoped to the approved set)

describe('SupplementAssemblyService lineage helpers (M4 / BE-01)', () => {
  let service: SupplementAssemblyService;
  let workHistoryRepo: jest.Mocked<Repository<WorkHistory>>;

  const SUPP_ID = 'supp-uuid-lineage';

  // In-memory lineage store + fake manager builder. Each test gets a
  // fresh store via `freshStore()` so cross-test pollution is impossible.
  type LineageRow = {
    id: string;
    supplementProjectGroupId: string;
    supplementAssemblyVersionId: string;
    parentSupplementAssemblyVersionId: string | null;
    isCurrentLeaf: boolean;
  };

  let store: Map<string, LineageRow>;
  let nextRowId: number;

  function freshStore() {
    store = new Map();
    nextRowId = 1;
  }

  function seedRow(row: Omit<LineageRow, 'id'>): LineageRow {
    const id = `row-${nextRowId++}`;
    const full = { id, ...row };
    store.set(id, full);
    return full;
  }

  function fakeManager() {
    const lineageRepo = {
      findOne: jest.fn(async (opts: any) => {
        const where = opts?.where ?? {};
        for (const row of store.values()) {
          const spgOk =
            where.supplementProjectGroupId === undefined ||
            row.supplementProjectGroupId === where.supplementProjectGroupId;
          const verOk =
            where.supplementAssemblyVersionId === undefined ||
            row.supplementAssemblyVersionId ===
              where.supplementAssemblyVersionId;
          const leafOk =
            where.isCurrentLeaf === undefined ||
            row.isCurrentLeaf === where.isCurrentLeaf;
          if (spgOk && verOk && leafOk) return row;
        }
        return null;
      }),
      find: jest.fn(async (opts: any) => {
        const where = opts?.where ?? {};
        const out: LineageRow[] = [];
        for (const row of store.values()) {
          const spgOk =
            where.supplementProjectGroupId === undefined ||
            row.supplementProjectGroupId === where.supplementProjectGroupId;
          const verOk =
            where.supplementAssemblyVersionId === undefined ||
            row.supplementAssemblyVersionId ===
              where.supplementAssemblyVersionId;
          const leafOk =
            where.isCurrentLeaf === undefined ||
            row.isCurrentLeaf === where.isCurrentLeaf;
          if (spgOk && verOk && leafOk) out.push(row);
        }
        return out;
      }),
      create: jest.fn((data: Partial<LineageRow>) => ({
        ...data,
      })) as jest.Mock,
      save: jest.fn(async (row: LineageRow) => {
        if (!row.id) {
          row.id = `row-${nextRowId++}`;
        }
        store.set(row.id, row);
        return row;
      }),
    };
    return {
      getRepository: jest.fn((entity: any) => {
        if (entity === SupplementProjectLineage) return lineageRepo;
        // Defensive: any other repo lookup in the lineage-helper paths
        // would indicate an unintended dependency.
        return {
          findOne: jest.fn().mockResolvedValue(null),
          find: jest.fn().mockResolvedValue([]),
          save: jest.fn(),
          create: jest.fn(),
          update: jest.fn(),
        };
      }),
    } as unknown as any;
  }

  beforeEach(async () => {
    freshStore();
    workHistoryRepo = createMockRepository<WorkHistory>();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SupplementAssemblyService,
        {
          provide: getRepositoryToken(SupplementAssemblyDraft),
          useValue: createMockRepository<SupplementAssemblyDraft>(),
        },
        {
          provide: getRepositoryToken(SupplementAssemblyVersion),
          useValue: createMockRepository<SupplementAssemblyVersion>(),
        },
        {
          provide: getRepositoryToken(SupplementAssemblyVersionProject),
          useValue: createMockRepository<SupplementAssemblyVersionProject>(),
        },
        {
          provide: getRepositoryToken(DevelopmentPlanSupplement),
          useValue: createMockRepository<DevelopmentPlanSupplement>(),
        },
        {
          provide: getRepositoryToken(SupplementProjectGroup),
          useValue: createMockRepository<SupplementProjectGroup>(),
        },
        {
          provide: getRepositoryToken(WorkHistory),
          useValue: workHistoryRepo,
        },
        {
          provide: getRepositoryToken(User),
          useValue: createMockRepository<User>(),
        },
        { provide: SupplementAssemblyFileService, useValue: {} },
        { provide: SupplementPdfService, useValue: {} },
        { provide: BookLockService, useValue: {} },
        { provide: OrphanCleanupService, useValue: {} },
        { provide: UsersService, useValue: { findOne: jest.fn() } },
        { provide: DataSource, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(SupplementAssemblyService);
  });

  // --- scenario (1) -------------------------------------------------
  it('populate: v1 merge creates one leaf row per approved SPG with parent=null', async () => {
    const manager = fakeManager();
    const populate = (service as any).populateLineageForSupplementMerge.bind(
      service,
    );

    const V1 = 'version-v1';
    const SPG_A = 'spg-a';
    const SPG_B = 'spg-b';

    await populate(V1, [SPG_A, SPG_B], manager);

    const rows = Array.from(store.values());
    expect(rows).toHaveLength(2);

    const rowA = rows.find((r) => r.supplementProjectGroupId === SPG_A)!;
    const rowB = rows.find((r) => r.supplementProjectGroupId === SPG_B)!;

    expect(rowA.supplementAssemblyVersionId).toBe(V1);
    expect(rowA.parentSupplementAssemblyVersionId).toBeNull();
    expect(rowA.isCurrentLeaf).toBe(true);

    expect(rowB.supplementAssemblyVersionId).toBe(V1);
    expect(rowB.parentSupplementAssemblyVersionId).toBeNull();
    expect(rowB.isCurrentLeaf).toBe(true);
  });

  // --- scenario (2) -------------------------------------------------
  it('populate: v2 merge after correction demotes v1 rows and creates v2 rows with parent=v1', async () => {
    const V1 = 'version-v1';
    const V2 = 'version-v2';
    const SPG_A = 'spg-a';
    const SPG_B = 'spg-b';

    // Pre-seed v1 leaf rows (as if v1 was previously merged).
    const v1RowA = seedRow({
      supplementProjectGroupId: SPG_A,
      supplementAssemblyVersionId: V1,
      parentSupplementAssemblyVersionId: null,
      isCurrentLeaf: true,
    });
    const v1RowB = seedRow({
      supplementProjectGroupId: SPG_B,
      supplementAssemblyVersionId: V1,
      parentSupplementAssemblyVersionId: null,
      isCurrentLeaf: true,
    });

    const manager = fakeManager();
    const populate = (service as any).populateLineageForSupplementMerge.bind(
      service,
    );

    await populate(V2, [SPG_A, SPG_B], manager);

    // v1 rows must be demoted (is_current_leaf=false).
    expect(store.get(v1RowA.id)!.isCurrentLeaf).toBe(false);
    expect(store.get(v1RowB.id)!.isCurrentLeaf).toBe(false);

    // Exactly two v2 leaf rows must exist, parent=v1.
    const v2Rows = Array.from(store.values()).filter(
      (r) => r.supplementAssemblyVersionId === V2,
    );
    expect(v2Rows).toHaveLength(2);
    for (const r of v2Rows) {
      expect(r.isCurrentLeaf).toBe(true);
      expect(r.parentSupplementAssemblyVersionId).toBe(V1);
    }

    // Per-SPG leaf-uniqueness invariant — exactly ONE leaf per SPG.
    for (const spgId of [SPG_A, SPG_B]) {
      const leafRowsForSpg = Array.from(store.values()).filter(
        (r) => r.supplementProjectGroupId === spgId && r.isCurrentLeaf,
      );
      expect(leafRowsForSpg).toHaveLength(1);
      expect(leafRowsForSpg[0].supplementAssemblyVersionId).toBe(V2);
    }
  });

  // --- scenario (3) -------------------------------------------------
  it('restore: cancel v2 demotes v2 rows and promotes v1 rows back to leaf=true', async () => {
    const V1 = 'version-v1';
    const V2 = 'version-v2';
    const SPG_A = 'spg-a';
    const SPG_B = 'spg-b';

    // Steady state AFTER v2 merge: v1 demoted, v2 is the leaf.
    const v1RowA = seedRow({
      supplementProjectGroupId: SPG_A,
      supplementAssemblyVersionId: V1,
      parentSupplementAssemblyVersionId: null,
      isCurrentLeaf: false,
    });
    const v1RowB = seedRow({
      supplementProjectGroupId: SPG_B,
      supplementAssemblyVersionId: V1,
      parentSupplementAssemblyVersionId: null,
      isCurrentLeaf: false,
    });
    const v2RowA = seedRow({
      supplementProjectGroupId: SPG_A,
      supplementAssemblyVersionId: V2,
      parentSupplementAssemblyVersionId: V1,
      isCurrentLeaf: true,
    });
    const v2RowB = seedRow({
      supplementProjectGroupId: SPG_B,
      supplementAssemblyVersionId: V2,
      parentSupplementAssemblyVersionId: V1,
      isCurrentLeaf: true,
    });

    const manager = fakeManager();
    const restore = (service as any).restoreLineageAfterSupplementCancel.bind(
      service,
    );

    await restore(V2, manager);

    // v2 rows demoted.
    expect(store.get(v2RowA.id)!.isCurrentLeaf).toBe(false);
    expect(store.get(v2RowB.id)!.isCurrentLeaf).toBe(false);

    // v1 rows restored to leaf.
    expect(store.get(v1RowA.id)!.isCurrentLeaf).toBe(true);
    expect(store.get(v1RowB.id)!.isCurrentLeaf).toBe(true);

    // Per-SPG leaf-uniqueness invariant — exactly ONE leaf per SPG.
    for (const spgId of [SPG_A, SPG_B]) {
      const leafRowsForSpg = Array.from(store.values()).filter(
        (r) => r.supplementProjectGroupId === spgId && r.isCurrentLeaf,
      );
      expect(leafRowsForSpg).toHaveLength(1);
      expect(leafRowsForSpg[0].supplementAssemblyVersionId).toBe(V1);
    }
  });

  // --- scenario (4) -------------------------------------------------
  it('populate: SPG dropped from v2 re-curation leaves its v1 leaf row untouched', async () => {
    const V1 = 'version-v1';
    const V2 = 'version-v2';
    const SPG_A = 'spg-a';
    const SPG_B = 'spg-b'; // present in v1, DROPPED from v2

    // Pre-seed v1 leaf rows for BOTH SPGs.
    const v1RowA = seedRow({
      supplementProjectGroupId: SPG_A,
      supplementAssemblyVersionId: V1,
      parentSupplementAssemblyVersionId: null,
      isCurrentLeaf: true,
    });
    const v1RowB = seedRow({
      supplementProjectGroupId: SPG_B,
      supplementAssemblyVersionId: V1,
      parentSupplementAssemblyVersionId: null,
      isCurrentLeaf: true,
    });

    const manager = fakeManager();
    const populate = (service as any).populateLineageForSupplementMerge.bind(
      service,
    );

    // v2 re-curation: SPG_A stays, SPG_B is dropped.
    await populate(V2, [SPG_A], manager);

    // SPG_A: v1 demoted, v2 promoted.
    expect(store.get(v1RowA.id)!.isCurrentLeaf).toBe(false);

    // SPG_B: v1 leaf row UNTOUCHED — populate only walks the supplied
    // approved set. This is the invariant that lets a dropped SPG stay
    // anchored to its last successful publication.
    expect(store.get(v1RowB.id)!.isCurrentLeaf).toBe(true);
    expect(store.get(v1RowB.id)!.supplementAssemblyVersionId).toBe(V1);

    // Exactly one v2 row for SPG_A.
    const v2Rows = Array.from(store.values()).filter(
      (r) => r.supplementAssemblyVersionId === V2,
    );
    expect(v2Rows).toHaveLength(1);
    expect(v2Rows[0].supplementProjectGroupId).toBe(SPG_A);
    expect(v2Rows[0].parentSupplementAssemblyVersionId).toBe(V1);
    expect(v2Rows[0].isCurrentLeaf).toBe(true);
  });
});
