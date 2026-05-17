import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { StoragePathService } from 'src/storage/storage-path.service';

/**
 * Handles all file-system operations for the standalone Supplement Assembly
 * subsystem.
 *
 * Wave 3 BE-WRITERS — Storage Layout Restructure (umbrella §1 / §7.1).
 * New folder layout (plan-rooted):
 *
 *   /storage/main-plan-{planId}/supplement/supplement-{N}-{supplementId}/v{N}/
 *     parts/part-{1,2,3}.pdf
 *     merged/official-supplement-book-v{N}.pdf
 *     metadata.json
 *
 * The legacy non-plan-rooted layout
 *   /storage/book-assembly/development-plan-supplement-{id}/v{N}/...
 * is removed for writes. Readers tolerate both shapes during the
 * migration window via `StoragePathService.resolveStored(...)`
 * (umbrella §7.3) — BE-MIGRATION (later wave) rewrites legacy rows.
 *
 * Each version is self-contained. Reused parts are **copied**, not
 * referenced by symlink. Version folders are NEVER deleted for
 * finalized versions (immutability rule). The `deleteVersion` helper is
 * provided for transient drafts only.
 *
 * Q10=B standalone constraint — this service MUST NOT import from
 * `src/book-assembly/`. The plan-id requirement (Q1 — supplement file
 * service did not know about the parent plan pre-Wave 3) is satisfied
 * by accepting `planId` explicitly on every call. The orchestrator
 * (`SupplementAssemblyService`) loads the supplement + parent plan in
 * every mutating method, so the lookup is essentially free.
 */

/** Discriminated supplement-version location. */
export interface SupplementLocation {
  planId: string;
  supplementId: string;
  supplementNumber: number;
}

@Injectable()
export class SupplementAssemblyFileService {
  private readonly logger = new Logger(SupplementAssemblyFileService.name);

  private static readonly UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  constructor(
    // Wave 3 BE-WRITERS — single source of truth for path computation.
    // Eliminates the local `path.resolve(process.cwd(), 'storage',
    // 'book-assembly')` literal flagged by BE-SCAN.
    private readonly storagePathService: StoragePathService,
  ) {}

  // ---------------------------------------------------------------------------
  // Input validation
  // ---------------------------------------------------------------------------

  /**
   * Wave 3 BE-WRITERS — boundary check now scoped to STORAGE_ROOT
   * (umbrella §9), matching `BookAssemblyFileService`. Replaces the
   * narrower `{cwd}/storage/book-assembly` boundary that the new
   * plan-rooted layout (`main-plan-{planId}/...`) would falsely reject.
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

  validatePartNumber(partNumber: number): void {
    if (partNumber !== 1 && partNumber !== 2 && partNumber !== 3) {
      throw new BadRequestException('partNumber must be 1, 2, or 3');
    }
  }

  validateVersionNumber(version: number): void {
    if (!Number.isInteger(version) || version < 1) {
      throw new BadRequestException('versionNumber must be a positive integer');
    }
  }

  private validateSupplementId(supplementId: string): void {
    if (typeof supplementId !== 'string' || supplementId.trim().length === 0) {
      throw new BadRequestException('supplementId must be a non-empty string');
    }
    if (!SupplementAssemblyFileService.UUID_REGEX.test(supplementId)) {
      throw new BadRequestException('supplementId must be a valid UUID');
    }
  }

  // ---------------------------------------------------------------------------
  // Key helpers — produce relative keys via StoragePathService
  // ---------------------------------------------------------------------------

  /** Relative version-directory KEY for a supplement. */
  getVersionDirKey(location: SupplementLocation, version: number): string {
    this.validateSupplementId(location.supplementId);
    this.validateVersionNumber(version);
    return this.storagePathService.supplementVersionDir({
      planId: location.planId,
      supplementNumber: location.supplementNumber,
      supplementId: location.supplementId,
      versionNumber: version,
    });
  }

