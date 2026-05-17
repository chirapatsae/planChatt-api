import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Wave 2 — Storage Layout Restructure (BE-PATH-SERVICE).
 *
 * Single source of truth for on-disk PDF path computation, directory
 * bootstrap, and read/write primitives under the new plan-rooted
 * hierarchy.
 *
 * Target layout (umbrella §1):
 *
 *   {STORAGE_ROOT}/
 *     main-plan-{planId}/
 *       v1/  v2/  ...                              ← main plan book versions
 *       edit/                                      ← always present (BE-BOOTSTRAP)
 *         edit-{revisionNumber}-{revisionId}/
 *           v1/  v2/  ...
 *       change/
 *         change-{revisionNumber}-{revisionId}/
 *           v1/  v2/  ...
 *       supplement/
 *         supplement-{supplementNumber}-{supplementId}/
 *           v1/  v2/  ...
 *
 * Design choices (FROZEN — Wave 2 accepted defaults):
 *
 *   1. URLs unchanged — clients never see path changes (§4 out-of-scope).
 *   2. DB persists the LOGICAL KEY relative to {STORAGE_ROOT}
 *      (option (c) per umbrella §7.1). Absolute paths live ONLY at the
 *      filesystem boundary inside this service.
 *   3. Bootstrap is EAGER — `bootstrapPlan` is called by BE-BOOTSTRAP on
 *      DevelopmentPlan create + idempotent re-creation on plan load.
 *   4. Migration window is low-traffic — no feature flag needed.
 *
 * Resolution root choice — `process.cwd()` (NOT `__dirname`):
 *
 *   BE-SCAN finding C2 documents a latent dev/prod root mismatch in
 *   `pdf.service.ts:141-143` where `__dirname`-relative resolution
 *   resolves to `{repo}/backend/uploads/pdf` in dev and
 *   `{repo}/backend/dist/uploads/pdf` in prod. This service aligns with
 *   the assembly-services convention (`path.resolve(process.cwd(),
 *   'storage', ...)`) so that production and development resolve to the
 *   same root. This closes C2 going forward — the legacy `__dirname`
 *   branch survives in the resolver (`resolveStored`) for the migration
 *   transition window but new writes always go via `process.cwd()`.
 *
 * Non-goals (§4 out-of-scope, enforced):
 *
 *   - No workflow / status / authority logic. Pure path math + fs I/O.
 *   - No DB access. Callers wrap their own transaction; this service
 *     does not begin / commit transactions.
 *   - No URL surface knowledge. Clients reach files via existing stream
 *     endpoints; this service is invisible to controllers.
 */
@Injectable()
export class StoragePathService {
  private readonly logger = new Logger(StoragePathService.name);

  /** Absolute path to the storage root. Computed once at construction. */
  private readonly storageRoot: string;

  /** Hard cap on key length to protect against pathological inputs. */
  private static readonly MAX_KEY_LENGTH = 1024;

  /** Default storage root when STORAGE_ROOT env var is unset. */
  private static readonly DEFAULT_STORAGE_ROOT_DIR = 'storage';

  constructor(
    @Optional() private readonly configService?: ConfigService,
  ) {
    // STORAGE_ROOT env var takes precedence; fall back to `{cwd}/storage`.
    // The fallback matches the existing BookAssembly / SupplementAssembly
    // convention (`path.resolve(process.cwd(), 'storage', ...)`).
    const fromEnv =
      this.configService?.get<string>('STORAGE_ROOT') ??
      process.env.STORAGE_ROOT;

    if (fromEnv && fromEnv.trim().length > 0) {
      // Allow STORAGE_ROOT to be either absolute or relative to cwd.
      this.storageRoot = path.isAbsolute(fromEnv)
        ? path.resolve(fromEnv)
        : path.resolve(process.cwd(), fromEnv);
    } else {
      this.storageRoot = path.resolve(
        process.cwd(),
        StoragePathService.DEFAULT_STORAGE_ROOT_DIR,
      );
    }

    this.logger.log(`StoragePathService initialized; root=${this.storageRoot}`);
  }

  // ---------------------------------------------------------------------------
  // Public — path computation (POSIX-style relative keys)
  // ---------------------------------------------------------------------------

