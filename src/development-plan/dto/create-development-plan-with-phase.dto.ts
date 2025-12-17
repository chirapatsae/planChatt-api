import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { OmitType } from '@nestjs/mapped-types';
import { CreateDevelopmentPlanDto } from './create-development-plan.dto';
import { CreatePlanPhaseDto } from 'src/plan-phase/dto/create-plan-phase.dto';

export class CreatePlanPhaseForDevelopmentPlanDto extends OmitType(
  CreatePlanPhaseDto,
  ['developmentPlanId'] as const,
) {}

export class CreateDevelopmentPlanWithPhaseDto {
  @ValidateNested()
  @Type(() => CreateDevelopmentPlanDto)
  developmentPlan: CreateDevelopmentPlanDto;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreatePlanPhaseForDevelopmentPlanDto)
  planPhases: CreatePlanPhaseForDevelopmentPlanDto[];
}


