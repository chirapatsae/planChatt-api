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
