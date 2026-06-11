// ===================================================================
// EditAssemblyModule — Wave A2 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// Wires the standalone EDIT_REVISION Assembly subsystem (Wave A2 of 3
// in OPTION-A-FULL-SPLIT). Mirrors `MainAssemblyModule` /
// `SupplementAssemblyModule` shape but owns the four `edit_assembly_*`
// / `edit_project_lineage` entities.
//
// Q3=B (OPTION-A-FULL-SPLIT) standalone constraint:
//   - The EDIT service / controller MUST NOT import from
//     `src/book-assembly/*`, `src/main-assembly/*`, or
//     `src/supplement-assembly/*` for business logic. The lone
//     exemption is the file-system layer (`BookAssemblyFileService`,
//     see service header note) which is shared infrastructure.
//
// TEMPLATE.md §8.1 — root-DataSource entity registration for the four
// own entities is performed in `backend/src/app.module.ts` alongside
// the `SUPP_STANDALONE_DB_01` and Wave A1 analogs. Per-feature
// registration via `TypeOrmModule.forFeature([...])` here is REQUIRED
// for repository injection tokens to resolve.
//
// Co-existence note:
//   - The legacy `BookAssemblyModule` continues to wire its own
//     EDIT_REVISION traffic until FE-01 atomically switches the FE to
//     the `edit-assembly` endpoints. Both modules can be active
//     simultaneously without conflict — they write to separate
//     tables, and the FE only routes to one at a time.
//
// CLAUDE.md compliance:
//   - §15 — `BookLockModule` provides the canonical lock predicate
//     consumed by `EditAssemblyService.assertEditBookNotFrozen`.
//   - §18.2.1 — `OrphanCleanupModule` provides the cascade service
//     invoked by `EditAssemblyService.merge` BEFORE the
//     `DevelopmentPlanRevision.isBooked = true` flip AND by
//     `EditAssemblyService.cancelPublishedVersion` inside the cancel
//     transaction. This module is the NEW EDIT_REVISION finalize +
//     cancel trigger surface registered alongside the legacy
//     `BookAssemblyService.merge` / `.cancel`.
// ===================================================================

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EditAssemblyService } from './edit-assembly.service';
import { EditAssemblyController } from './edit-assembly.controller';

// Own entities — Wave A2 / DB-01.
import { EditAssemblyDraft } from './entities/edit-assembly-draft.entity';
import { EditAssemblyVersion } from './entities/edit-assembly-version.entity';
import { EditAssemblyVersionProject } from './entities/edit-assembly-version-project.entity';
import { EditProjectLineage } from './entities/edit-project-lineage.entity';

// Dependency entities — repositories injected by EditAssemblyService.
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { RevisedEquipmentProjectGroup } from 'src/revised-equipment-project-group/entities/revised-equipment-project-group.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { User } from 'src/users/entities/user.entity';

// External modules consumed by EditAssemblyService.
import { UsersModule } from 'src/users/users.module';
import { PdfModule } from 'src/pdf/pdf.module';
import { WebsocketModule } from 'src/websocket/websocket.module';
import { BookLockModule } from 'src/common/book-lock/book-lock.module';
import { OrphanCleanupModule } from 'src/orphan-cleanup/orphan-cleanup.module';
// §14.11 — cancel-time descendant guard reuses the canonical
// LineageLockService. The module only registers stateless lineage
// helpers (no domain-service deps) so importing it cannot create a
// circular dependency.
import { LineageLockModule } from 'src/common/lineage-lock/lineage-lock.module';
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
      EditAssemblyDraft,
      EditAssemblyVersion,
      EditAssemblyVersionProject,
      EditProjectLineage,
      // Dependency entities consumed via @InjectRepository.
      WorkHistory,
      RevisedProjectGroup,
      RevisedEquipmentProjectGroup,
      DevelopmentPlanRevision,
      User,
    ]),
    UsersModule,
    PdfModule,
    WebsocketModule,
    BookLockModule,
    // Wave A2 / BE-01 — merge() is the NEW EDIT_REVISION finalize
    // trigger surface; cascade fires INSIDE the same transaction,
    // BEFORE `DevelopmentPlanRevision.isBooked = true`. Cancel cascade
    // fires INSIDE the cancel transaction, BEFORE the deprecate write
    // commits. CLAUDE.md §18.2.1.
    OrphanCleanupModule,
    LineageLockModule,
    BookAssemblyModule,
  ],
  controllers: [EditAssemblyController],
  providers: [EditAssemblyService],
  exports: [EditAssemblyService],
})
export class EditAssemblyModule {}
