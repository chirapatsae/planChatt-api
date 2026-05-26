// ===================================================================
// MainAssemblyDraftDto — Wave A1 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// Response shape for active / canceled draft reads. Mirrors
// `SupplementAssemblyDraftDto` and `BookAssemblyDraft` precedents but
// uses main-assembly enum types per Q3=B isolation.
// ===================================================================

import {
  MainAssemblyDraftStatus,
  MainAssemblyPartUploadStatus,
} from '../enums/main-assembly.enums';

export interface MainAssemblyDraftDto {
  id: string;
  developmentPlanId: string;
  assemblyStatus: MainAssemblyDraftStatus;

  part1Status: MainAssemblyPartUploadStatus;
  part1OriginalFileName: string | null;
  part1UploadedAt: string | null;

  part2Status: MainAssemblyPartUploadStatus;
  part2OriginalFileName: string | null;
  part2UploadedAt: string | null;

  part3Status: MainAssemblyPartUploadStatus;
  part3GeneratedAt: string | null;

  createdById: string;
  createdAt: string;

  /**
   * Nested creator projection — populated when the read path eager-
   * loads `['createdBy', 'createdBy.user']`. Mirrors the supplement
   * precedent.
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
