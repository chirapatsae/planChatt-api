// W72 spec env-bypass: `src/util/encryption.util` validates SALT/SECRET_KEY/
// ALGORITHM at MODULE LOAD time. Jest sets NODE_ENV='test' by default, but the
// repo ships only `.env.development` / `.env.production`, so the loader throws
// during the transitive import chain `DevelopmentPlanService` → `UsersService`
// → `encryption.util`. This spec does not exercise any encryption path, so we
// stub the module surface here BEFORE the imports below resolve.
jest.mock('src/util/encryption.util', () => ({
  encryption: jest.fn(async (v: string) => v),
  decryption: jest.fn(async (v: string) => v),
  hashPii: jest.fn((v: string) => v),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { DevelopmentPlanService } from './development-plan.service';
import { DevelopmentPlan } from './entities/development-plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { PlanPhase } from 'src/plan-phase/entities/plan-phase.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { PdfService } from 'src/pdf/pdf.service';
import { ProjectGroupsService } from 'src/project-groups/project-groups.service';
import { WebsocketService } from 'src/websocket/websocket/websocket.service';
import { UsersService } from 'src/users/users.service';
import {
  BookLockService,
  BOOK_HAS_NEWER_REVISION,
} from 'src/common/book-lock/book-lock.service';
import { DevelopmentPlanRevisionService } from 'src/development-plan-revision/development-plan-revision.service';
import { RevisionType } from 'src/revision-type/entities/revision-type.entity';

/**
 * W72-BE-RELAX-LATEST-STATUS — verifies CLAUDE.md §15.5 carve-out for
 * `DevelopmentPlanService.updateLatestStatus`.
 *
 * The flag toggle MUST succeed even when the plan has non-soft-deleted
 * revision or supplement children. All other §15.4 blocked operations
 * (`update`, `remove`, `softRemove`, `restore`) MUST continue to throw
 * `BOOK_HAS_NEWER_REVISION` — the relaxation is operation-scoped.
 */
describe('DevelopmentPlanService — W72 §15.5 carve-out for updateLatestStatus', () => {
  let service: DevelopmentPlanService;
  let bookLockService: { assertEditable: jest.Mock; assertDeletable: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let managerPlanRepo: {
    findOne: jest.Mock;
    update: jest.Mock;
    save: jest.Mock;
  };
  let topLevelPlanRepo: {
    findOne: jest.Mock;
    findOneBy: jest.Mock;
    find: jest.Mock;
    delete: jest.Mock;
    restore: jest.Mock;
    save: jest.Mock;
    softRemove: jest.Mock;
    merge: jest.Mock;
    manager: unknown;
  };

  beforeEach(async () => {
    managerPlanRepo = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn().mockImplementation(async (entity) => entity),
    };

    const fakeManager = {
      getRepository: jest.fn().mockImplementation((entity: unknown) => {
        if (entity === DevelopmentPlan) return managerPlanRepo;
        return {};
      }),
    } as unknown as EntityManager;

    dataSource = {
      transaction: jest
        .fn()
        .mockImplementation(async (cb: (m: EntityManager) => unknown) =>
          cb(fakeManager),
        ),
    };

    topLevelPlanRepo = {
      findOne: jest.fn(),
      findOneBy: jest.fn(),
      find: jest.fn(),
      delete: jest.fn(),
      restore: jest.fn(),
      save: jest.fn(),
      softRemove: jest.fn(),
      merge: jest.fn(),
      manager: { __topLevel: true },
    };

    bookLockService = {
      assertEditable: jest.fn().mockResolvedValue(undefined),
      assertDeletable: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DevelopmentPlanService,
        { provide: getRepositoryToken(DevelopmentPlan), useValue: topLevelPlanRepo },
        { provide: getRepositoryToken(WorkHistory), useValue: {} },
        { provide: getRepositoryToken(PlanPhase), useValue: {} },
        { provide: getRepositoryToken(ProjectGroup), useValue: {} },
        { provide: getRepositoryToken(RevisedProjectGroup), useValue: {} },
        { provide: getRepositoryToken(DevelopmentPlanRevision), useValue: {} },
        { provide: getRepositoryToken(DevelopmentPlanSupplement), useValue: {} },
        { provide: DataSource, useValue: dataSource },
        { provide: PdfService, useValue: {} },
        { provide: ProjectGroupsService, useValue: {} },
        { provide: WebsocketService, useValue: {} },
        { provide: UsersService, useValue: { findOne: jest.fn() } },
        { provide: BookLockService, useValue: bookLockService },
      ],
    }).compile();

    service = module.get<DevelopmentPlanService>(DevelopmentPlanService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------
  // Positive path — relaxation
  // -----------------------------------------------------------------
  describe('updateLatestStatus (relaxed under §15.5)', () => {
    it('promotes an older plan with non-soft-deleted REVISION children to latest, flips previously-latest to false (no §15 lock thrown)', async () => {
      // Even if BookLockService WERE called, simulate a §15-locked plan.
      // The relaxation means the call is never made — assertEditable
      // must NOT have been invoked.
      bookLockService.assertEditable.mockRejectedValue(
        new ConflictException(
          `${BOOK_HAS_NEWER_REVISION}: locked by revision child`,
        ),
      );

      const plan: Partial<DevelopmentPlan> = {
        id: 'plan-old',
        isLatest: false,
      };
      managerPlanRepo.findOne.mockResolvedValue(plan);

      const result = await service.updateLatestStatus('plan-old', {
        isLatest: true,
      });

      // §15 guard MUST NOT be called from updateLatestStatus
      expect(bookLockService.assertEditable).not.toHaveBeenCalled();
      expect(bookLockService.assertDeletable).not.toHaveBeenCalled();

      // Previously-latest plan flipped to false (bulk update before save)
      expect(managerPlanRepo.update).toHaveBeenCalledWith(
        { isLatest: true },
        { isLatest: false },
      );

      // Target plan saved with isLatest=true
      expect(managerPlanRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'plan-old', isLatest: true }),
      );

      expect(result).toEqual(
        expect.objectContaining({ id: 'plan-old', isLatest: true }),
      );

      // Whole thing ran inside a transaction (preserved behavior)
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('promotes an older plan with non-soft-deleted SUPPLEMENT children to latest (mirror branch — same relaxation)', async () => {
      bookLockService.assertEditable.mockRejectedValue(
        new ConflictException(
          `${BOOK_HAS_NEWER_REVISION}: locked by supplement child`,
        ),
      );

      const plan: Partial<DevelopmentPlan> = {
        id: 'plan-old-supp',
        isLatest: false,
      };
      managerPlanRepo.findOne.mockResolvedValue(plan);

      const result = await service.updateLatestStatus('plan-old-supp', {
        isLatest: true,
      });

      expect(bookLockService.assertEditable).not.toHaveBeenCalled();
      expect(managerPlanRepo.update).toHaveBeenCalledWith(
        { isLatest: true },
        { isLatest: false },
      );
      expect(result).toEqual(
        expect.objectContaining({ id: 'plan-old-supp', isLatest: true }),
      );
    });

    it('does NOT bulk-flip other plans when isLatest=false (only target row is updated)', async () => {
      const plan: Partial<DevelopmentPlan> = {
        id: 'plan-x',
        isLatest: true,
      };
      managerPlanRepo.findOne.mockResolvedValue(plan);

      await service.updateLatestStatus('plan-x', { isLatest: false });

      // No bulk pre-flip when demoting (preserved existing behavior)
      expect(managerPlanRepo.update).not.toHaveBeenCalled();
      expect(managerPlanRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'plan-x', isLatest: false }),
      );
      expect(bookLockService.assertEditable).not.toHaveBeenCalled();
    });

    it('throws NotFoundException unchanged when plan does not exist (handleException re-throws HttpException as-is)', async () => {
      managerPlanRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateLatestStatus('does-not-exist', { isLatest: true }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(bookLockService.assertEditable).not.toHaveBeenCalled();
      expect(managerPlanRepo.save).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------
  // Regression guards — §15.4 still blocks the rest
  // -----------------------------------------------------------------
  describe('§15.4 regression guards — relaxation is narrow', () => {
    it('update on a §15-locked plan STILL throws BOOK_HAS_NEWER_REVISION', async () => {
      const plan: Partial<DevelopmentPlan> = {
        id: 'locked-plan',
        isLatest: true,
        startYear: 2566,
        endYear: 2570,
      };
      topLevelPlanRepo.findOneBy.mockResolvedValue(plan);

      bookLockService.assertEditable.mockRejectedValue(
        new ConflictException(
          `${BOOK_HAS_NEWER_REVISION}: ไม่สามารถแก้ไขเล่มนี้ได้ (CLAUDE.md §15)`,
        ),
      );

      await expect(
        service.update('locked-plan', { startYear: 2567, endYear: 2571 }),
      ).rejects.toMatchObject({
        message: expect.stringContaining(BOOK_HAS_NEWER_REVISION),
      });

      expect(bookLockService.assertEditable).toHaveBeenCalledWith(
        'locked-plan',
        'development_plan',
        topLevelPlanRepo.manager,
      );
    });

    it('remove on a §15-locked plan STILL throws BOOK_HAS_NEWER_REVISION', async () => {
      bookLockService.assertDeletable.mockRejectedValue(
        new ConflictException(
          `${BOOK_HAS_NEWER_REVISION}: ไม่สามารถลบเล่มนี้ได้ (CLAUDE.md §15)`,
        ),
      );

      await expect(service.remove('locked-plan')).rejects.toMatchObject({
        message: expect.stringContaining(BOOK_HAS_NEWER_REVISION),
      });

      expect(bookLockService.assertDeletable).toHaveBeenCalledWith(
        'locked-plan',
        'development_plan',
        topLevelPlanRepo.manager,
      );
      expect(topLevelPlanRepo.delete).not.toHaveBeenCalled();
    });

    it('restore on a §15-locked plan STILL throws BOOK_HAS_NEWER_REVISION', async () => {
      bookLockService.assertEditable.mockRejectedValue(
        new ConflictException(
          `${BOOK_HAS_NEWER_REVISION}: ไม่สามารถแก้ไขเล่มนี้ได้ (CLAUDE.md §15)`,
        ),
      );

      await expect(service.restore('locked-plan')).rejects.toMatchObject({
        message: expect.stringContaining(BOOK_HAS_NEWER_REVISION),
      });

      expect(bookLockService.assertEditable).toHaveBeenCalledWith(
        'locked-plan',
        'development_plan',
        topLevelPlanRepo.manager,
      );
      expect(topLevelPlanRepo.restore).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------
// Cross-table regression — DevelopmentPlanRevisionService.update still
// honors §15. Proves the W72 relaxation did not leak across services.
// ---------------------------------------------------------------------

describe('DevelopmentPlanRevisionService.update — §15 cross-table regression guard (W72)', () => {
  let service: DevelopmentPlanRevisionService;
  let bookLockService: { assertEditable: jest.Mock; assertDeletable: jest.Mock };
  let revisionRepo: {
    findOne: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    manager: unknown;
  };

  beforeEach(async () => {
    revisionRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'rev-locked',
        developmentPlan: { id: 'plan-x' },
        revisionType: { id: 'rt-1' },
        isOpen: false,
        isLatest: false,
        startDate: null,
        endDate: null,
      }),
      save: jest.fn(),
      update: jest.fn(),
      manager: { __topLevel: 'rev' },
    };

    bookLockService = {
      assertEditable: jest.fn().mockRejectedValue(
        new ConflictException(
          `${BOOK_HAS_NEWER_REVISION}: ไม่สามารถแก้ไขเล่มนี้ได้ (CLAUDE.md §15)`,
        ),
      ),
      assertDeletable: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DevelopmentPlanRevisionService,
        { provide: getRepositoryToken(DevelopmentPlanRevision), useValue: revisionRepo },
        { provide: getRepositoryToken(DevelopmentPlan), useValue: {} },
        { provide: getRepositoryToken(RevisionType), useValue: {} },
        { provide: getRepositoryToken(WorkHistory), useValue: {} },
        { provide: getRepositoryToken(RevisedProjectGroup), useValue: {} },
        { provide: UsersService, useValue: {} },
        { provide: PdfService, useValue: {} },
        { provide: WebsocketService, useValue: {} },
        { provide: BookLockService, useValue: bookLockService },
      ],
    }).compile();

    service = module.get<DevelopmentPlanRevisionService>(
      DevelopmentPlanRevisionService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('update on a §15-locked DevelopmentPlanRevision STILL throws BOOK_HAS_NEWER_REVISION (proves W72 relaxation did not leak across services)', async () => {
    await expect(
      service.update('rev-locked', { description: 'attempt-to-edit' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(BOOK_HAS_NEWER_REVISION),
    });

    expect(bookLockService.assertEditable).toHaveBeenCalledWith(
      'rev-locked',
      'development_plan_revision',
      revisionRepo.manager,
    );
    expect(revisionRepo.save).not.toHaveBeenCalled();
  });
});