  /** Relative file KEY for `parts/part-{N}.pdf`. */
  getPartFileKey(
    location: SupplementLocation,
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

  /** Relative file KEY for the merged supplement book. */
  getMergedFileKey(location: SupplementLocation, version: number): string {
    return path.posix.join(
      this.getVersionDirKey(location, version),
      'merged',
      `official-supplement-book-v${version}.pdf`,
    );
  }

  /** Relative file KEY for the metadata.json sidecar. */
  getMetadataFileKey(location: SupplementLocation, version: number): string {
    return path.posix.join(this.getVersionDirKey(location, version), 'metadata.json');
  }

  // ---------------------------------------------------------------------------
  // Directory operations
  // ---------------------------------------------------------------------------

  createVersionFolders(location: SupplementLocation, version: number): void {
    this.validateSupplementId(location.supplementId);
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
      `Created version folders for supplement-${location.supplementNumber}-${location.supplementId}/v${version}`,
    );
  }

  /** Alias matching the SUPP_STANDALONE prompt API surface. */
  ensureVersionFolders(location: SupplementLocation, version: number): void {
    this.createVersionFolders(location, version);
  }

  // ---------------------------------------------------------------------------
  // File write operations — persist RELATIVE KEYS
  // ---------------------------------------------------------------------------

  /**
   * Saves a part PDF buffer. Returns the RELATIVE KEY. Note that
   * `SupplementAssemblyDraft` does NOT persist per-part paths (BE-SCAN
   * H1) — the path is recomputed at read time. The return value is
   * informational; the on-disk write is the contract.
   */
  savePartFile(
    location: SupplementLocation,
    version: number,
    partNumber: number,
    buffer: Buffer,
  ): string {
    this.validateSupplementId(location.supplementId);
    this.validateVersionNumber(version);
    this.validatePartNumber(partNumber);
    const key = this.getPartFileKey(location, version, partNumber);
    const abs = this.storagePathService.resolve(key);
    this.assertPathWithinStorageRoot(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buffer);
    this.logger.log(`Saved part-${partNumber}.pdf -> ${key}`);
    return key;
  }

  /** Alias matching the prompt API surface. */
  writePart(
    location: SupplementLocation,
    version: number,
    partNumber: number,
    buffer: Buffer,
  ): string {
    return this.savePartFile(location, version, partNumber, buffer);
  }

