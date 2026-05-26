import { Module } from '@nestjs/common';

import { BookAssemblyFileService } from './book-assembly-file.service';

/**
 * Slim shared-infrastructure module.
 *
 * After OPTION-A-FULL-SPLIT CLEANUP (2026-05-26) this module exposes
 * ONLY `BookAssemblyFileService` — the single source of truth for on-
 * disk PDF path resolution, consumed by `MainAssemblyService`,
 * `EditAssemblyService`, and `ChangeAssemblyService` per the Q3=B
 * file-service exemption documented in CLAUDE.md §20.10.3.
 * `SupplementAssemblyService` has its own `supplement-assembly-file.service.ts`
 * and does NOT consume this provider.
 *
 * The post-CLEANUP DeprecationAuditLog entity / table / 2 enums were
 * also deleted (0 live writers, 0 historical rows) as a follow-up
 * mini cleanup (2026-05-26). All legacy `book_assembly_*` tables,
 * the polymorphic `BookAssemblyService`, controller, entities, DTOs,
 * enums, and the Wave 4 storage-migration CLI have been removed.
 */
@Module({
  providers: [BookAssemblyFileService],
  exports: [BookAssemblyFileService],
})
export class BookAssemblyModule {}