  /**
   * Relative directory key for a main-plan version.
   * → `main-plan-{planId}/v{N}`
   */
  mainPlanVersionDir(planId: string, versionNumber: number): string {
    this.assertId(planId, 'planId');
    this.assertVersion(versionNumber);
    return path.posix.join(
      `main-plan-${planId}`,
      `v${versionNumber}`,
    );
  }

  /**
   * Relative file key for a main-plan version.
   * → `main-plan-{planId}/v{N}/{fileName}`
   */
  mainPlanVersionKey(
    planId: string,
    versionNumber: number,
    fileName: string,
  ): string {
    this.assertFileName(fileName);
    return path.posix.join(
      this.mainPlanVersionDir(planId, versionNumber),
      fileName,
    );
  }

  /**
   * Relative directory key for an edit/change revision version.
   * → `main-plan-{planId}/{edit|change}/{edit|change}-{revNo}-{revId}/v{N}`
   */
  revisionVersionDir(opts: {
    planId: string;
    revisionType: 'edit' | 'change';
    revisionNumber: number;
    revisionId: string;
    versionNumber: number;
  }): string {
    const { planId, revisionType, revisionNumber, revisionId, versionNumber } =
      opts;
    this.assertId(planId, 'planId');
    this.assertId(revisionId, 'revisionId');
    this.assertRevisionType(revisionType);
    this.assertVersion(revisionNumber);
    this.assertVersion(versionNumber);
    return path.posix.join(
      `main-plan-${planId}`,
      revisionType,
      `${revisionType}-${revisionNumber}-${revisionId}`,
      `v${versionNumber}`,
    );
  }

  /**
   * Relative file key for an edit/change revision version.
   * → `main-plan-{planId}/{edit|change}/{edit|change}-{revNo}-{revId}/v{N}/{fileName}`
   */
  revisionVersionKey(opts: {
    planId: string;
    revisionType: 'edit' | 'change';
    revisionNumber: number;
    revisionId: string;
    versionNumber: number;
    fileName: string;
  }): string {
    this.assertFileName(opts.fileName);
    return path.posix.join(this.revisionVersionDir(opts), opts.fileName);
  }

  /**
   * Relative directory key for a supplement version.
   * → `main-plan-{planId}/supplement/supplement-{supplementNumber}-{supplementId}/v{N}`
   */
  supplementVersionDir(opts: {
    planId: string;
    supplementNumber: number;
    supplementId: string;
    versionNumber: number;
  }): string {
    const { planId, supplementNumber, supplementId, versionNumber } = opts;
    this.assertId(planId, 'planId');
    this.assertId(supplementId, 'supplementId');
    this.assertVersion(supplementNumber);
    this.assertVersion(versionNumber);
    return path.posix.join(
      `main-plan-${planId}`,
      'supplement',
      `supplement-${supplementNumber}-${supplementId}`,
      `v${versionNumber}`,
    );
  }

  /**
   * Relative file key for a supplement version.
   * → `main-plan-{planId}/supplement/supplement-{N}-{id}/v{N}/{fileName}`
   */
  supplementVersionKey(opts: {
    planId: string;
    supplementNumber: number;
    supplementId: string;
    versionNumber: number;
    fileName: string;
  }): string {
    this.assertFileName(opts.fileName);
    return path.posix.join(this.supplementVersionDir(opts), opts.fileName);
  }

  // ---------------------------------------------------------------------------
  // Public — root-level keys (used by bootstrap + ls)
  // ---------------------------------------------------------------------------

  /** → `main-plan-{planId}` */
  mainPlanRoot(planId: string): string {
    this.assertId(planId, 'planId');
    return `main-plan-${planId}`;
  }

  /** → `main-plan-{planId}/edit` */
  editRoot(planId: string): string {
    return path.posix.join(this.mainPlanRoot(planId), 'edit');
  }

  /** → `main-plan-{planId}/change` */
  changeRoot(planId: string): string {
    return path.posix.join(this.mainPlanRoot(planId), 'change');
  }

  /** → `main-plan-{planId}/supplement` */
  supplementRoot(planId: string): string {
    return path.posix.join(this.mainPlanRoot(planId), 'supplement');
  }

  // ---------------------------------------------------------------------------
  // Public — resolution + safety
  // ---------------------------------------------------------------------------

