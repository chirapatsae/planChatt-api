import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BookAssemblySourceType } from './enums/book-assembly.enums';
import { StoragePathService } from 'src/storage/storage-path.service';

/**
 * Handles all file-system operations for the book assembly module.
 *
 * Wave 3 BE-WRITERS — Storage Layout Restructure (umbrella §1 / §7.1):
 *
 *   /storage/main-plan-{planId}/v{N}/                              ← main plan version dir
 *     parts/part-1.pdf, part-2.pdf, part-3.pdf
 *     merged/official-book-v{N}.pdf
 *     metadata.json
 *
 *   /storage/main-plan-{planId}/{edit|change}/{type}-{revisionNumber}-{revisionId}/v{N}/
 *     parts/part-{1,2,3}.pdf
 *     merged/official-book-v{N}.pdf
 *     metadata.json
 *
 * Each version is self-contained. Reused parts are **copied**, not
 * referenced by symlink. Version folders are NEVER deleted, even for
 * deprecated versions (immutability rule).
 *
 * The service now accepts a `BookAssemblyLocation` discriminated union
 * carrying the richer context (planId + revisionType + revisionNumber)
 * that the new plan-rooted hierarchy needs. The legacy `getEntityIdentifier`
 * collapsed EDIT_REVISION + CHANGE_REVISION into the same prefix
 * (`development-plan-revision-{id}`) — BE-SCAN finding M3 — and that
 * collapse is now eliminated.
 *
 * Write methods PERSIST relative keys (umbrella §7.2). Absolute paths
 * exist only at the filesystem boundary, derived via `StoragePathService
 * .resolve(...)`.
 */

/**
 * Discriminated location context for every file-service call.
 * - MAIN_PLAN: `planId` is the DevelopmentPlan UUID and also `sourceId`.
 * - EDIT_REVISION / CHANGE_REVISION: `planId` is the parent
 *   DevelopmentPlan UUID; `revisionNumber` is the ordinal within the
 *   per-type sibling timeline; `revisionId` is the DevelopmentPlanRevision
 *   UUID and also `sourceId`.
 */
export type BookAssemblyLocation =
  | { kind: 'MAIN_PLAN'; planId: string }
  | {
      kind: 'EDIT_REVISION' | 'CHANGE_REVISION';
      planId: string;
      revisionNumber: number;
      revisionId: string;
    };

@Injectable()
export class BookAssemblyFileService {
  private readonly logger = new Logger(BookAssemblyFileService.name);

  constructor(
    // Wave 3 BE-WRITERS — single source of truth for path computation
    // (umbrella §7.1). Eliminates the local `path.resolve(process.cwd(),
    // 'storage', 'book-assembly')` literal that BE-SCAN flagged
    // ("Scattered literals" — book-assembly-file.service.ts:20).
    private readonly storagePathService: StoragePathService,
  ) {}

  // ---------------------------------------------------------------------------
  // Path-safety guards (path-traversal prevention)
  // ---------------------------------------------------------------------------

  /**
   * Wave 3 BE-WRITERS — boundary check now scoped to STORAGE_ROOT
   * (umbrella §9). Previously this guarded against escape from
   * `{cwd}/storage/book-assembly`. The new layout places main-plan
   * files under `{STORAGE_ROOT}/main-plan-{planId}/...` so the legacy
   * narrow root would falsely reject valid paths. The check is widened
   * to STORAGE_ROOT, which matches `assertUserPathWithinAllowedBase`
   * (formerly the broader guard) — BE-SCAN finding H2 resolution.
   */
  assertPathWithinStorageRoot(resolvedPath: string): string {
    const root = this.storagePathService.getStorageRoot();
    const normalized = path.resolve(resolvedPath);
    if (!normalized.startsWith(root + path.sep) && normalized !== root) {
      throw new BadRequestException(
        'File reference must be within the storage root directory',
      );
    }
    return normalized;
  }

