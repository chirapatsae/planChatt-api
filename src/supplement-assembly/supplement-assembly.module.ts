// ===================================================================
// SupplementAssemblyModule — SUPP_STANDALONE_BE_04
// ===================================================================
//
// Wires the standalone Supplement Assembly subsystem (Wave 3 of 6).
// Mirrors BookAssemblyModule shape but uses dedicated supplement
// entities + service + controller. Q10=B standalone constraint:
// this module MUST NOT import from `src/book-assembly/`.
//
// TEMPLATE.md §8.1 — root-DataSource entity registration for the 3
// own entities is performed in `backend/src/app.module.ts` (already
// shipped by SUPP_STANDALONE_DB_01); per-feature registration via
// `TypeOrmModule.forFeature([...])` here is REQUIRED for repository
// injection tokens to resolve.
//
// Imported services (verified against
// `supplement-assembly.service.ts` constructor):
//   - PdfModule           → SupplementPdfService
//   - BookLockModule      → BookLockService (§15)
//   - OrphanCleanupModule → OrphanCleanupService (§18.2.1)
//   - UsersModule         → consistent with BookAssemblyModule
//   - WebsocketModule     → consistent with BookAssemblyModule
// ===================================================================

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SupplementAssemblyController } from './supplement-assembly.controller';
import { SupplementAssemblyService } from './supplement-assembly.service';
import { SupplementAssemblyFileService } from './supplement-assembly-file.service';

// Own entities (3) — TEMPLATE.md §8.1.
import { SupplementAssemblyDraft } from './entities/supplement-assembly-draft.entity';
import { SupplementAssemblyVersion } from './entities/supplement-assembly-version.entity';
import { SupplementAssemblyVersionProject } from './entities/supplement-assembly-version-project.entity';

// Dependency entities — repositories injected by SupplementAssemblyService.
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { User } from 'src/users/entities/user.entity';

// External modules consumed by SupplementAssemblyService.
import { PdfModule } from 'src/pdf/pdf.module';
import { UsersModule } from 'src/users/users.module';
import { WebsocketModule } from 'src/websocket/websocket.module';
import { BookLockModule } from 'src/common/book-lock/book-lock.module';
import { OrphanCleanupModule } from 'src/orphan-cleanup/orphan-cleanup.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      // Own entities (3)
      SupplementAssemblyDraft,
      SupplementAssemblyVersion,
      SupplementAssemblyVersionProject,
      // Dependency entities (read by BE_02 service via @InjectRepository)
      DevelopmentPlanSupplement,
      SupplementProjectGroup,
      WorkHistory,
      User,
    ]),
    PdfModule,
    UsersModule,
    WebsocketModule,
    BookLockModule,
    // SUPP_STANDALONE_BE_04 — merge() is the §18.2.1 SUPPLEMENT
    // finalize trigger surface; cascade fires INSIDE the same
    // transaction, BEFORE `DevelopmentPlanSupplement.isBooked = true`.
    OrphanCleanupModule,
  ],
  controllers: [SupplementAssemblyController],
  providers: [SupplementAssemblyService, SupplementAssemblyFileService],
  exports: [SupplementAssemblyService],
})
export class SupplementAssemblyModule {}
