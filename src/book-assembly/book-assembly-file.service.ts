import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BookAssemblySourceType } from './enums/book-assembly.enums';

/**
 * Handles all file-system operations for the book assembly module (Spec Section 13).
 *
 * Folder layout:
 *   /storage/book-assembly/{entity-identifier}/v{N}/parts/   ← part-1.pdf, part-2.pdf, part-3.pdf
 *   /storage/book-assembly/{entity-identifier}/v{N}/merged/  ← official-book-v{N}.pdf
 *   /storage/book-assembly/{entity-identifier}/v{N}/metadata.json
 *
 * Each version is self-contained. Reused parts are **copied**, not referenced by symlink.
 * Version folders are NEVER deleted, even for deprecated versions (immutability rule).
 */
@Injectable()
export class BookAssemblyFileService {
  private readonly logger = new Logger(BookAssemblyFileService.name);
  private readonly storageRoot = path.resolve(process.cwd(), 'storage', 'book-assembly');

  // ---------------------------------------------------------------------------
  // Fix V2: Path traversal prevention — see security-review-book-assembly.md
  // ---------------------------------------------------------------------------

  /**
   * Validates that a resolved path is within the allowed storage root directory.
   * Prevents path traversal attacks via crafted sourceId, version, or part numbers.
   */
  assertPathWithinStorageRoot(resolvedPath: string): string {
    const normalized = path.resolve(resolvedPath);
    if (!normalized.startsWith(this.storageRoot + path.sep) && normalized !== this.storageRoot) {
      throw new BadRequestException(
        'File reference must be within the book assembly storage directory',
      );
    }
    return normalized;
  }

  /**
   * Validates that a user-supplied file reference resolves within the allowed base directory.
   * For use with externally supplied paths (e.g., newPdfFileReference from DTOs).
   */
  assertUserPathWithinAllowedBase(userPath: string): string {
    // Fix V2: path traversal prevention for user-supplied file references
    const allowedBase = path.resolve(process.cwd(), 'storage');
    const resolved = path.resolve(process.cwd(), userPath);
    if (!resolved.startsWith(allowedBase + path.sep) && resolved !== allowedBase) {
      throw new BadRequestException(
        'File reference must be within the allowed storage directory',
      );
    }
    return resolved;
  }

  /**
   * Validates that partNumber is strictly 1, 2, or 3.
   * Fix V2: input validation for path-constructing parameters.
   */
  validatePartNumber(partNumber: number): void {
    if (partNumber !== 1 && partNumber !== 2 && partNumber !== 3) {
      throw new BadRequestException('partNumber must be 1, 2, or 3');
    }
  }

  /**
   * Validates that versionNumber is a positive integer.
   * Fix V2: input validation for path-constructing parameters.
   */
  validateVersionNumber(version: number): void {
    if (!Number.isInteger(version) || version < 1) {
      throw new BadRequestException('versionNumber must be a positive integer');
    }
  }

  // ---------------------------------------------------------------------------
  // Path helpers
  // ---------------------------------------------------------------------------

  /**
   * Entity identifier mapping:
   *   main_plan + sourceId          → development-plan-{sourceId}
   *   edit_revision + sourceId      → development-plan-revision-{sourceId}
   *   change_revision + sourceId    → development-plan-revision-{sourceId}
   */
  getEntityIdentifier(sourceType: BookAssemblySourceType, sourceId: string): string {
    switch (sourceType) {
      case BookAssemblySourceType.MAIN_PLAN:
        return `development-plan-${sourceId}`;
      case BookAssemblySourceType.EDIT_REVISION:
      case BookAssemblySourceType.CHANGE_REVISION:
        return `development-plan-revision-${sourceId}`;
    }
  }

  getBasePath(sourceType: BookAssemblySourceType, sourceId: string): string {
    return path.join(this.storageRoot, this.getEntityIdentifier(sourceType, sourceId));
  }

  getVersionPath(sourceType: BookAssemblySourceType, sourceId: string, version: number): string {
    return path.join(this.getBasePath(sourceType, sourceId), `v${version}`);
  }

  getPartsPath(sourceType: BookAssemblySourceType, sourceId: string, version: number): string {
    return path.join(this.getVersionPath(sourceType, sourceId, version), 'parts');
  }

  getMergedPath(sourceType: BookAssemblySourceType, sourceId: string, version: number): string {
    return path.join(this.getVersionPath(sourceType, sourceId, version), 'merged');
  }

  getPartFilePath(sourceType: BookAssemblySourceType, sourceId: string, version: number, partNumber: number): string {
    return path.join(this.getPartsPath(sourceType, sourceId, version), `part-${partNumber}.pdf`);
  }

  getMergedFilePath(sourceType: BookAssemblySourceType, sourceId: string, version: number): string {
    return path.join(this.getMergedPath(sourceType, sourceId, version), `official-book-v${version}.pdf`);
  }

  getMetadataFilePath(sourceType: BookAssemblySourceType, sourceId: string, version: number): string {
    return path.join(this.getVersionPath(sourceType, sourceId, version), 'metadata.json');
  }

  // ---------------------------------------------------------------------------
  // Directory operations
  // ---------------------------------------------------------------------------

