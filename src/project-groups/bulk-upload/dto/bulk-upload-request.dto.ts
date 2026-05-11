import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { BulkUploadRowDto } from './bulk-upload-row.dto';
import { BulkSaveType } from './bulk-upload-context.dto';

/**
 * W113-BE-VALIDATE / §19.6 — top-level bulk upload payload accepted by
 * `POST /project-groups/bulk` and its `/validate` sibling.
 *
 * Constraints:
 *   - `developmentPlanId` is REQUIRED — every batch targets exactly one
 *     plan (CLAUDE.md §10 plan-scope binding).
 *   - `saveType` selects atomic publish vs best-effort draft (§19.5).
 *   - `rows` is bounded to 200 items per §19.6 — larger uploads are
 *     intentionally rejected to keep the per-batch transaction short
 *     (Wave 113 Risk R2).
 */
export class BulkUploadRequestDto {
  @IsNotEmpty()
  @IsUUID()
  developmentPlanId: string;

  @IsEnum(BulkSaveType)
  saveType: BulkSaveType;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => BulkUploadRowDto)
  rows: BulkUploadRowDto[];
}
