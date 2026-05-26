// ===================================================================
// ChangeAssemblyVersionDto — Wave A3 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// Response shape for the version list / detail / current reads.
// Mirrors `EditAssemblyVersionDto` / `SupplementAssemblyVersionDto`
// precedents with `developmentPlanId` → `developmentPlanRevisionId` and
// change-assembly enum types per Q3=B isolation. Download URLs are
// pre-baked so the FE never has to know the URL pattern.
//
// Note: the legacy `book-assembly` `part3_page_map` JSONB column is
// REMOVED on the version row per Wave A3 spec — page numbers now live
// in `change_assembly_version_projects`. If the FE needs the per-RPG
// mapping, query the join table separately (out of scope for the
// initial version DTO contract).
// ===================================================================

import {
  ChangeAssemblyCorrectionMode,
  ChangeAssemblyPartSource,
  ChangeAssemblyVersionStatus,
} from '../enums/change-assembly.enums';

export interface ChangeAssemblyVersionDto {
  id: string;
  developmentPlanRevisionId: string;
  versionNumber: number;
  status: ChangeAssemblyVersionStatus;

  correctionMode: ChangeAssemblyCorrectionMode | null;
  correctionReason: string | null;

  part1Source: ChangeAssemblyPartSource;
  part1OriginalFileName: string | null;
  part2Source: ChangeAssemblyPartSource;
  part2OriginalFileName: string | null;
  part3Source: ChangeAssemblyPartSource;
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
}