  /**
   * Creates /parts/ and /merged/ subdirectories for a new version.
   */
  createVersionFolders(sourceType: BookAssemblySourceType, sourceId: string, version: number): void {
    // Fix V2: validate inputs before constructing filesystem paths
    this.validateVersionNumber(version);
    const partsDir = this.getPartsPath(sourceType, sourceId, version);
    const mergedDir = this.getMergedPath(sourceType, sourceId, version);
    this.assertPathWithinStorageRoot(partsDir);
    this.assertPathWithinStorageRoot(mergedDir);

    fs.mkdirSync(partsDir, { recursive: true });
    fs.mkdirSync(mergedDir, { recursive: true });

    this.logger.log(
      `Created version folders for ${this.getEntityIdentifier(sourceType, sourceId)}/v${version}`,
    );
  }

  // ---------------------------------------------------------------------------
  // File write operations
  // ---------------------------------------------------------------------------

  /**
   * Saves an uploaded or generated part file to the correct versioned directory.
   * Returns the absolute path to the saved file.
   */
  savePartFile(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    version: number,
    partNumber: number,
    buffer: Buffer,
  ): string {
    // Fix V2: validate inputs before constructing filesystem paths
    this.validatePartNumber(partNumber);
    this.validateVersionNumber(version);
    const filePath = this.getPartFilePath(sourceType, sourceId, version, partNumber);
    this.assertPathWithinStorageRoot(filePath);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, buffer);
    this.logger.log(`Saved part-${partNumber}.pdf → ${filePath}`);
    return filePath;
  }

  /**
   * Copies a part file from a previous version's /parts/ into the target version's /parts/.
   * Returns the absolute path to the copied file (Spec Section 13.1: each version is self-contained).
   */
  copyPartFromVersion(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    fromVersion: number,
    toVersion: number,
    partNumber: number,
  ): string {
    // Fix V2: validate inputs before constructing filesystem paths
    this.validatePartNumber(partNumber);
    this.validateVersionNumber(fromVersion);
    this.validateVersionNumber(toVersion);
    const srcPath = this.getPartFilePath(sourceType, sourceId, fromVersion, partNumber);
    this.assertPathWithinStorageRoot(srcPath);
    if (!fs.existsSync(srcPath)) {
      throw new NotFoundException(
        `ไม่พบไฟล์ part-${partNumber}.pdf ในเวอร์ชัน v${fromVersion} (ที่อยู่ไฟล์: ${srcPath})`,
      );
    }

    const destPath = this.getPartFilePath(sourceType, sourceId, toVersion, partNumber);
    this.assertPathWithinStorageRoot(destPath);
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    fs.copyFileSync(srcPath, destPath);
    this.logger.log(`Copied part-${partNumber}.pdf from v${fromVersion} → v${toVersion}`);
    return destPath;
  }

  /**
   * Saves the merged official book PDF.
   * Returns the absolute path.
   */
  saveMergedFile(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    version: number,
    buffer: Buffer,
  ): string {
    // Fix V2: validate inputs before constructing filesystem paths
    this.validateVersionNumber(version);
    const filePath = this.getMergedFilePath(sourceType, sourceId, version);
    this.assertPathWithinStorageRoot(filePath);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, buffer);
    this.logger.log(`Saved merged PDF → ${filePath}`);
    return filePath;
  }

  /**
   * Writes the version metadata.json (Spec Section 13.2).
   */
  writeMetadataJson(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    version: number,
    metadata: Record<string, any>,
  ): string {
    const filePath = this.getMetadataFilePath(sourceType, sourceId, version);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2), 'utf-8');
    this.logger.log(`Wrote metadata.json → ${filePath}`);
    return filePath;
  }

  // ---------------------------------------------------------------------------
  // File read operations
  // ---------------------------------------------------------------------------

  /**
   * Reads a part file and returns its Buffer.
   */
  readPartFile(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    version: number,
    partNumber: number,
  ): Buffer {
    // Fix V2: validate inputs before constructing filesystem paths
    this.validatePartNumber(partNumber);
    this.validateVersionNumber(version);
    const filePath = this.getPartFilePath(sourceType, sourceId, version, partNumber);
    this.assertPathWithinStorageRoot(filePath);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException(
        `ไม่พบไฟล์ part-${partNumber}.pdf ในเวอร์ชัน v${version}`,
      );
    }
    return fs.readFileSync(filePath);
  }

  /**
   * Reads the merged official book PDF.
   */
  readMergedFile(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    version: number,
  ): Buffer {
    // Fix V2: validate inputs before constructing filesystem paths
    this.validateVersionNumber(version);
    const filePath = this.getMergedFilePath(sourceType, sourceId, version);
    this.assertPathWithinStorageRoot(filePath);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException(
        `ไม่พบไฟล์เล่มรวม official-book-v${version}.pdf`,
      );
    }
    return fs.readFileSync(filePath);
  }

  /**
   * Returns the absolute path to a part file (for streaming in controller).
   */
  getAbsolutePartPath(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    version: number,
    partNumber: number,
  ): string {
    // Fix V2: validate inputs before constructing filesystem paths
    this.validatePartNumber(partNumber);
    this.validateVersionNumber(version);
    const filePath = this.getPartFilePath(sourceType, sourceId, version, partNumber);
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
  getAbsoluteMergedPath(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    version: number,
  ): string {
    // Fix V2: validate inputs before constructing filesystem paths
    this.validateVersionNumber(version);
    const filePath = this.getMergedFilePath(sourceType, sourceId, version);
    this.assertPathWithinStorageRoot(filePath);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException(
        `ไม่พบไฟล์เล่มรวม official-book-v${version}.pdf`,
      );
    }
    return filePath;
  }
}
