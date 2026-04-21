import { Type } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsObject,
  ValidateNested,
  IsIn,
} from 'class-validator';

export class GenerateProjectDto {
  @IsString()
  @IsOptional()
  strategy?: string;

  @IsString()
  @IsOptional()
  tactic?: string;

  @IsString()
  @IsOptional()
  plan?: string;

  @IsString()
  @IsOptional()
  userPrompt?: string;

  // --- Enriched context fields (all optional for backward compatibility) ---

  @IsString()
  @IsOptional()
  amphoeId?: string;

  @IsString()
  @IsOptional()
  localAdministrativeOrganizationId?: string;

  /**
   * Wave 34 N1 — caller's LAO type label (e.g. "เทศบาลนคร",
   * "องค์การบริหารส่วนตำบล"). When supplied AND matches the
   * `BUDGET_FLOOR_BY_LAO_TYPE` registry, the prompt composer emits a
   * budget clause with the resolved floor and the controller clamps the
   * parsed LLM output defensively. Unrecognised / missing values mean
   * "no floor" (agency path) — prompt is byte-identical to pre-Wave-34
   * and envelope returns `budget: null`. §17.2 advisory; §17.11 no role
   * exemption.
   */
  @IsOptional()
  @IsString()
  organizationType?: string;

  @IsString()
  @IsOptional()
  startLat?: string;

  @IsString()
  @IsOptional()
  startLng?: string;

  @IsString()
  @IsOptional()
  @IsIn(['STRATEGY_BASED', 'ISSUE_BASED'])
  reportFormat?: string;

  @IsString()
  @IsOptional()
  developmentIssueName?: string;

  @IsString()
  @IsOptional()
  developmentIssueId?: string;

  @IsOptional()
  @IsString()
  @IsIn(['full', 'partial', 'minimal'])
  contextQuality?: 'full' | 'partial' | 'minimal';

  /**
   * Wave 28 N1 — optional clicked sub-type code (e.g. "2.1"). When
   * supplied AND reportFormat === ISSUE_BASED AND the registry entry
   * resolves, the prompt composer emits a `[SUB_TYPE_SCOPE]` section
   * so the LLM stays within the chosen sub-type frame. Invalid or
   * unmatched values are silently dropped by the composer (§17.9).
   * Additive; omitting is byte-identical to pre-Wave-28 behavior.
   */
  @IsOptional()
  @IsString()
  subTypeCode?: string;
}

// DTO สำหรับข้อมูลโครงการปัจจุบัน (Nested DTO)
export class CurrentProjectDataDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  objective?: string;

  @IsString()
  @IsOptional()
  goal?: string;

  @IsString()
  @IsOptional()
  expected?: string;

  @IsString()
  @IsOptional()
  indicator?: string;
}

// DTO หลักสำหรับ Endpoint Regenerate
export class RegenerateFieldDto {
  @IsString()
  @IsOptional()
  strategy?: string;

  @IsString()
  @IsOptional()
  tactic?: string;

  @IsString()
  @IsOptional()
  plan?: string;

  @IsString()
  @IsOptional()
  initialPrompt?: string;

  @IsObject()
  @ValidateNested()
  @Type(() => CurrentProjectDataDto)
  currentProjectData: CurrentProjectDataDto;

  @IsString()
  @IsNotEmpty()
  @IsIn(['title', 'objective', 'goal', 'expected', 'indicator'])
  fieldToRegenerate: string;

  @IsString()
  @IsNotEmpty()
  modificationPrompt: string;

  // --- Enriched context fields (all optional for backward compatibility) ---

  @IsString()
  @IsOptional()
  @IsIn(['STRATEGY_BASED', 'ISSUE_BASED'])
  reportFormat?: string;

  @IsString()
  @IsOptional()
  developmentIssueName?: string;

  @IsString()
  @IsOptional()
  amphoeId?: string;

  @IsString()
  @IsOptional()
  localAdministrativeOrganizationId?: string;
}
