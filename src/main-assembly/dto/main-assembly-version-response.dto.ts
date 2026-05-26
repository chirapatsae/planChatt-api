// ===================================================================
// MainAssemblyVersionDto — Wave A1 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// Response shape for the version list / detail / current reads.
// Mirrors `VersionResponseDto` (book-assembly) + `SupplementAssembly
// VersionDto` precedents but uses main-assembly enum types per Q3=B
// isolation. Download URLs are pre-baked so the FE never has to know
// the URL pattern.
//
// Note: the legacy `book-assembly` `part3_page_map` JSONB column is
// REMOVED on the version row per Wave A1 spec — page numbers now live
// in `main_assembly_version_projects`. If the FE needs the per-PG
// mapping, query the join table separately (out of scope for the
// initial version DTO contract).
// ===================================================================

import {
  MainAssemblyCorrectionMode,
  MainAssemblyPartSource,
  MainAssemblyVersionStatus,
} from '../enums/main-assembly.enums';

export interface MainAssemblyVersionDto {
  id: string;
  developmentPlanId: string;
  versionNumber: number;
  status: MainAssemblyVersionStatus;

  correctionMode: MainAssemblyCorrectionMode | null;
  correctionReason: string | null;

  part1Source: MainAssemblyPartSource;
  part1OriginalFileName: string | null;
  part2Source: MainAssemblyPartSource;
  part2OriginalFileName: string | null;
  part3Source: MainAssemblyPartSource;
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
