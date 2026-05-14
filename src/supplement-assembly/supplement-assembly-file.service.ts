import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

/**
 * Handles all file-system operations for the standalone Supplement Assembly subsystem
 * (Task SUPP_STANDALONE_BE_01, Wave 2 of 6).
 *
 * Folder layout (Q2=B — shared root with BookAssembly, distinct entity identifier):
 *   /storage/book-assembly/development-plan-supplement-{supplementId}/v{N}/parts/
 *     part-1.pdf, part-2.pdf, part-3.pdf
 *   /storage/book-assembly/development-plan-supplement-{supplementId}/v{N}/merged/
 *     official-supplement-book-v{N}.pdf
 *   /storage/book-assembly/development-plan-supplement-{supplementId}/v{N}/metadata.json
 *
 * Each version is self-contained. Reused parts are **copied**, not referenced by symlink.
 * Version folders are NEVER deleted for finalized versions (immutability rule). The
 * `deleteVersion` helper is provided for transient drafts only and remains a safe
 * filesystem operation guarded by path-traversal checks.
 *
 * IMPORTANT: This service is intentionally self-contained — it does NOT import from
 * `src/book-assembly/` (Q10=B standalone constraint). It mirrors the BookAssembly file
 * service shape but owns its own storage namespace via the entity identifier prefix.
 */
@Injectable()
export class SupplementAssemblyFileService {
  private readonly logger = new Logger(SupplementAssemblyFileService.name);
  private readonly storageRoot = path.resolve(process.cwd(), 'storage', 'book-assembly');

  private static readonly UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // ---------------------------------------------------------------------------
  // Input validation (path-traversal prevention — Fix V2 parity)
  // ---------------------------------------------------------------------------

  /**
   * Validates that a resolved path is within the allowed storage root directory.
   * Prevents path traversal attacks via crafted supplementId, version, or part numbers.
   */
  assertPathWithinStorageRoot(resolvedPath: string): string {
    const normalized = path.resolve(resolvedPath);
    if (
      !normalized.startsWith(this.storageRoot + path.sep) &&
      normalized !== this.storageRoot
    ) {
      throw new BadRequestException(
        'File reference must be within the supplement assembly storage directory',
      );
    }
    return normalized;
  }

  /**
   * Validates that partNumber is strictly 1, 2, or 3.
   */
  validatePartNumber(partNumber: number): void {
    if (partNumber !== 1 && partNumber !== 2 && partNumber !== 3) {
      throw new BadRequestException('partNumber must be 1, 2, or 3');
    }
  }

  /**
   * Validates that versionNumber is a positive integer.
   */
  validateVersionNumber(version: number): void {
    if (!Number.isInteger(version) || version < 1) {
      throw new BadRequestException('versionNumber must be a positive integer');
    }
  }

  /**
   * Validates that supplementId is a non-empty UUID string. Rejects path-segment
   * sentinels (`.`, `..`, separators) defensively, even though the path-traversal
   * guard in `assertPathWithinStorageRoot` is the canonical security boundary.
   */
  private validateSupplementId(supplementId: string): void {
    if (typeof supplementId !== 'string' || supplementId.trim().length === 0) {
      throw new BadRequestException('supplementId must be a non-empty string');
    }
    if (!SupplementAssemblyFileService.UUID_REGEX.test(supplementId)) {
      throw new BadRequestException('supplementId must be a valid UUID');
    }
  }

  // ---------------------------------------------------------------------------
  // Path helpers
  // ---------------------------------------------------------------------------

  /**
   * Entity identifier mapping (Q2=B): supplementId → development-plan-supplement-{id}.
   * No source-type discriminator — this service is supplement-only.
   */
  getEntityIdentifier(supplementId: string): string {
    return `development-plan-supplement-${supplementId}`;
  }

  getBasePath(supplementId: string): string {
    this.validateSupplementId(supplementId);
    return path.join(this.storageRoot, this.getEntityIdentifier(supplementId));
  }

  /** Alias matching the user-prompt API surface. */
  getSupplementRoot(supplementId: string): string {
    return this.getBasePath(supplementId);
  }

  getVersionPath(supplementId: string, version: number): string {
    this.validateVersionNumber(version);
    return path.join(this.getBasePath(supplementId), `v${version}`);
  }

  /** Alias matching the user-prompt API surface. */
  getVersionRoot(supplementId: string, version: number): string {
    return this.getVersionPath(supplementId, version);
  }

  getPartsPath(supplementId: string, version: number): string {
    return path.join(this.getVersionPath(supplementId, version), 'parts');
  }

  getMergedPath(supplementId: string, version: number): string {
    return path.join(this.getVersionPath(supplementId, version), 'merged');
  }

  getPartFilePath(supplementId: string, version: number, partNumber: number): string {
    this.validatePartNumber(partNumber);
    return path.join(this.getPartsPath(supplementId, version), `part-${partNumber}.pdf`);
  }

