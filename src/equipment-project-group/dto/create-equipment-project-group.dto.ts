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
 * Wave Equipment ผ.03, Phase 2 — BE-04.
 *
 * Create payload for an equipment item (ครุภัณฑ์ ผ.03). Mirrors
 * CreateProjectGroupDto in spirit; differences:
 *   - `equipmentName`, `targetOutput`, `expectedResults` replace
 *     PG's `title` / `objective` / `goal` / `expected` fields per
 *     DB-02 entity contract.
 *   - `equipmentCategoryId` is REQUIRED in BOTH STRATEGY_BASED and
 *     ISSUE_BASED shapes (equipment is defined by its category).
 *   - `indicator` remains OPTIONAL — equipment relaxes the §16.5
 *     STRATEGY_BASED indicator-required floor (DB-02 §6 / entity
 *     comment "§16.5 indicator-relaxation").
 *
 * Shape validation (STRATEGY_BASED vs ISSUE_BASED) runs at the
 * service layer via `ProjectClassificationValidator` so the DTO
 * keeps both slot sets `@IsOptional`.
 *
 * `responsibleAgency` is NEVER accepted from the client — the service
 * derives it from the creator's WorkHistory via the shared
 * `getAgencyData` helper per §5.1.
 */
export class CreateEquipmentProjectGroupDto {
  @IsNotEmpty()
  @IsUUID()
  developmentPlanId: string;

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

  // Equipment content fields (per DB-02 entity).
  @IsNotEmpty()
  @IsString()
  equipmentName: string;

  @IsNotEmpty()
  @IsString()
  targetOutput: string;

  @IsNotEmpty()
  @IsString()
  expectedResults: string;

  // Forward-compat — kept on the DTO for parity with PG callers; the
  // service coerces empty-string to null and never persists indicator
  // text on equipment rows per the §16.5 indicator-relaxation locked
  // decision.
  @IsOptional()
  @IsString()
  indicator?: string;

  @IsNotEmpty()
  @IsInt()
  projectYear: number;

  // Draft toggle — `true` writes a `Ready` tracking row, `false`
  // writes a `Pending` tracking row. Defaults to publish (false) to
  // match the BE-04 spec acceptance criteria.
  @IsOptional()
  @IsBoolean()
  isDraft?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateBudgetDto)
  budget?: CreateBudgetDto[];
}
