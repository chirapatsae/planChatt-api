import { PartialType } from '@nestjs/mapped-types';
import { CreatePlanPhaseDto } from './create-plan-phase.dto';

export class UpdatePlanPhaseDto extends PartialType(CreatePlanPhaseDto) {}
