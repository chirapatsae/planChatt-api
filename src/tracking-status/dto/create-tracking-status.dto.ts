import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateTrackingStatusDto {
  @IsUUID()
  @IsNotEmpty()
  projectId: string;

  /**
   * SUPP-1 / BE-02 — Optional explicit SupplementProjectGroup id.
   *
   * The SPG endpoint (`POST /tracking-status/create-by-supplement-project-group`)
   * accepts the target SPG id via either `supplementProjectGroupId` (preferred,
   * explicit) OR `projectId` (legacy mirror of the RPG endpoint, which reads
   * the RPG id off `projectId`). The service prefers
   * `supplementProjectGroupId` when present and falls back to `projectId`.
   *
   * Other endpoints (PG / RPG paths) MUST ignore this field.
   */
  @IsOptional()
  @IsUUID()
  supplementProjectGroupId?: string;

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
  @IsString()
  @IsNotEmpty()
  detail: string;

  @IsInt()
  @Min(1)
  @Max(6)
  step: number;
}
