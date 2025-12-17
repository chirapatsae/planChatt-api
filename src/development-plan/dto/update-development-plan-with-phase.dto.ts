import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsUUID, ValidateNested } from 'class-validator';
import { CreatePlanPhaseForDevelopmentPlanDto } from './create-development-plan-with-phase.dto';
import { UpdateDevelopmentPlanDto } from './update-development-plan.dto';

export class UpdatePlanPhaseForDevelopmentPlanDto extends CreatePlanPhaseForDevelopmentPlanDto {
  @IsOptional()
  @IsUUID()
  id?: string;
}

export class UpdateDevelopmentPlanWithPhasesDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateDevelopmentPlanDto)
  developmentPlan?: UpdateDevelopmentPlanDto;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdatePlanPhaseForDevelopmentPlanDto)
  planPhases?: UpdatePlanPhaseForDevelopmentPlanDto[];
}


