import { IsNotEmpty, IsNumber, IsString, IsUUID } from 'class-validator';

/**
 * SUPP-3 / BE-07 — DTO for inserting a new attachment row tied to an
 * `SupplementProjectGroup`. Mirrors the PG / RPG attachment DTOs to keep
 * the three surfaces structurally aligned.
 */
export class CreateAttachmentSupplementProjectGroupDto {
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
  supplementProjectGroupId: string;
}
