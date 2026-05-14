import {
  SupplementAssemblyDraftStatus,
  SupplementAssemblyPartSource,
  SupplementAssemblyPartUploadStatus,
} from '../enums/supplement-assembly.enums';

/**
 * SUPP_STANDALONE_BE_02 — DTO for SupplementAssemblyDraft responses.
 *
 * Surfaces the per-part upload status so the FE stepper (FE_02) can
 * render Part 1 / Part 2 / Part 3 progress without re-mapping enum
 * values. Mirrors the BookAssembly DraftDto shape (Q3=B duplicate but
 * supplement-only).
 *
 * Wave A.5 — FLAT shape aligned with `BookAssemblyDraft`:
 *   - top-level fields per part (`part{n}Status`, `part{n}Source`,
 *     `part{n}OriginalFileName`, `part{n}UploadedAt` / `part3GeneratedAt`)
 *   - `status` → `assemblyStatus`
 *   - `createdByWorkHistoryId` → `createdById`
 */
export interface SupplementAssemblyDraftDto {
  id: string;
  developmentPlanSupplementId: string;
  assemblyStatus: SupplementAssemblyDraftStatus;

  part1Status: SupplementAssemblyPartUploadStatus;
  part1Source: SupplementAssemblyPartSource | null;
  part1OriginalFileName: string | null;
  part1UploadedAt: string | null;

  part2Status: SupplementAssemblyPartUploadStatus;
  part2Source: SupplementAssemblyPartSource | null;
  part2OriginalFileName: string | null;
  part2UploadedAt: string | null;

  part3Status: SupplementAssemblyPartUploadStatus;
  part3Source: SupplementAssemblyPartSource | null;
  part3OriginalFileName: string | null;
  part3GeneratedAt: string | null;

  createdById: string;
  createdAt: string;
  updatedAt: string;
}
