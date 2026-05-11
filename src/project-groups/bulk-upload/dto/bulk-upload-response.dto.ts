import { ReportFormat } from 'src/development-plan/types/report-format.enum';
import { BulkSaveType } from './bulk-upload-context.dto';
import {
  BulkUploadRowError,
  BulkUploadRowResult,
} from './bulk-upload-validation-result.dto';

/**
 * W113-BE-BATCH — response shape for the commit path (`POST /project-groups/bulk`).
 *
 * Mirrors the validator's `BulkUploadValidationResult` with the additional
 * fields produced after the transaction commits:
 *
 *   - `runId` — the per-submit traceability uuid stamped onto every
 *     `TrackingStatus.staffRemark` as `bulk-run:<uuid>` per
 *     W113-DOC-CLAUDE-19 §19.13 (Phase A; the dedicated `bulk_upload_runs`
 *     table is deferred to Phase C).
 *   - `inserted[]` — flat list of `{clientRowIndex, projectGroupId}` so
 *     the frontend can map each successful row back to its uploaded line.
 *   - `errors[]` — flat list of every per-row error (mirrors the union
 *     produced by the validator + commit fallout).
 *   - `summary` — counts derived from `rows[]` (total / inserted / error).
 *   - `mode` — `'commit-atomic'` for publish (rolled back on first row
 *     failure) or `'commit-best-effort'` for draft (invalid rows skipped).
 *
 * The full per-row breakdown still ships in `rows[]` (mixed status:
 * `inserted | invalid | failed`) so the FE can render line-by-line state.
 */
export interface InsertedRowPointer {
  clientRowIndex: number | null;
  projectGroupId: string;
}

export interface BulkUploadCommitSummary {
  totalRows: number;
  insertedCount: number;
  errorCount: number;
}

export interface BulkUploadCommitResult {
  runId: string;
  developmentPlanId: string;
  reportFormat: ReportFormat;
  saveType: BulkSaveType;
  mode: 'commit-atomic' | 'commit-best-effort';
  /**
   * Flat top-level counters mirroring the FE `BulkUploadResponse` contract
   * (frontend/src/page/project/Upload/api/uploadBulk.ts). These are the
   * authoritative fields the FE reads when building toast / refresh
   * triggers; the legacy nested `summary` object is kept below for
   * backwards compatibility but FE consumers MUST prefer these flat keys.
   *
   * Field semantics (must stay in lock-step with `summary.*` for the
   * overlapping metrics):
   *   - `total`         → `finalRows.length`
   *   - `validCount`    → rows with status `valid` OR `inserted`
   *   - `invalidCount`  → rows with status `invalid`
   *   - `insertedCount` → `inserted.length`
   *   - `failedCount`   → rows with status `failed`
   */
  total: number;
  validCount: number;
  invalidCount: number;
  insertedCount: number;
  failedCount: number;
  rows: BulkUploadRowResult[];
  inserted: InsertedRowPointer[];
  errors: BulkUploadRowError[];
  /** @deprecated Prefer the flat top-level counters. Retained for backwards compatibility. */
  summary: BulkUploadCommitSummary;
}
