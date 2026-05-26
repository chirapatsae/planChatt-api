// ===================================================================
// EditAssemblyDraftDto — Wave A2 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// Response shape for active / canceled draft reads. Mirrors
// `MainAssemblyDraftDto` and `SupplementAssemblyDraftDto` precedents
// with `developmentPlanId` → `developmentPlanRevisionId` and edit-
// assembly enum types per Q3=B isolation.
// ===================================================================

import {
  EditAssemblyDraftStatus,
  EditAssemblyPartUploadStatus,
} from '../enums/edit-assembly.enums';

export interface EditAssemblyDraftDto {
  id: string;
  developmentPlanRevisionId: string;
  assemblyStatus: EditAssemblyDraftStatus;

  part1Status: EditAssemblyPartUploadStatus;
  part1OriginalFileName: string | null;
  part1UploadedAt: string | null;

  part2Status: EditAssemblyPartUploadStatus;
  part2OriginalFileName: string | null;
  part2UploadedAt: string | null;

  part3Status: EditAssemblyPartUploadStatus;
  part3GeneratedAt: string | null;

  createdById: string;
  createdAt: string;

  /**
   * Nested creator projection — populated when the read path eager-
   * loads `['createdBy', 'createdBy.user']`. Mirrors the main /
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
