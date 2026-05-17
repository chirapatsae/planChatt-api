import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';
import { StoragePathService } from './storage-path.service';

/**
 * StorageModule
 *
 * Hosts two orthogonal helpers:
 *
 *   1. `StorageService` (legacy, pre-Wave 2) — handles `/uploads/...`
 *      user-uploaded assets (profile images, etc.) under
 *      `{cwd}/uploads/`. UNCHANGED by Wave 2.
 *
 *   2. `StoragePathService` (Wave 2 BE-PATH-SERVICE) — the single
 *      source of truth for the new plan-rooted PDF storage hierarchy
 *      under `{STORAGE_ROOT}` (default `{cwd}/storage/`). Consumed by
 *      every PDF writer / reader / migration script. Marked `@Global`
 *      via this module so downstream feature modules
 *      (`PdfModule`, `BookAssemblyModule`, `SupplementAssemblyModule`,
 *      `DevelopmentPlanModule`, etc.) can inject it without importing
 *      `StorageModule` explicitly — registration in `AppModule` is
 *      sufficient.
 *
 * The two helpers have NO overlap: `StorageService` writes under
 * `uploads/`, `StoragePathService` writes under `storage/`. They share
 * a module purely for thematic locality.
 */
@Global()
@Module({
    providers: [StorageService, StoragePathService],
    exports: [StorageService, StoragePathService],
})
export class StorageModule { }