  /** Alias matching the user-prompt API surface. */
  getPartPath(supplementId: string, version: number, partNumber: number): string {
    return this.getPartFilePath(supplementId, version, partNumber);
  }

  getMergedFilePath(supplementId: string, version: number): string {
    return path.join(
      this.getMergedPath(supplementId, version),
      `official-supplement-book-v${version}.pdf`,
    );
  }

  getMetadataFilePath(supplementId: string, version: number): string {
    return path.join(this.getVersionPath(supplementId, version), 'metadata.json');
  }

  /** Alias matching the user-prompt API surface. */
  getMetadataPath(supplementId: string, version: number): string {
    return this.getMetadataFilePath(supplementId, version);
  }

  // ---------------------------------------------------------------------------
  // Directory operations
  // ---------------------------------------------------------------------------

  /**
   * Creates /parts/ and /merged/ subdirectories for a new version.
   */
  createVersionFolders(supplementId: string, version: number): void {
    this.validateSupplementId(supplementId);
    this.validateVersionNumber(version);
    const partsDir = this.getPartsPath(supplementId, version);
    const mergedDir = this.getMergedPath(supplementId, version);
    this.assertPathWithinStorageRoot(partsDir);
    this.assertPathWithinStorageRoot(mergedDir);

    fs.mkdirSync(partsDir, { recursive: true });
    fs.mkdirSync(mergedDir, { recursive: true });

    this.logger.log(
      `Created version folders for ${this.getEntityIdentifier(supplementId)}/v${version}`,
    );
  }

  /** Alias matching the user-prompt API surface. */
  ensureVersionFolders(supplementId: string, version: number): void {
    this.createVersionFolders(supplementId, version);
  }

  // ---------------------------------------------------------------------------
  // File write operations
  // ---------------------------------------------------------------------------