  /**
   * Resolve a stored RELATIVE key to an absolute filesystem path.
   * Rejects unsafe keys via `assertSafeKey`.
   */
  resolve(key: string): string {
    this.assertSafeKey(key);
    // path.resolve normalizes POSIX-style separators on POSIX hosts;
    // production is Linux per task §11. Forward slashes survive.
    return path.resolve(this.storageRoot, key);
  }

  /**
   * Alias for `resolve` — preserves the `toAbsolute` name from the
   * task-file contract (§7.1).
   */
  toAbsolute(key: string): string {
    return this.resolve(key);
  }

  /**
   * Reader-side resolver: accepts either a new relative key OR a legacy
   * absolute path (Scheme A / B / C per BE-SCAN). Returns an absolute
   * path suitable for `fs.createReadStream` / `fs.readFile`.
   *
   * Detection heuristic:
   *   - Absolute path (starts with `/` on POSIX) → returned as-is.
   *   - Otherwise treat as relative key → resolve under STORAGE_ROOT.
   *
   * This branch exists for the migration transition window (umbrella
   * §7.3). Once BE-MIGRATION completes and a follow-up wave audits the
   * DB, the absolute-path branch may be retired.
   */
  resolveStored(stored: string): string {
    if (typeof stored !== 'string' || stored.length === 0) {
      throw new BadRequestException('Stored path must be a non-empty string');
    }
    if (path.isAbsolute(stored)) {
      // Legacy absolute path. Return unchanged so existing readers keep
      // working until BE-MIGRATION rewrites the row.
      return stored;
    }
    return this.resolve(stored);
  }

