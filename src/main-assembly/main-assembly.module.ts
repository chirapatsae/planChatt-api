// ===================================================================
// MainAssemblyModule — Wave A1 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// Wires the standalone MAIN_PLAN Assembly subsystem (Wave A1 of 3 in
// OPTION-A-FULL-SPLIT). Mirrors `SupplementAssemblyModule` shape but
// owns the four `main_assembly_*` / `main_project_lineage` entities.
//
// Q3=B (OPTION-A-FULL-SPLIT) standalone constraint:
//   - The MAIN service / controller MUST NOT import from
//     `src/book-assembly/*` for business logic. The lone exemption is
//     the file-system layer (`BookAssemblyFileService`, see service
//     header note) which is shared infrastructure.
//
// TEMPLATE.md §8.1 — root-DataSource entity registration for the four
// own entities is performed in `backend/src/app.module.ts` alongside
// the `SUPP_STANDALONE_DB_01` analog. Per-feature registration via
// `TypeOrmModule.forFeature([...])` here is REQUIRED for repository
// injection tokens to resolve.
//
// Co-existence note:
//   - The legacy `BookAssemblyModule` continues to wire its own
//     MAIN_PLAN traffic until FE-01 atomically switches the FE to the
//     `main-assembly` endpoints. Both modules can be active
//     simultaneously without conflict — they write to separate
//     tables, and the FE only routes to one at a time.
//
// CLAUDE.md compliance:
//   - §15 — `BookLockModule` provides the canonical lock predicate
//     consumed by `MainAssemblyService.assertMainBookNotFrozen`.
//   - §18.2.1 — `OrphanCleanupModule` provides the cascade service
//     invoked by `MainAssemblyService.merge` BEFORE the
//     `DevelopmentPlan.isBooked = true` flip. This module is the
//     NEW main-plan finalize trigger surface registered alongside the
//     legacy `BookAssemblyService.merge`.
// ===================================================================

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MainAssemblyService } from './main-assembly.service';
import { MainAssemblyController } from './main-assembly.controller';

// Own entities — Wave A1 / DB-01.
import { MainAssemblyDraft } from './entities/main-assembly-draft.entity';
import { MainAssemblyVersion } from './entities/main-assembly-version.entity';
import { MainAssemblyVersionProject } from './entities/main-assembly-version-project.entity';
import { MainProjectLineage } from './entities/main-project-lineage.entity';

// Dependency entities — repositories injected by MainAssemblyService.
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { PlanPhase } from 'src/plan-phase/entities/plan-phase.entity';
import { User } from 'src/users/entities/user.entity';
// §21.2 both-sources merge gate — equipment is the agency-side
// alternate contributor (interchangeable with agency-origin PG).
import { EquipmentProjectGroup } from 'src/equipment-project-group/entities/equipment-project-group.entity';

// External modules consumed by MainAssemblyService.
import { UsersModule } from 'src/users/users.module';
import { PdfModule } from 'src/pdf/pdf.module';
import { WebsocketModule } from 'src/websocket/websocket.module';
import { BookLockModule } from 'src/common/book-lock/book-lock.module';
// §14.11 correction-time descendant guard — MAIN correct(CORRECTION_PART3)
// un-books PGs that may have live RPG/SPG forks (prev_project_type='original').
import { LineageLockModule } from 'src/common/lineage-lock/lineage-lock.module';
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
      MainAssemblyDraft,
      MainAssemblyVersion,
      MainAssemblyVersionProject,
      MainProjectLineage,
      // Dependency entities consumed via @InjectRepository.
      WorkHistory,
      ProjectGroup,
      DevelopmentPlan,
      PlanPhase,
      User,
      // §21.2 — equipment Approved count contributes to the agency-side floor.
      EquipmentProjectGroup,
    ]),
    UsersModule,
    PdfModule,
    WebsocketModule,
    BookLockModule,
    LineageLockModule,
    // Wave A1 / BE-01 — merge() is the NEW MAIN_PLAN finalize trigger
    // surface; cascade fires INSIDE the same transaction, BEFORE
    // `DevelopmentPlan.isBooked = true`. CLAUDE.md §18.2.1.
    OrphanCleanupModule,
    BookAssemblyModule,
  ],
  controllers: [MainAssemblyController],
  providers: [MainAssemblyService],
  exports: [MainAssemblyService],
})
export class MainAssemblyModule {}
