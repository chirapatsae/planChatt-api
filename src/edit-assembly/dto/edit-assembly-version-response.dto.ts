// ===================================================================
// EditAssemblyVersionDto — Wave A2 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// Response shape for the version list / detail / current reads.
// Mirrors `MainAssemblyVersionDto` / `SupplementAssemblyVersionDto`
// precedents with `developmentPlanId` → `developmentPlanRevisionId` and
// edit-assembly enum types per Q3=B isolation. Download URLs are
// pre-baked so the FE never has to know the URL pattern.
//
// Note: the legacy `book-assembly` `part3_page_map` JSONB column is
// REMOVED on the version row per Wave A2 spec — page numbers now live
// in `edit_assembly_version_projects`. If the FE needs the per-RPG
// mapping, query the join table separately (out of scope for the
// initial version DTO contract).
// ===================================================================

import {
  EditAssemblyCorrectionMode,
  EditAssemblyPartSource,
  EditAssemblyVersionStatus,
} from '../enums/edit-assembly.enums';

export interface EditAssemblyVersionDto {
  id: string;
  developmentPlanRevisionId: string;
  versionNumber: number;
  status: EditAssemblyVersionStatus;

  correctionMode: EditAssemblyCorrectionMode | null;
  correctionReason: string | null;

  part1Source: EditAssemblyPartSource;
  part1OriginalFileName: string | null;
  part2Source: EditAssemblyPartSource;
  part2OriginalFileName: string | null;
  part3Source: EditAssemblyPartSource;
  part3ProjectCount: number;
  part3ProjectSnapshot: string[] | null;

  mergedAt: string | null;
  totalPages: number | null;

  createdById: string;
  createdAt: string | null;

  deprecatedAt: string | null;
  deprecatedById: string | null;
  deprecationReason: string | null;

  createdBy?: {
    id: string;
    user?: {
      prefix?: string;
      firstName?: string;
      lastName?: string;
    };
  };

  deprecatedBy?: {
    id: string;
    user?: {
      prefix?: string;
      firstName?: string;
      lastName?: string;
    };
  } | null;

  /** Pre-baked download URLs for the API consumer. */
  downloadUrl: string;
  part1DownloadUrl: string;
  part2DownloadUrl: string;
  part3DownloadUrl: string;

  /**
   * §14.11 (read-side) — true when this version's snapshot projects have a
   * live downstream fork (the SAME condition the cancel / CORRECTION_PART3
   * guards throw `BOOK_PROJECTS_REFERENCED_DOWNSTREAM` on). Advisory display
   * flag per §17.2; populated ONLY on the current-version + version-by-number
   * reads, never on the list endpoint. The FE uses it to pre-emptively disable
   * the cancel button + the CORRECTION_PART3 option.
   */
  hasDownstreamFork?: boolean;
}