  /**
   * Copies a part file from a previous version's `/parts/` to the
   * target version's `/parts/`. Returns the destination's RELATIVE KEY.
   */
  copyPartFromVersion(
    location: SupplementLocation,
    fromVersion: number,
    toVersion: number,
    partNumber: number,
  ): string {
    this.validateSupplementId(location.supplementId);
    this.validateVersionNumber(fromVersion);
    this.validateVersionNumber(toVersion);
    this.validatePartNumber(partNumber);

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
   * Saves the merged official supplement book PDF. Returns the
   * RELATIVE KEY persisted to `supplement_assembly_versions
   * .merged_file_path`.
   */
  saveMergedFile(
    location: SupplementLocation,
    version: number,
    buffer: Buffer,
  ): string {
    this.validateSupplementId(location.supplementId);
    this.validateVersionNumber(version);
    const key = this.getMergedFileKey(location, version);
    const abs = this.storagePathService.resolve(key);
    this.assertPathWithinStorageRoot(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buffer);
    this.logger.log(`Saved merged supplement PDF -> ${key}`);
    return key;
  }

  /** Alias matching the prompt API surface. */
  writeMerged(
    location: SupplementLocation,
    version: number,
    buffer: Buffer,
  ): string {
    return this.saveMergedFile(location, version, buffer);
  }

  /** Writes per-version metadata.json. */
  writeMetadataJson(
    location: SupplementLocation,
    version: number,
    metadata: Record<string, unknown>,
  ): string {
    this.validateSupplementId(location.supplementId);
    this.validateVersionNumber(version);
    const key = this.getMetadataFileKey(location, version);
    const abs = this.storagePathService.resolve(key);
    this.assertPathWithinStorageRoot(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(metadata, null, 2), 'utf-8');
    this.logger.log(`Wrote metadata.json -> ${key}`);
    return key;
  }

  /** Alias matching the prompt API surface. */
  writeMetadata(
    location: SupplementLocation,
    version: number,
    json: Record<string, unknown>,
  ): string {
    return this.writeMetadataJson(location, version, json);
  }

  // ---------------------------------------------------------------------------
  // File read operations
  // ---------------------------------------------------------------------------

  /**
   * Reads a part file. Since `SupplementAssemblyDraft` does NOT persist
   * the per-part path (BE-SCAN H1), reads recompute the key from
   * `(location, version, partNumber)`. This always points at the new
   * plan-rooted location post-Wave 3. Legacy-shape part files (under
   * the pre-Wave 3 `development-plan-supplement-{id}/v{N}/parts/...`
   * tree) are not addressable via this method until BE-MIGRATION moves
   * them — but draft parts are short-lived and are flushed by Wave 3
   * normal operation.
   */
  readPartFile(
    location: SupplementLocation,
    version: number,
    partNumber: number,
  ): Buffer {
    this.validateSupplementId(location.supplementId);
    this.validateVersionNumber(version);
    this.validatePartNumber(partNumber);
    const key = this.getPartFileKey(location, version, partNumber);
    const abs = this.storagePathService.resolve(key);
    this.assertPathWithinStorageRoot(abs);
    if (!fs.existsSync(abs)) {
      throw new NotFoundException(
        `ไม่พบไฟล์ part-${partNumber}.pdf ในเวอร์ชัน v${version}`,
      );
    }
    return fs.readFileSync(abs);
  }

  /** Alias matching the prompt API surface. */
  readPart(
    location: SupplementLocation,
    version: number,
    partNumber: number,
  ): Buffer {
    return this.readPartFile(location, version, partNumber);
  }

  /**
   * Reads the merged supplement PDF by stored value. Accepts legacy
   * absolute path AND new relative key (umbrella §7.3).
   */
  readMergedFileByStored(stored: string): Buffer {
    const abs = this.storagePathService.resolveStored(stored);
    if (!fs.existsSync(abs)) {
      throw new NotFoundException(`ไม่พบไฟล์: ${stored}`);
    }
    return fs.readFileSync(abs);
  }

  /** Returns the absolute path for a stored merged-file value. */
  getAbsolutePathByStored(stored: string): string {
    const abs = this.storagePathService.resolveStored(stored);
    if (!fs.existsSync(abs)) {
      throw new NotFoundException(`ไม่พบไฟล์: ${stored}`);
    }
    return abs;
  }

  /** Returns the absolute path for a draft part (recomputed). */
  getAbsolutePartPath(
    location: SupplementLocation,
    version: number,
    partNumber: number,
  ): string {
    this.validateSupplementId(location.supplementId);
    this.validateVersionNumber(version);
    this.validatePartNumber(partNumber);
    const key = this.getPartFileKey(location, version, partNumber);
    const abs = this.storagePathService.resolve(key);
    this.assertPathWithinStorageRoot(abs);
    if (!fs.existsSync(abs)) {
      throw new NotFoundException(
        `ไม่พบไฟล์ part-${partNumber}.pdf ในเวอร์ชัน v${version}`,
      );
    }
    return abs;
  }

  // ---------------------------------------------------------------------------
  // Destructive operations
  // ---------------------------------------------------------------------------

  /**
   * Wipes an entire v{N}/ folder for a supplement. Transient drafts
   * only — finalized versions MUST NOT be deleted (caller enforces the
   * lifecycle rule).
   */
  deleteVersion(location: SupplementLocation, version: number): void {
    this.validateSupplementId(location.supplementId);
    this.validateVersionNumber(version);
    const versionDirKey = this.getVersionDirKey(location, version);
    const versionAbs = this.storagePathService.resolve(versionDirKey);
    this.assertPathWithinStorageRoot(versionAbs);
    if (!fs.existsSync(versionAbs)) {
      return;
    }
    fs.rmSync(versionAbs, { recursive: true, force: true });
    this.logger.log(
      `Deleted version folder supplement-${location.supplementNumber}-${location.supplementId}/v${version}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Hashing
  // ---------------------------------------------------------------------------

  sha256(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }
}
