// ===================================================================
// ChangeAssemblyModule — Wave A3 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// Wires the standalone CHANGE_REVISION Assembly subsystem (Wave A3 of 3
// in OPTION-A-FULL-SPLIT). Mirrors `EditAssemblyModule` /
// `MainAssemblyModule` / `SupplementAssemblyModule` shape but owns the
// four `change_assembly_*` / `change_project_lineage` entities.
//
// Q3=B (OPTION-A-FULL-SPLIT) standalone constraint:
//   - The CHANGE service / controller MUST NOT import from
//     `src/book-assembly/*`, `src/main-assembly/*`,
//     `src/edit-assembly/*`, or `src/supplement-assembly/*` for business
//     logic. The lone exemption is the file-system layer
//     (`BookAssemblyFileService`, see service header note) which is
//     shared infrastructure.
//
// TEMPLATE.md §8.1 — root-DataSource entity registration for the four
// own entities is performed in `backend/src/app.module.ts` alongside
// the `SUPP_STANDALONE_DB_01`, Wave A1 (MAIN), and Wave A2 (EDIT)
// analogs. Per-feature registration via
// `TypeOrmModule.forFeature([...])` here is REQUIRED for repository
// injection tokens to resolve.
//
// Co-existence note:
//   - The legacy `BookAssemblyModule` continues to wire its own
//     CHANGE_REVISION traffic until FE-01 atomically switches the FE to
//     the `change-assembly` endpoints. Both modules can be active
//     simultaneously without conflict — they write to separate
//     tables, and the FE only routes to one at a time.
//
// CLAUDE.md compliance:
//   - §15 — `BookLockModule` provides the canonical lock predicate
//     consumed by `ChangeAssemblyService.assertChangeBookNotFrozen`.
//   - §18.2.1 — `OrphanCleanupModule` provides the cascade service
//     invoked by `ChangeAssemblyService.merge` BEFORE the
//     `DevelopmentPlanRevision.isBooked = true` flip AND by
//     `ChangeAssemblyService.cancelPublishedVersion` inside the cancel
//     transaction. This module is the NEW CHANGE_REVISION finalize +
//     cancel trigger surface registered alongside the legacy
//     `BookAssemblyService.merge` / `.cancel`.
// ===================================================================

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ChangeAssemblyService } from './change-assembly.service';
import { ChangeAssemblyController } from './change-assembly.controller';

// Own entities — Wave A3 / DB-01.
import { ChangeAssemblyDraft } from './entities/change-assembly-draft.entity';
import { ChangeAssemblyVersion } from './entities/change-assembly-version.entity';
import { ChangeAssemblyVersionProject } from './entities/change-assembly-version-project.entity';
import { ChangeProjectLineage } from './entities/change-project-lineage.entity';

// Dependency entities — repositories injected by ChangeAssemblyService.
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { User } from 'src/users/entities/user.entity';

// External modules consumed by ChangeAssemblyService.
import { UsersModule } from 'src/users/users.module';
import { PdfModule } from 'src/pdf/pdf.module';
import { WebsocketModule } from 'src/websocket/websocket.module';
import { BookLockModule } from 'src/common/book-lock/book-lock.module';
import { OrphanCleanupModule } from 'src/orphan-cleanup/orphan-cleanup.module';
// Note: `StorageModule` is `@Global()` and registered in `AppModule`,
// so we don't import it here — `StoragePathService` resolves via the
// global container.
// Q3=B file-service exemption — see service header note. The legacy
// `BookAssemblyModule` exports `BookAssemblyFileService` for shared
// infrastructure use; importing the module here is acceptable because
// the file service is type-only stateless I/O with no business logic.
import { BookAssemblyModule } from 'src/book-assembly/book-assembly.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      // Own entities (4)
      ChangeAssemblyDraft,
      ChangeAssemblyVersion,
      ChangeAssemblyVersionProject,
      ChangeProjectLineage,
      // Dependency entities consumed via @InjectRepository.
      WorkHistory,
      RevisedProjectGroup,
      DevelopmentPlanRevision,
      User,
    ]),
    UsersModule,
    PdfModule,
    WebsocketModule,
    BookLockModule,
    // Wave A3 / BE-01 — merge() is the NEW CHANGE_REVISION finalize
    // trigger surface; cascade fires INSIDE the same transaction,
    // BEFORE `DevelopmentPlanRevision.isBooked = true`. Cancel cascade
    // fires INSIDE the cancel transaction, BEFORE the deprecate write
    // commits. CLAUDE.md §18.2.1.
    OrphanCleanupModule,
    BookAssemblyModule,
  ],
  controllers: [ChangeAssemblyController],
  providers: [ChangeAssemblyService],
  exports: [ChangeAssemblyService],
})
export class ChangeAssemblyModule {}