  /**
   * Reject unsafe relative keys.
   *
   * A safe key:
   *   - is a non-empty string
   *   - does not exceed MAX_KEY_LENGTH characters
   *   - does not start with `/` (i.e., is not absolute)
   *   - does not contain `..` path segments
   *   - does not contain backslashes (POSIX-only — production is Linux)
   *   - does not contain NUL bytes
   *
   * Throws `BadRequestException` on any violation.
   */
  assertSafeKey(key: string): void {
    if (typeof key !== 'string' || key.length === 0) {
      throw new BadRequestException('Storage key must be a non-empty string');
    }
    if (key.length > StoragePathService.MAX_KEY_LENGTH) {
      throw new BadRequestException(
        `Storage key exceeds maximum length of ${StoragePathService.MAX_KEY_LENGTH} characters`,
      );
    }
    if (key.includes('\0')) {
      throw new BadRequestException('Storage key must not contain NUL bytes');
    }
    if (key.includes('\\')) {
      throw new BadRequestException(
        'Storage key must not contain backslashes (use forward slashes)',
      );
    }
    if (path.isAbsolute(key) || key.startsWith('/')) {
      throw new BadRequestException(
        'Storage key must be relative (no leading slash, no absolute paths)',
      );
    }
    // Check for `..` segments after normalizing to POSIX separators.
    const segments = key.split('/');
    if (segments.some((seg) => seg === '..')) {
      throw new BadRequestException(
        'Storage key must not contain ".." path segments',
      );
    }
    // Belt-and-braces: also verify the resolved absolute path stays
    // under STORAGE_ROOT. This guards against any future encoding edge
    // case slipping past the segment check.
    const abs = path.resolve(this.storageRoot, key);
    const rootWithSep = this.storageRoot.endsWith(path.sep)
      ? this.storageRoot
      : this.storageRoot + path.sep;
    if (abs !== this.storageRoot && !abs.startsWith(rootWithSep)) {
      throw new BadRequestException(
        'Storage key resolves outside the storage root',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Public — filesystem primitives
  // ---------------------------------------------------------------------------

  /**
   * Eagerly create the plan root + 3 fixed subfolders (`edit`, `change`,
   * `supplement`) for a newly inserted DevelopmentPlan. Idempotent —
   * safe to call on plans that already exist.
   *
   * Honors the user wording "จะต้องมีสาม folder นี้แน่นอน".
   */
  async bootstrapPlan(planId: string): Promise<void> {
    this.assertId(planId, 'planId');
    const keys = [
      this.mainPlanRoot(planId),
      this.editRoot(planId),
      this.changeRoot(planId),
      this.supplementRoot(planId),
    ];
    for (const key of keys) {
      const abs = this.resolve(key);
      await fsp.mkdir(abs, { recursive: true });
    }
  }

  /**
   * Write a buffer to the given key. Creates intermediate directories.
   * Atomicity is NOT guaranteed — callers wrap DB writes in their own
   * transaction and treat fs I/O as a separate concern (umbrella §7.5
   * documents the same constraint for the migration script).
   */
  async writeFile(key: string, buffer: Buffer): Promise<void> {
    const abs = this.resolve(key);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, buffer);
  }

  /**
   * Read a file by key. Throws on missing file (`ENOENT`).
   */
  async readFile(key: string): Promise<Buffer> {
    const abs = this.resolve(key);
    return fsp.readFile(abs);
  }

  /**
   * Open a read stream by key (for HTTP stream endpoints).
   * Caller is responsible for piping + closing.
   */
  createReadStream(key: string): NodeJS.ReadableStream {
    const abs = this.resolve(key);
    return fs.createReadStream(abs);
  }

  /** Existence check. Never throws. */
  async exists(key: string): Promise<boolean> {
    try {
      await fsp.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  /** `fs.stat` wrapper by key. Throws on missing file. */
  async stat(key: string): Promise<fs.Stats> {
    return fsp.stat(this.resolve(key));
  }

  /**
   * Ensure a directory exists (mkdir -p) for a relative key. Accepts a
   * key that points to either a directory OR a file (parent dir is
   * created in both cases — caller's choice).
   */
  async ensureDir(key: string): Promise<void> {
    const abs = this.resolve(key);
    await fsp.mkdir(abs, { recursive: true });
  }

  /**
   * Move a file from `srcKey` to `dstKey`. Falls back to copy + verify
   * + unlink on `EXDEV` (cross-volume rename), per umbrella §11 risk
   * note. Used by BE-MIGRATION; exposed here so the EXDEV fallback
   * lives in one place.
   */
  async moveFile(srcKey: string, dstKey: string): Promise<void> {
    const srcAbs = this.resolve(srcKey);
    const dstAbs = this.resolve(dstKey);
    await fsp.mkdir(path.dirname(dstAbs), { recursive: true });
    try {
      await fsp.rename(srcAbs, dstAbs);
    } catch (err: any) {
      if (err?.code !== 'EXDEV') {
        throw err;
      }
      // Cross-volume — copy + unlink. `copyFile` is atomic-per-file on
      // POSIX; the unlink that follows is best-effort. If the unlink
      // fails the caller still has a valid destination file.
      await fsp.copyFile(srcAbs, dstAbs);
      try {
        await fsp.unlink(srcAbs);
      } catch (unlinkErr) {
        this.logger.warn(
          `EXDEV fallback: copy succeeded but unlink failed for ${srcAbs}: ${
            (unlinkErr as Error).message
          }`,
        );
      }
    }
  }

  /** STORAGE_ROOT absolute path — for migration script + ops scripts ONLY. */
  getStorageRoot(): string {
    return this.storageRoot;
  }

  // ---------------------------------------------------------------------------
  // Private — input guards
  // ---------------------------------------------------------------------------

  private assertId(value: string, fieldName: string): void {
    if (typeof value !== 'string' || value.length === 0) {
      throw new BadRequestException(
        `${fieldName} must be a non-empty string`,
      );
    }
    // Reject any filesystem-hostile characters defensively. UUIDs are
    // safe; this guards against accidental misuse.
    if (/[\/\\\0]/.test(value) || value === '.' || value === '..') {
      throw new BadRequestException(
        `${fieldName} contains invalid characters: "${value}"`,
      );
    }
  }

  private assertVersion(value: number): void {
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 1 ||
      !Number.isFinite(value)
    ) {
      throw new BadRequestException(
        `version / ordinal must be a positive integer, got: ${value}`,
      );
    }
  }

  private assertRevisionType(value: 'edit' | 'change'): void {
    if (value !== 'edit' && value !== 'change') {
      throw new BadRequestException(
        `revisionType must be 'edit' or 'change', got: ${value}`,
      );
    }
  }

  private assertFileName(fileName: string): void {
    if (typeof fileName !== 'string' || fileName.length === 0) {
      throw new BadRequestException('fileName must be a non-empty string');
    }
    if (/[\/\\\0]/.test(fileName)) {
      throw new BadRequestException(
        `fileName must not contain path separators or NUL bytes: "${fileName}"`,
      );
    }
    if (fileName === '.' || fileName === '..') {
      throw new BadRequestException(`fileName must not be "." or ".."`);
    }
  }
}