  /**
   * Saves an uploaded or generated part file to the correct versioned directory.
   * Returns the absolute path to the saved file.
   */
  savePartFile(
    supplementId: string,
    version: number,
    partNumber: number,
    buffer: Buffer,
  ): string {
    this.validateSupplementId(supplementId);
    this.validateVersionNumber(version);
    this.validatePartNumber(partNumber);
    const filePath = this.getPartFilePath(supplementId, version, partNumber);
    this.assertPathWithinStorageRoot(filePath);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, buffer);
    this.logger.log(`Saved part-${partNumber}.pdf -> ${filePath}`);
    return filePath;
  }

  /** Alias matching the user-prompt API surface. */
  writePart(
    supplementId: string,
    version: number,
    partNumber: number,
    buffer: Buffer,
  ): string {
    return this.savePartFile(supplementId, version, partNumber, buffer);
  }

  /**
   * Copies a part file from a previous version's /parts/ into the target version's /parts/.
   * Stub-implemented for forward-compat with Wave B corrections (spec §3.2).
   * Returns the absolute path to the copied file.
   */
  copyPartFromVersion(
    supplementId: string,
    fromVersion: number,
    toVersion: number,
    partNumber: number,
  ): string {
    this.validateSupplementId(supplementId);
    this.validateVersionNumber(fromVersion);
    this.validateVersionNumber(toVersion);
    this.validatePartNumber(partNumber);
    const srcPath = this.getPartFilePath(supplementId, fromVersion, partNumber);
    this.assertPathWithinStorageRoot(srcPath);
    if (!fs.existsSync(srcPath)) {
      throw new NotFoundException(
        `ไม่พบไฟล์ part-${partNumber}.pdf ในเวอร์ชัน v${fromVersion} (ที่อยู่ไฟล์: ${srcPath})`,
      );
    }

    const destPath = this.getPartFilePath(supplementId, toVersion, partNumber);
    this.assertPathWithinStorageRoot(destPath);
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    fs.copyFileSync(srcPath, destPath);
    this.logger.log(`Copied part-${partNumber}.pdf from v${fromVersion} -> v${toVersion}`);
    return destPath;
  }

  /**
   * Saves the merged official supplement book PDF. Returns the absolute path.
   */
  saveMergedFile(supplementId: string, version: number, buffer: Buffer): string {
    this.validateSupplementId(supplementId);
    this.validateVersionNumber(version);
    const filePath = this.getMergedFilePath(supplementId, version);
    this.assertPathWithinStorageRoot(filePath);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, buffer);
    this.logger.log(`Saved merged supplement PDF -> ${filePath}`);
    return filePath;
  }

  /** Alias matching the user-prompt API surface. */
  writeMerged(supplementId: string, version: number, buffer: Buffer): string {
    return this.saveMergedFile(supplementId, version, buffer);
  }

  /**
   * Writes the version metadata.json file.
   */
  writeMetadataJson(
    supplementId: string,
    version: number,
    metadata: Record<string, unknown>,
  ): string {
    this.validateSupplementId(supplementId);
    this.validateVersionNumber(version);
    const filePath = this.getMetadataFilePath(supplementId, version);
    this.assertPathWithinStorageRoot(filePath);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2), 'utf-8');
    this.logger.log(`Wrote metadata.json -> ${filePath}`);
    return filePath;
  }

  /** Alias matching the user-prompt API surface. */
  writeMetadata(
    supplementId: string,
    version: number,
    json: Record<string, unknown>,
  ): string {
    return this.writeMetadataJson(supplementId, version, json);
  }

  // ---------------------------------------------------------------------------
  // File read operations
  // ---------------------------------------------------------------------------

  /**
   * Reads a part file and returns its Buffer.
   */
  readPartFile(supplementId: string, version: number, partNumber: number): Buffer {
    this.validateSupplementId(supplementId);
    this.validateVersionNumber(version);
    this.validatePartNumber(partNumber);
    const filePath = this.getPartFilePath(supplementId, version, partNumber);
    this.assertPathWithinStorageRoot(filePath);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException(
        `ไม่พบไฟล์ part-${partNumber}.pdf ในเวอร์ชัน v${version}`,
      );
    }
    return fs.readFileSync(filePath);
  }

  /** Alias matching the user-prompt API surface. */
  readPart(supplementId: string, version: number, partNumber: number): Buffer {
    return this.readPartFile(supplementId, version, partNumber);
  }

  /**
   * Reads the merged official supplement book PDF.
   */
  readMergedFile(supplementId: string, version: number): Buffer {
    this.validateSupplementId(supplementId);
    this.validateVersionNumber(version);
    const filePath = this.getMergedFilePath(supplementId, version);
    this.assertPathWithinStorageRoot(filePath);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException(
        `ไม่พบไฟล์เล่มรวม official-supplement-book-v${version}.pdf`,
      );
    }
    return fs.readFileSync(filePath);
  }

  /** Alias matching the user-prompt API surface. */
  readMerged(supplementId: string, version: number): Buffer {
    return this.readMergedFile(supplementId, version);
  }

  /**
   * Reads metadata.json and returns its parsed contents.
   */
  readMetadataJson(supplementId: string, version: number): Record<string, unknown> {
    this.validateSupplementId(supplementId);
    this.validateVersionNumber(version);
    const filePath = this.getMetadataFilePath(supplementId, version);
    this.assertPathWithinStorageRoot(filePath);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException(
        `ไม่พบไฟล์ metadata.json ในเวอร์ชัน v${version}`,
      );
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  }

  /** Alias matching the user-prompt API surface. */
  readMetadata(supplementId: string, version: number): Record<string, unknown> {
    return this.readMetadataJson(supplementId, version);
  }

  /**
   * Returns the absolute path to a part file (for streaming in controller).
   */
  getAbsolutePartPath(
    supplementId: string,
    version: number,
    partNumber: number,
  ): string {
    this.validateSupplementId(supplementId);
    this.validateVersionNumber(version);
    this.validatePartNumber(partNumber);
    const filePath = this.getPartFilePath(supplementId, version, partNumber);
    this.assertPathWithinStorageRoot(filePath);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException(
        `ไม่พบไฟล์ part-${partNumber}.pdf ในเวอร์ชัน v${version}`,
      );
    }
    return filePath;
  }

  /**
   * Returns the absolute path to the merged file (for streaming in controller).
   */
  getAbsoluteMergedPath(supplementId: string, version: number): string {
    this.validateSupplementId(supplementId);
    this.validateVersionNumber(version);
    const filePath = this.getMergedFilePath(supplementId, version);
    this.assertPathWithinStorageRoot(filePath);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException(
        `ไม่พบไฟล์เล่มรวม official-supplement-book-v${version}.pdf`,
      );
    }
    return filePath;
  }

  // ---------------------------------------------------------------------------
  // Destructive operations
  // ---------------------------------------------------------------------------

  /**
   * Wipes an entire v{N}/ folder for a supplement. Intended for transient drafts only;
   * finalized versions MUST NOT be deleted (caller enforces the lifecycle rule — this
   * helper is a thin filesystem primitive guarded by the path-traversal check).
   */
  deleteVersion(supplementId: string, version: number): void {
    this.validateSupplementId(supplementId);
    this.validateVersionNumber(version);
    const versionDir = this.getVersionPath(supplementId, version);
    this.assertPathWithinStorageRoot(versionDir);
    if (!fs.existsSync(versionDir)) {
      return;
    }
    fs.rmSync(versionDir, { recursive: true, force: true });
    this.logger.log(
      `Deleted version folder ${this.getEntityIdentifier(supplementId)}/v${version}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Hashing
  // ---------------------------------------------------------------------------

  /**
   * Returns the hex-encoded SHA-256 digest of a buffer.
   */
  sha256(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }
}
