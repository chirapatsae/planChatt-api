import { VersionResponseDto } from './version-response.dto';

export class RevisionBookHistoryDto {
  revisionId: string;
  revisionName: string;
  latestVersion: VersionResponseDto | null;
  allVersions: VersionResponseDto[];
}

export class PlanBookHistoryDto {
  planId: string;
  planName: string;
  mainBook: {
    latestVersion: VersionResponseDto | null;
    allVersions: VersionResponseDto[];
  } | null;
  editRevisions: RevisionBookHistoryDto[];
  changeRevisions: RevisionBookHistoryDto[];
}
