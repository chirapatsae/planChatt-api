import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BookAssemblyFileService } from './book-assembly-file.service';
import { DeprecationAuditLog } from './entities/deprecation-audit-log.entity';

/**
 * Slim shared-infrastructure module (CLEANUP wave BE-02, 2026-05-26).
 *
 * After the OPTION-A-FULL-SPLIT CLEANUP wave deleted the legacy
 * `BookAssemblyService` + `BookAssemblyController` + every legacy
 * `book_assembly_*` entity / DTO / enum, this module now exposes ONLY
 * the two shared-infrastructure pieces called out by CLAUDE.md §20.10.3
 * (Q3=B file-service exemption + audit-log entity preservation):
 *
 *   1. `BookAssemblyFileService` — single source of truth for on-disk
 *      path resolution. Imported by `MainAssemblyService`,
 *      `EditAssemblyService`, `ChangeAssemblyService`, and (transitively)
 *      `SupplementAssemblyService` via their respective module imports.
 *
 *   2. `DeprecationAuditLog` entity — registered in
 *      `TypeOrmModule.forFeature` so the supplement-side audit writer
 *      (`SupplementAssemblyService.validateSupplementDeprecationAuth`)
 *      continues to bind a repo. Future-wave parity for the four
 *      standalone services may grow audit-write coverage here.
 *
 * The module no longer declares any controller. The downstream
 * `MainAssemblyModule`, `EditAssemblyModule`, and `ChangeAssemblyModule`
 * continue to import `BookAssemblyModule` to consume the exported
 * `BookAssemblyFileService` provider — that import chain is unchanged.
 */
@Module({
  imports: [TypeOrmModule.forFeature([DeprecationAuditLog])],
  providers: [BookAssemblyFileService],
  exports: [BookAssemblyFileService],
})
export class BookAssemblyModule {}
