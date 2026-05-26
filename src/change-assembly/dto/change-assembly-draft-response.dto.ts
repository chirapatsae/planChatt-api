// ===================================================================
// ChangeAssemblyDraftDto — Wave A3 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// Response shape for active / canceled draft reads. Mirrors
// `EditAssemblyDraftDto` and `SupplementAssemblyDraftDto` precedents
// with `developmentPlanId` → `developmentPlanRevisionId` and change-
// assembly enum types per Q3=B isolation.
// ===================================================================

import {
  ChangeAssemblyDraftStatus,
  ChangeAssemblyPartUploadStatus,
} from '../enums/change-assembly.enums';

export interface ChangeAssemblyDraftDto {
  id: string;
  developmentPlanRevisionId: string;
  assemblyStatus: ChangeAssemblyDraftStatus;

  part1Status: ChangeAssemblyPartUploadStatus;
  part1OriginalFileName: string | null;
  part1UploadedAt: string | null;

  part2Status: ChangeAssemblyPartUploadStatus;
  part2OriginalFileName: string | null;
  part2UploadedAt: string | null;

  part3Status: ChangeAssemblyPartUploadStatus;
  part3GeneratedAt: string | null;

  createdById: string;
  createdAt: string;

  /**
   * Nested creator projection — populated when the read path eager-
   * loads `['createdBy', 'createdBy.user']`. Mirrors the edit /
   * supplement precedent.
   */
  createdBy?: {
    id: string;
    user?: {
      prefix?: string;
      firstName?: string;
      lastName?: string;
    };
  };
}
