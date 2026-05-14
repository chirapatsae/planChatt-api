import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsInt,
  IsUUID,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { CreateBudgetDto } from 'src/budget/dto/create-budget.dto';

export class CreateSupplementProjectGroupDto {
  @IsNotEmpty()
  @IsUUID()
  developmentPlanSupplementId: string;

  @IsNotEmpty()
  title: string;

  @IsOptional()
  objective?: string;

  @IsOptional()
  goal?: string;

  @IsOptional()
  @IsNumber()
  startLat?: number;

  @IsOptional()
  @IsNumber()
  startLng?: number;

  @IsOptional()
  @IsNumber()
  endLat?: number;

  @IsOptional()
  @IsNumber()
  endLng?: number;

  @IsOptional()
  indicator?: string;

  @IsOptional()
  expected?: string;

  @IsNotEmpty()
  @IsInt()
  projectYear: number;

  @IsOptional()
  strategyId?: string;

  @IsOptional()
  tacticId?: string;

  @IsOptional()
  planId?: string;

  /**
   * CLAUDE.md §16 Multi-Format Reporting — ISSUE_BASED classification.
   * Mutually exclusive with (strategyId, tacticId, planId, indicator).
   */
  @IsOptional()
  @IsUUID()
  developmentIssueId?: string;

  @IsOptional()
  @IsUUID()
  originAgencyId?: string | null;

  /**
   * SUPP-1 BE-01 / CLAUDE.md §5.1, §7.1 — `responsibleAgency` is
   * NEVER accepted from the client on SPG create. Every SPG is
   * agency-origin (workflow §5, Q1+Q2 gate), so the service derives
   * `responsibleAgency` from the creator's WorkHistory via
   * `getAgencyData`. A non-undefined value here MUST be rejected with
   * `400 SPG_RESPONSIBLE_AGENCY_NOT_ALLOWED` at the service layer.
   *
   * The property is preserved on the DTO surface (rather than removed)
   * so an unwitting client receives a structured 400 instead of a
   * silent strip by class-validator whitelisting.
   */
  @IsOptional()
  responsibleAgency?: string;

  @IsOptional()
  additionalDetail?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateBudgetDto)
  budget?: CreateBudgetDto[];
}


