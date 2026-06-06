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

  // §21.4 — Part 3 staleness signal (advisory, §17.2). Populated only
  // by `getCurrentVersion` / `getVersionByNumber`; `getVersions` (list)
  // skips computation to avoid N+1. Undefined when not computed.

  /** Currently-Approved PGs under the same plan that are NOT in the snapshot. */
  part3StaleProjectCount?: number;
  /** Snapshot PGs that are no longer Approved (rolled back / deleted / demoted). */
  part3RemovedProjectCount?: number;
  /** Currently-Approved equipment under the same plan NOT in the snapshot. */
  part3StaleEquipmentCount?: number;
  /** Snapshot equipment no longer Approved. */
  part3RemovedEquipmentCount?: number;
  /** Derived: `(stale + removed) > 0` across both kinds. */
  isPart3Stale?: boolean;
  /**
   * True when this row predates the §21.4 equipment-snapshot column
   * (NULL `part3EquipmentSnapshot`); FE should render
   * "ข้อมูลครุภัณฑ์ของเวอร์ชันนี้ไม่พร้อมใช้งาน" sub-line.
   */
  equipmentSnapshotMissing?: boolean;

  /**
   * §14.11 (read-side) — true when this version's PG snapshot has a live
   * downstream fork (the SAME condition the CORRECTION_PART3 guard throws
   * `BOOK_PROJECTS_REFERENCED_DOWNSTREAM` on). Advisory display flag per §17.2;
   * populated ONLY on the current-version + version-by-number reads, never on
   * the list endpoint. The FE uses it to pre-emptively disable the
   * CORRECTION_PART3 option. MAIN cancel is §20.4 EXEMPT (already hidden), so
   * the flag is consumed only by the correction surface on MAIN.
   */
  hasDownstreamFork?: boolean;
}
