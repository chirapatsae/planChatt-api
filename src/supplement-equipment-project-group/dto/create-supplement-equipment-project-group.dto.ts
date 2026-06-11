import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { CreateBudgetDto } from 'src/budget/dto/create-budget.dto';

/**
 * Wave wave-supplement-equipment-por03 — BE-B1 (2026-06-08).
 *
 * Create payload for a supplement-equipment item (ครุภัณฑ์ ผ.03 under
 * เล่มเพิ่มเติม). Mirrors `CreateEquipmentProjectGroupDto` (EPG) but the
 * book parent is `developmentPlanSupplementId` instead of
 * `developmentPlanId` (§10 scope binding to the SEPG's own supplement).
 *
 * Differences vs EPG: parent FK only. Everything else (dual-shape
 * classification slots, `equipmentCategoryId` REQUIRED in both shapes,
 * `indicator` relaxed/optional per §16.5 indicator-relaxation) is
 * identical.
 *
 * Shape validation (STRATEGY_BASED vs ISSUE_BASED) runs at the service
 * layer via `ProjectClassificationValidator` so the DTO keeps both slot
 * sets `@IsOptional`.
 *
 * `responsibleAgency` is NEVER accepted from the client — the service
 * derives it from the creator's WorkHistory via the shared
 * `getAgencyData` helper per §5.1.
 */
export class CreateSupplementEquipmentProjectGroupDto {
  // §10 — book parent is the SEPG's own DevelopmentPlanSupplement.
  @IsNotEmpty()
  @IsUUID()
  developmentPlanSupplementId: string;

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

  // Equipment content fields (per DB-B1 entity).
  @IsNotEmpty()
  @IsString()
  equipmentName: string;

  @IsNotEmpty()
  @IsString()
  targetOutput: string;

  @IsNotEmpty()
  @IsString()
  expectedResults: string;

  // Forward-compat — kept on the DTO for parity with PG/EPG callers; the
  // service coerces empty-string to null and never persists indicator
  // text on equipment rows per the §16.5 indicator-relaxation locked
  // decision.
  @IsOptional()
  @IsString()
  indicator?: string;

  @IsNotEmpty()
  @IsInt()
  projectYear: number;

  // Draft toggle — `true` writes a `Ready` tracking row, `false` writes a
  // `Pending` tracking row + fires the §17.4 no-ai-baseline snapshot.
  @IsOptional()
  @IsBoolean()
  isDraft?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateBudgetDto)
  budget?: CreateBudgetDto[];
}
