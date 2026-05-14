import { SupplementAssemblyVersionStatus } from '../enums/supplement-assembly.enums';

/**
 * SUPP_STANDALONE_BE_02 — DTO for SupplementAssemblyVersion responses.
 *
 * Q8=A — Multi-version, version numbers reset per-supplement (Q9=A).
 * Q4=C — Wave A status enum carries `COMPLETED` only.
 *
 * Wave A.5 — field names aligned with `BookAssemblyVersion`:
 *   - `version` → `versionNumber`
 *   - `createdByWorkHistoryId` → `createdById`
 */
export interface SupplementAssemblyVersionDto {
  id: string;
  developmentPlanSupplementId: string;
  versionNumber: number;
  status: SupplementAssemblyVersionStatus;
  mergedFilePath: string;
  mergedFileSha256: string;
  mergedAt: string;
  createdById: string;
  metadataJson: Record<string, unknown> | null;
  createdAt: string;
}
