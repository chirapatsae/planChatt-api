import { ReportFormat } from 'src/development-plan/types/report-format.enum';
import { BulkSaveType } from './bulk-upload-context.dto';

/**
 * W113-BE-VALIDATE — per-row error item.
 *
 * `code` is a stable machine identifier (consumed by the frontend toast
 * mapping and the failed-rows export); `message` is the Thai
 * human-readable copy; `field` is the optional logical column name in
 * Thai when the error is attributable to a specific cell.
 *
 * `severity` distinguishes hard errors (block insert) from advisory
 * warnings (e.g., §13.5 geo soft warning) so the response can be
 * rendered correctly without inspecting the code list.
 */
export interface BulkUploadRowError {
  code: string;
  field?: string;
  message: string;
  severity: 'error' | 'warning';
}

/**
 * Per-row result returned by `BulkUploadValidator.validateRow` and
 * extended by `BulkUploadService` after the commit step.
 *
 * Status semantics:
 *   - `valid`    — passed every check; may be inserted
 *   - `invalid`  — at least one hard error; row is rejected
 *   - `inserted` — populated by the commit path after the row was
 *                  successfully written (out of scope for this task)
 *   - `failed`   — populated by the commit path when the insert threw
 *                  (out of scope for this task)
 *
 * The validator only ever produces `valid` or `invalid`. The other two
 * states are reserved for the BE-BATCH consumer.
 */
export interface BulkUploadRowResult {
  clientRowIndex: number | null;
  status: 'valid' | 'invalid' | 'inserted' | 'failed';
  projectGroupId?: string;
  errors: BulkUploadRowError[];
  geoWarning?: { reason: string };
}

/**
 * Aggregated batch-level result. Mirrors the response shape used by
 * the future bulk endpoints so the validator and the commit path emit
 * structurally identical payloads (the commit path adds `insertedCount`,
 * `failedCount`, `mode='commit-*'`, and `batchNotificationId`).
 *
 * `validRows` is provided as a convenience derived collection (rows
 * with `status === 'valid'`) — the canonical list is `rows`.
 */
export interface BulkUploadValidationResult {
  developmentPlanId: string;
  reportFormat: ReportFormat;
  saveType: BulkSaveType;
  total: number;
  validCount: number;
  invalidCount: number;
  rows: BulkUploadRowResult[];
  validRows: BulkUploadRowResult[];
  warnings: BulkUploadRowError[];
}
