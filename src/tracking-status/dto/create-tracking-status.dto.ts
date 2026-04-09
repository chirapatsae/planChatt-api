import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class CreateTrackingStatusDto {
  @IsUUID()
  @IsNotEmpty()
  projectId: string;

  @IsUUID()
  @IsNotEmpty()
  statusId: string;

  @IsOptional()
  comment?: string;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CreateComments)
  comments?: CreateComments[];

  @IsOptional()
  @IsString()
  oldAdditionDetail?: string;

  /**
   * R5-M1: LAO-project owner pull-back may request clearResponsibleAgency.
   * Backend enforces all rules before acting on this flag.
   */
  @IsOptional()
  @IsBoolean()
  clearResponsibleAgency?: boolean;

  /**
   * Staff-only internal remark for this transition.
   *
   * This field is accepted in the DTO but the service layer MUST:
   * - Persist it only when the actor's role is staff / admin / super-admin
   * - Strip it to null when the actor's role is 'user'
   *
   * CLAUDE.md §12 (Audit Rule): all mutations must be traceable.
   * CLAUDE.md §3: only staff-lead roles perform workflow governance transitions.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  staffRemark?: string;
}

export class CreateComments {
  @IsNotEmpty()
  detail: string;

  @IsNumber()
  @IsNotEmpty()
  step: number;
}
