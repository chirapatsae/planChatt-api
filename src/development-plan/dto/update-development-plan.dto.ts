import { PartialType } from '@nestjs/mapped-types';
import { CreateDevelopmentPlanDto } from './create-development-plan.dto';

export class UpdateDevelopmentPlanDto extends PartialType(CreateDevelopmentPlanDto) {}

