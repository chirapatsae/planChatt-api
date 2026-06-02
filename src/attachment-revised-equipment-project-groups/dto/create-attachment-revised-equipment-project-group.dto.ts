import { IsNotEmpty, IsNumber, IsString, IsUUID } from 'class-validator';

/**
 * Mirror of `CreateAttachmentRevisedProjectGroupDto` — the internal DTO the
 * equipment-revision attachment service uses to persist a stored file's
 * metadata. The FK target is the RELPG row.
 */
export class CreateAttachmentRevisedEquipmentProjectGroupDto {
  @IsString()
  filename: string;

  @IsString()
  originalName: string;

  @IsString()
  mimetype: string;

  @IsNumber()
  size: number;

  @IsString()
  path: string;

  @IsUUID()
  @IsNotEmpty()
  revisedEquipmentProjectGroupId: string;
}
