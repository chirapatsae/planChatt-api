import {
  SupplementAssemblyCorrectionMode,
  SupplementAssemblyVersionStatus,
} from '../enums/supplement-assembly.enums';

/**
 * SUPP_STANDALONE_BE_02 — DTO for SupplementAssemblyVersion responses.
 *
 * Q8=A — Multi-version, version numbers reset per-supplement (Q9=A).
 * Q4=C — Wave A status enum carries `COMPLETED` only.
 *
 * Wave A.5 — field names aligned with `BookAssemblyVersion`:
 *   - `version` → `versionNumber`
 *   - `createdByWorkHistoryId` → `createdById`
 *
 * wave-supplement-assembly-metadata-parity / BE-01 — extended with
 * version-card metadata so the FE adapter at
 * `/local-plan-book/assembly/supplement` can render the same chips that
 * the main-plan card already shows: creator display name, project
 * count, project-title snapshot, and total page count. Mirrors the
 * main-plan `VersionResponseDto` at
 * `backend/src/book-assembly/dto/version-response.dto.ts`. All four
 * new fields are nullable so pre-DB-01 rows serialize cleanly.
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

  /** Number of approved SPGs included in Part 3 at merge time. */
  part3ProjectCount: number | null;

  /** Ordered list of Thai project titles included in Part 3. */
  part3ProjectSnapshot: string[] | null;

  /** Total page count of the merged book PDF. */
  totalPages: number | null;

  /**
   * Nested creator projection — populated from the `WorkHistory`
   * ManyToOne relation when the read path eager-loads
   * `['createdBy', 'createdBy.user']`. Field names match the main-plan
   * precedent at `book-assembly/dto/version-response.dto.ts:33-88`.
   */
  createdBy?: {
    id: string;
    user?: {
      prefix?: string;
      firstName?: string;
      lastName?: string;
    };
  };

  // wave-supplement-convergence-milestone-3-multi-version / BE-01
  // (2026-05-25) — correction-lineage projection. Describes HOW this
  // version was produced from a prior corrected version (NULL for the
  // original v1 OR for versions created before the correction-workflow
  // wave shipped). Mirrors the main-plan precedent at
  // `book-assembly/dto/version-response.dto.ts:18-19`.
  correctionMode?: SupplementAssemblyCorrectionMode | null;
  correctionReason?: string | null;

  // wave-supplement-convergence-milestone-3-multi-version / BE-01 —
  // deprecation projection. Describes WHEN this version was retired in
  // favor of a later one (NULL when the row is still COMPLETED).
  // Together with the correctionMode/correctionReason pair above they
  // form the full M3 audit chain that FE-01 renders on the version
  // history list. Mirrors main-plan precedent at
  // `book-assembly/dto/version-response.dto.ts:44-46`. The nested
  // `deprecatedBy` projection is populated when the read path eager-
  // loads `['deprecatedBy', 'deprecatedBy.user']`.
  deprecatedAt?: string | null;
  deprecatedById?: string | null;
  deprecationReason?: string | null;
  deprecatedBy?: {
    id: string;
    user?: {
      prefix?: string;
      firstName?: string;
      lastName?: string;
    };
  } | null;

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