  /**
   * Validates that a user-supplied file reference resolves within the
   * STORAGE_ROOT. For use with externally supplied paths (DTO inputs).
   */
  assertUserPathWithinAllowedBase(userPath: string): string {
    const root = this.storagePathService.getStorageRoot();
    const resolved = path.isAbsolute(userPath)
      ? path.resolve(userPath)
      : path.resolve(process.cwd(), userPath);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new BadRequestException(
        'File reference must be within the allowed storage directory',
      );
    }
    return resolved;
  }

  /** partNumber must be strictly 1, 2, or 3. */
  validatePartNumber(partNumber: number): void {
    if (partNumber !== 1 && partNumber !== 2 && partNumber !== 3) {
      throw new BadRequestException('partNumber must be 1, 2, or 3');
    }
  }

  /** versionNumber must be a positive integer. */
  validateVersionNumber(version: number): void {
    if (!Number.isInteger(version) || version < 1) {
      throw new BadRequestException('versionNumber must be a positive integer');
    }
  }

  // ---------------------------------------------------------------------------
  // Location helpers — produce relative keys via StoragePathService
  // ---------------------------------------------------------------------------

  /**
   * Returns the relative version-directory KEY (no fileName) for a
   * location. Used internally to derive parts/merged/metadata keys.
   */
  getVersionDirKey(location: BookAssemblyLocation, version: number): string {
    this.validateVersionNumber(version);
    if (location.kind === 'MAIN_PLAN') {
      return this.storagePathService.mainPlanVersionDir(location.planId, version);
    }
    const revisionType = location.kind === 'EDIT_REVISION' ? 'edit' : 'change';
    return this.storagePathService.revisionVersionDir({
      planId: location.planId,
      revisionType,
      revisionNumber: location.revisionNumber,
      revisionId: location.revisionId,
      versionNumber: version,
    });
  }

  /** Relative file KEY for `parts/part-{N}.pdf` under the version dir. */
  getPartFileKey(
    location: BookAssemblyLocation,
    version: number,
    partNumber: number,
  ): string {
    this.validatePartNumber(partNumber);
    return path.posix.join(
      this.getVersionDirKey(location, version),
      'parts',
      `part-${partNumber}.pdf`,
    );
  }

  /** Relative file KEY for the merged official book PDF. */
  getMergedFileKey(location: BookAssemblyLocation, version: number): string {
    return path.posix.join(
      this.getVersionDirKey(location, version),
      'merged',
      `official-book-v${version}.pdf`,
    );
  }

  /** Relative file KEY for the per-version metadata.json sidecar. */
  getMetadataFileKey(location: BookAssemblyLocation, version: number): string {
    return path.posix.join(this.getVersionDirKey(location, version), 'metadata.json');
  }

  // ---------------------------------------------------------------------------
  // Directory operations
  // ---------------------------------------------------------------------------

  /**
   * Eagerly creates the `parts/` and `merged/` subdirectories for a new
   * version. Idempotent.
   */
  createVersionFolders(location: BookAssemblyLocation, version: number): void {
    this.validateVersionNumber(version);
    const versionDirKey = this.getVersionDirKey(location, version);
    const partsAbs = this.storagePathService.resolve(
      path.posix.join(versionDirKey, 'parts'),
    );
    const mergedAbs = this.storagePathService.resolve(
      path.posix.join(versionDirKey, 'merged'),
    );
    this.assertPathWithinStorageRoot(partsAbs);
    this.assertPathWithinStorageRoot(mergedAbs);
    fs.mkdirSync(partsAbs, { recursive: true });
    fs.mkdirSync(mergedAbs, { recursive: true });
    this.logger.log(
      `Created version folders for ${this.describeLocation(location)}/v${version}`,
    );
  }

  // ---------------------------------------------------------------------------
  // File write operations — persist RELATIVE KEYS
  // ---------------------------------------------------------------------------

  /**
   * Saves an uploaded or generated part file to the correct versioned
   * directory. Returns the RELATIVE KEY (umbrella §7.2) — callers
   * persist this value to `book_assembly_drafts.part{n}_file_path` and
   * `book_assembly_versions.part{n}_file_path`.
   */
  savePartFile(
    location: BookAssemblyLocation,
    version: number,
    partNumber: number,
    buffer: Buffer,
  ): string {
    this.validatePartNumber(partNumber);
    this.validateVersionNumber(version);
    const key = this.getPartFileKey(location, version, partNumber);
    const abs = this.storagePathService.resolve(key);
    this.assertPathWithinStorageRoot(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buffer);
    this.logger.log(`Saved part-${partNumber}.pdf -> ${key}`);
    return key;
  }

  /**
   * Copies a part file from a previous version's `/parts/` into the
   * target version's `/parts/`. Self-contained version layout — no
   * symlinks. Returns the destination's RELATIVE KEY.
   */
  copyPartFromVersion(
    location: BookAssemblyLocation,
    fromVersion: number,
    toVersion: number,
    partNumber: number,
  ): string {
    this.validatePartNumber(partNumber);
    this.validateVersionNumber(fromVersion);
    this.validateVersionNumber(toVersion);

    const srcKey = this.getPartFileKey(location, fromVersion, partNumber);
    const srcAbs = this.storagePathService.resolve(srcKey);
    this.assertPathWithinStorageRoot(srcAbs);
    if (!fs.existsSync(srcAbs)) {
      throw new NotFoundException(
        `ไม่พบไฟล์ part-${partNumber}.pdf ในเวอร์ชัน v${fromVersion} (ที่อยู่ไฟล์: ${srcAbs})`,
      );
    }

    const destKey = this.getPartFileKey(location, toVersion, partNumber);
    const destAbs = this.storagePathService.resolve(destKey);
    this.assertPathWithinStorageRoot(destAbs);
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.copyFileSync(srcAbs, destAbs);
    this.logger.log(`Copied part-${partNumber}.pdf from v${fromVersion} -> v${toVersion}`);
    return destKey;
  }

  /**
   * Saves the merged official book PDF. Returns the RELATIVE KEY —
   * persisted to `book_assembly_versions.merged_file_path`.
   */
  saveMergedFile(
    location: BookAssemblyLocation,
    version: number,
    buffer: Buffer,
  ): string {
    this.validateVersionNumber(version);
    const key = this.getMergedFileKey(location, version);
    const abs = this.storagePathService.resolve(key);
    this.assertPathWithinStorageRoot(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buffer);
    this.logger.log(`Saved merged PDF -> ${key}`);
    return key;
  }

  /**
   * Writes the per-version metadata.json sidecar. Not persisted to DB
   * (no FK column) — informational on-disk artifact only.
   */
  writeMetadataJson(
    location: BookAssemblyLocation,
    version: number,
    metadata: Record<string, any>,
  ): string {
    const key = this.getMetadataFileKey(location, version);
    const abs = this.storagePathService.resolve(key);
    this.assertPathWithinStorageRoot(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(metadata, null, 2), 'utf-8');
    this.logger.log(`Wrote metadata.json -> ${key}`);
    return key;
  }

  // ---------------------------------------------------------------------------
  // File read operations — accept the stored value (legacy abs or new key)
  // ---------------------------------------------------------------------------

  /**
   * Reads a part file by stored path. Accepts the value persisted on
   * `book_assembly_drafts.part{n}_file_path` / `book_assembly_versions
   * .part{n}_file_path`, which may be a legacy absolute path OR a new
   * relative key during the migration transition window (umbrella §7.3).
   */
  readPartFileByStored(stored: string): Buffer {
    const abs = this.storagePathService.resolveStored(stored);
    if (!fs.existsSync(abs)) {
      throw new NotFoundException(`ไม่พบไฟล์: ${stored}`);
    }
    return fs.readFileSync(abs);
  }

  /**
   * Returns the absolute path for streaming, given a stored value.
   * Same legacy-absolute / new-relative-key tolerance as `readPartFileByStored`.
   */
  getAbsolutePathByStored(stored: string): string {
    const abs = this.storagePathService.resolveStored(stored);
    if (!fs.existsSync(abs)) {
      throw new NotFoundException(`ไม่พบไฟล์: ${stored}`);
    }
    return abs;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private describeLocation(location: BookAssemblyLocation): string {
    if (location.kind === 'MAIN_PLAN') {
      return `main-plan-${location.planId}`;
    }
    const type = location.kind === 'EDIT_REVISION' ? 'edit' : 'change';
    return `main-plan-${location.planId}/${type}/${type}-${location.revisionNumber}-${location.revisionId}`;
  }
}

/**
 * Map `BookAssemblySourceType` to a `BookAssemblyLocation` kind. Caller
 * is responsible for supplying the additional fields (`planId`,
 * `revisionNumber`, `revisionId`).
 */
export function sourceTypeToLocationKind(
  sourceType: BookAssemblySourceType,
): BookAssemblyLocation['kind'] {
  switch (sourceType) {
    case BookAssemblySourceType.MAIN_PLAN:
      return 'MAIN_PLAN';
    case BookAssemblySourceType.EDIT_REVISION:
      return 'EDIT_REVISION';
    case BookAssemblySourceType.CHANGE_REVISION:
      return 'CHANGE_REVISION';
  }
}
