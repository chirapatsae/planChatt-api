import {
  BookAssemblySourceType,
  BookAssemblyVersionStatus,
  CorrectionMode,
  PartSource,
} from '../enums/book-assembly.enums';
import { BookAssemblyVersion } from '../entities/book-assembly-version.entity';

/**
 * Version list / detail DTO for API responses.
 */
export class VersionResponseDto {
  id: string;
  sourceType: BookAssemblySourceType;
  sourceId: string;
  versionNumber: number;
  status: BookAssemblyVersionStatus;
  correctionMode: CorrectionMode | null;
  correctionReason: string | null;

  part1Source: PartSource;
  part1OriginalFileName: string | null;
  part2Source: PartSource;
  part2OriginalFileName: string | null;
  part3Source: PartSource;
  part3ProjectCount: number;

  mergedAt: Date;
  totalPages: number | null;

  createdById: string;

  createdBy?: {
    id: string;
    user?: {
      prefix?: string;
      firstName?: string;
      lastName?: string;
    };
  };

  createdAt: Date;

  deprecatedAt: Date | null;
  deprecatedById: string | null;
  deprecationReason: string | null;

  /** Download URLs for the API consumer */
  downloadUrl: string;
  part1DownloadUrl: string;
  part2DownloadUrl: string;
  part3DownloadUrl: string;

  static fromEntity(entity: BookAssemblyVersion, baseUrl: string): VersionResponseDto {
    const dto = new VersionResponseDto();
    const prefix = `${baseUrl}/v1/book-assembly/${entity.sourceType}/${entity.sourceId}`;

    dto.id = entity.id;
    dto.sourceType = entity.sourceType;
    dto.sourceId = entity.sourceId;
    dto.versionNumber = entity.versionNumber;
    dto.status = entity.status;
    dto.correctionMode = entity.correctionMode;
    dto.correctionReason = entity.correctionReason;

    dto.part1Source = entity.part1Source;
    dto.part1OriginalFileName = entity.part1OriginalFileName;
    dto.part2Source = entity.part2Source;
    dto.part2OriginalFileName = entity.part2OriginalFileName;
    dto.part3Source = entity.part3Source;
    dto.part3ProjectCount = entity.part3ProjectCount;

    dto.mergedAt = entity.mergedAt;
    dto.totalPages = entity.totalPages;
    dto.createdById = entity.createdById;

    if (entity.createdBy) {
      dto.createdBy = {
        id: entity.createdBy.id,
        user: entity.createdBy.user
          ? {
              prefix: entity.createdBy.user.prefix,
              firstName: entity.createdBy.user.firstname,
              lastName: entity.createdBy.user.lastname,
            }
          : undefined,
      };
    }

    dto.createdAt = entity.createdAt;
    dto.deprecatedAt = entity.deprecatedAt;
    dto.deprecatedById = entity.deprecatedById;
    dto.deprecationReason = entity.deprecationReason;

    dto.downloadUrl = `${prefix}/versions/${entity.versionNumber}/download`;
    dto.part1DownloadUrl = `${prefix}/versions/${entity.versionNumber}/parts/1`;
    dto.part2DownloadUrl = `${prefix}/versions/${entity.versionNumber}/parts/2`;
    dto.part3DownloadUrl = `${prefix}/versions/${entity.versionNumber}/parts/3`;

    return dto;
  }
}
