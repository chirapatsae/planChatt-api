import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { CreateBudgetDto } from 'src/budget/dto/create-budget.dto';

/**
 * Wave Equipment Revision Management — BE-01 (Phase 3).
 *
 * Create payload for a RELPG (RevisedEquipmentProjectGroup) — the fork of
 * an approved EquipmentProjectGroup (EPG) into a DevelopmentPlanRevision
 * (DPR) context. Mirrors `CreateEquipmentProjectGroupDto` for the
 * equipment content fields and adds the revision-context FKs
 * (`developmentPlanRevisionId`, `equipmentProjectGroupId`).
 *
 * # Locked decisions
 *
 * - **Agency-only authoring (§3 / §5.3).** This DTO is only reachable
 *   behind `AgencyOnlyGuard` + a service-layer `isAgencyWorkHistory`
 *   re-assertion. LAO callers are rejected with `403 EQUIPMENT_AGENCY_ONLY`.
 * - **Dual-shape classification (§16.5 + Q5=B).** STRATEGY_BASED and
 *   ISSUE_BASED parent plans both supported; the slot sets are mutually
 *   exclusive and validated at the service layer via
 *   `ProjectClassificationValidator`, so both stay `@IsOptional` here.
 * - **`equipmentCategoryId` REQUIRED in both shapes** — equipment is
 *   defined by its category.
 * - **`indicator` OPTIONAL** — equipment relaxes the §16.5 STRATEGY_BASED
 *   indicator-required floor (DB-01 entity comment).
 * - **`responsibleAgency` is NEVER accepted from the client** — the
 *   service auto-assigns it from the creator WorkHistory agency context
 *   per §5.1 (equipment is agency-origin only).
 * - **`prevProjectId` / `prevProjectType` are NOT client-supplied** —
 *   the service derives the lineage edge from `equipmentProjectGroupId`
 *   (`prevProjectType = 'equipment'` for a first-generation fork).
 */
export class CreateRevisedEquipmentProjectGroupDto {
  // Revision-context FKs.
  @IsNotEmpty()
  @IsUUID()
  developmentPlanRevisionId: string;

  /**
   * Source EPG to fork. Becomes `prevProjectId`
   * (`prev_project_type='equipment'`).
   *
   * EXACTLY ONE of `equipmentProjectGroupId` /
   * `revisedEquipmentProjectGroupId` MUST be supplied — the service rejects
   * both/neither with 400. Optional at the DTO layer so the alternate
   * RELPG-source path validates; the service enforces the XOR.
   */
  @IsOptional()
  @IsUUID()
  equipmentProjectGroupId?: string;

  /**
   * Alternate source — a head-of-lineage Approved RELPG (the lineage tip when
   * an approved-revised equipment is revised AGAIN). Becomes `prevProjectId`
   * with `prev_project_type='revised_equipment'` (§14.1/§14.7 Phase 3,
   * RELPG→RELPG chain). Mutually exclusive with `equipmentProjectGroupId`.
   */
  @IsOptional()
  @IsUUID()
  revisedEquipmentProjectGroupId?: string;

  // Classification — STRATEGY_BASED slots (natural-key strings like
  // 'TACT004' / 'PLAN003'). Mutually exclusive with `developmentIssueId`.
  @IsOptional()
  @IsString()
  strategyId?: string;

  @IsOptional()
  @IsString()
  tacticId?: string;

  @IsOptional()
  @IsString()
  planId?: string;

  // Classification — ISSUE_BASED slot. Mutually exclusive with the
  // STRATEGY_BASED triple above.
  @IsOptional()
  @IsUUID()
  developmentIssueId?: string;

  // Equipment-defining FK — REQUIRED in BOTH shapes.
  @IsNotEmpty()
  @IsUUID()
  equipmentCategoryId: string;

  // Equipment content fields (per DB-01 entity).
  @IsNotEmpty()
  @IsString()
  equipmentName: string;

  @IsNotEmpty()
  @IsString()
  targetOutput: string;

  @IsNotEmpty()
  @IsString()
  expectedResults: string;

  // Free-form revision request reason — equipment analog of the project
  // revision's `additionalDetail`. Optional metadata; the service persists
  // it verbatim on create (fork) and update. Does NOT affect workflow /
  // shape / lineage validation.
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;

  // Forward-compat — kept on the DTO for parity with PG callers; the
  // service coerces empty-string to null and never persists indicator
  // text on equipment rows per the §16.5 indicator-relaxation.
  @IsOptional()
  @IsString()
  indicator?: string;

  // Draft toggle — `true` writes a `Ready` tracking row (createDraft),
  // `false` publishes (Pending). Defaults to draft (true) on create so
  // the fork lands in an editable state before submit (§7.2 / §7.3).
  @IsOptional()
  @IsBoolean()
  isDraft?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateBudgetDto)
  budget?: CreateBudgetDto[];
}
